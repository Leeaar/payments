/**
 * accept-quote.js — quote acceptance API for Factory Direct Floors
 *
 * The customer-facing page lives on fdfloors.com (BigCommerce web page with the
 * quote-page.html block). This service is JSON only.
 *
 *   Email link  ->  fdfloors.com/quote/?q=EST-001&e=<exp>&t=<sig>
 *   Page        ->  GET  /api/q/:id          load quote
 *                   GET  /api/q/:id/pdf      the Books estimate PDF, proxied
 *   Accept      ->  POST /api/q/:id/accept   Sales Order + silent Invoice
 *   Then one of:
 *     Pay now   ->  pay.factorydirectfloors.com/pay?invoice_id=N
 *                   -> your existing webhook -> afterPayment() -> PAID email
 *     Pay later ->  POST /api/q/:id/later    unpaid invoice emailed now
 *     Abandons  ->  20-min timer or /q/sweep  unpaid invoice emailed
 *
 * Legacy GET /q/:id 302-redirects to the BigCommerce page, so links already
 * sitting in customer inboxes keep working.
 *
 * !! BOOKS SETUP - READ THIS !!
 *   This module controls every customer email explicitly. If a Books automation
 *   emails invoices on creation or on status change to "sent", turn it off, or
 *   customers get the bill the instant they accept.
 *
 *   Estimates custom fields: cf_payment_link (URL), cf_so_id, cf_invoice_id,
 *                            cf_decline_reason (Text)
 *   Invoices  custom fields: cf_accepted_at (Text, ISO),
 *                            cf_invoice_emailed (Text: "" | "unpaid" | "paid")
 *                            cf_invoice_id already exists as a FORMULA field —
 *                            read-only, auto-computes the invoice id.
 *   Scopes: ZohoBooks.estimates.ALL, ZohoBooks.salesorders.ALL,
 *           ZohoBooks.invoices.ALL, ZohoBooks.customerpayments.READ,
 *           ZohoBooks.settings.READ (salesperson emails),
 *           ZohoCRM.modules.deals.UPDATE, ZohoCRM.modules.notes.CREATE
 *
 * Mount from app.js (ESM, node-fetch — matches your existing file):
 *
 *   import mountAcceptQuote from "./accept-quote.js";
 *
 *   // AFTER app.use(express.json()) so the CORS middleware covers these routes
 *   const quoteFlow = mountAcceptQuote(app, {
 *     getZohoToken:     getZohoAccessToken,
 *     ORG_ID:           ZOHO_ORG_ID,
 *     LINK_SECRET:      process.env.QUOTE_LINK_SECRET,
 *     PAY_BASE:         BASE_URL,
 *     PAY_PATH:         "/pay",
 *     QUOTE_PAGE:       process.env.QUOTE_PAGE,      // FDF
 *     QUOTE_PAGE_PF:    process.env.QUOTE_PAGE_PF,   // Pocatello Flooring
 *     EMAIL_DELAY_MIN:  process.env.EMAIL_DELAY_MIN,
 *     VOID_UNPAID_DAYS: process.env.VOID_UNPAID_DAYS
 *   });
 *
 * In your EXISTING webhook, right after recording the payment:
 *   await quoteFlow.afterPayment(zohoInvoiceId);
 *
 * Cron POST /q/sweep every 5 min with header x-sweep-key:<LINK_SECRET>.
 *
 * --- Materials vs. labor -----------------------------------------------------
 *   Estimate lines do NOT carry item_type / line_item_type / product_type
 *   (verified on QT-001542). Sales order lines do — that's why Sync_Costsheet
 *   can read them — but we classify before any SO exists. So:
 *     item master product_type == "service" -> LABOR    (stays on the SO)
 *     item master product_type == "goods"   -> MATERIAL (invoiced today)
 *     item_id empty (hand-jammed)           -> MATERIAL, logged as HANDJAM
 *     lookup failed                         -> MATERIAL, logged as NO ITEM TYPE
 *   Nothing blocks — a quote always goes through. Item types cached 6h.
 *   header_name is a cross-check only; reps use it inconsistently, so a
 *   disagreement logs HEADER MISMATCH and the item master wins.
 *
 * --- Tax ---------------------------------------------------------------------
 *   Books computes it from the tax_id already on each estimate line. An install
 *   job under the Idaho contractor rule carries no sales tax; a retail
 *   material-only quote carries the 6%. This module never calculates tax.
 */

import crypto from 'crypto';
import fetch from 'node-fetch';

const BOOKS = 'https://www.zohoapis.com/books/v3';
const PDF_TTL = 10 * 60 * 1000; // estimate PDFs are stable between edits

export default function mountAcceptQuote(app, opts) {
  const {
    getZohoToken, ORG_ID, LINK_SECRET, PAY_BASE, PAY_PATH, QUOTE_PAGE,
    EMAIL_DELAY_MIN, VOID_UNPAID_DAYS
  } = opts;

  const payBase = (PAY_BASE || '').replace(/\/$/, '');
  const payPath = PAY_PATH || '/pay';
  const quotePage = QUOTE_PAGE || 'https://fdfloors.com/quote/';
  const quotePagePF = opts.QUOTE_PAGE_PF || process.env.QUOTE_PAGE_PF ||
    'https://pocatelloflooring.com/quote/';
  const delayMs = (Number(EMAIL_DELAY_MIN) || 20) * 60 * 1000;
  const voidDays = VOID_UNPAID_DAYS === undefined ? 14 : Number(VOID_UNPAID_DAYS);

  // Brand comes from the Showroom custom field on the estimate
  // (cf_showroom, customfield_id 5032827000007430060). Same Books org, two
  // brands, two front-end domains.
  const BRANDS = {
    pf:  { key: 'pf',  name: 'Pocatello Flooring',   phone: '(208) 233-5667' },
    fdf: { key: 'fdf', name: 'Factory Direct Floors', phone: '(208) 233-0074' }
  };
  function brandFor(est) {
    const h = (est && est.custom_field_hash) || {};
    const show = String(h.cf_showroom || '').toLowerCase();
    if (show.indexOf('pocatello') !== -1) return BRANDS.pf;
    return BRANDS.fdf;
  }

  // Rep emails resolve from Books at runtime, cached 6h — no hardcoded map to
  // rot when someone joins or leaves. REP_EMAILS is an optional override for
  // anyone Books doesn't return an address for.
  let REP_OVERRIDES = {};
  try { REP_OVERRIDES = JSON.parse(opts.REP_EMAILS || process.env.REP_EMAILS || '{}'); }
  catch (e) { console.error('[accept-quote] REP_EMAILS is not valid JSON'); }

  const REP_TTL = 6 * 60 * 60 * 1000;
  let repCache = { at: 0, byId: {}, byName: {} };

  /**
   * Two sources, in priority order:
   *
   *   /users        — everyone, correct customer-facing addresses. Matched on
   *                   name, which is identical across both lists.
   *   /salespersons — fallback. Most rows have an empty salesperson_email, and
   *                   the populated ones are @fdfdistribution.com, which is the
   *                   distribution entity rather than what a retail customer
   *                   should be replying to. Note it answers under `data`, not
   *                   `salespersons`.
   */
  async function loadReps() {
    if (Date.now() - repCache.at < REP_TTL) return repCache;
    const next = { at: Date.now(), byId: {}, byName: {} };

    // Lower priority first so /users overwrites it.
    try {
      const r = await books('get', '/salespersons');
      const rows = r.data || r.salespersons || [];
      rows.forEach(sp => {
        const email = String(sp.salesperson_email || '').trim();
        const name = String(sp.salesperson_name || '').trim();
        if (email) {
          next.byId[String(sp.salesperson_id)] = email;
          if (name) next.byName[name] = email;
        }
        // Keep the id->name link even without an email, so /users can fill it.
        if (name) next.idToName = Object.assign(next.idToName || {},
          { [String(sp.salesperson_id)]: name });
      });
    } catch (e) {
      console.warn('[accept-quote] /salespersons failed: ' + e.message);
    }

    try {
      const u = await books('get', '/users');
      (u.users || u.data || []).forEach(usr => {
        const email = String(usr.email || '').trim();
        const name = String(usr.name || '').trim();
        if (email && name) next.byName[name] = email;
      });
      // Re-map ids through the name link now that /users has filled the gaps.
      const idToName = next.idToName || {};
      Object.keys(idToName).forEach(id => {
        const em = next.byName[idToName[id]];
        if (em) next.byId[id] = em;
      });
    } catch (e) {
      console.warn('[accept-quote] /users failed: ' + e.message +
        ' — falling back to REP_EMAILS');
    }

    const found = Object.keys(next.byName).length;
    console.log('[accept-quote] rep emails loaded: ' + found);
    repCache = next;
    return repCache;
  }

  async function repEmailFor(est) {
    if (!est) return '';
    const reps = await loadReps();
    const byId = reps.byId[String(est.salesperson_id || '')];
    if (byId) return byId;
    const name = String(est.salesperson_name || '').trim();
    return reps.byName[name] || REP_OVERRIDES[name] || '';
  }

  const accepting = new Set();
  const timers = new Map(); // fast path; the sweep is the durable one
  const pdfCache = new Map(); // estimate_id -> { buf, at }

  const payUrlFor = id => payBase + payPath + '?invoice_id=' + id;

  // -- CORS ------------------------------------------------------------------
  // Your app.js already runs global CORS middleware for fdfloors.com and
  // www.fdfloors.com, including the OPTIONS preflight. Mount this module AFTER
  // that middleware and it's covered. Add pocatelloflooring.com there if PF
  // ever needs a quote page.

  // -- Books ------------------------------------------------------------------
  async function books(method, path, { params = {}, data = null } = {}) {
    const token = await getZohoToken();
    const url = new URL(BOOKS + path);
    const all = Object.assign({ organization_id: ORG_ID }, params);
    Object.keys(all).forEach(k => {
      if (all[k] !== undefined && all[k] !== null && all[k] !== '') {
        url.searchParams.set(k, all[k]);
      }
    });

    const resp = await fetch(url.toString(), {
      method: method.toUpperCase(),
      headers: {
        Authorization: 'Zoho-oauthtoken ' + token,
        'Content-Type': 'application/json'
      },
      body: data ? JSON.stringify(data) : undefined
    });

    let body;
    try { body = await resp.json(); } catch (e) { body = null; }
    if (!body || body.code !== 0) {
      throw new Error('Books ' + method.toUpperCase() + ' ' + path + ' -> ' +
        ((body && body.message) || 'HTTP ' + resp.status));
    }
    return body;
  }

  // -- Zoho CRM ---------------------------------------------------------------
  // Render doesn't email reps. It writes to the Deal and a CRM workflow rule
  // emails the Deal Owner, so notifications follow record ownership instead of
  // a list that goes stale.
  const CRM = 'https://www.zohoapis.com/crm/v2';
  const DEAL_FIELD = opts.DEAL_STATUS_FIELD || process.env.DEAL_STATUS_FIELD || 'Quote_Response';

  async function crm(method, path, data) {
    const token = await getZohoToken();
    const resp = await fetch(CRM + path, {
      method: method.toUpperCase(),
      headers: {
        Authorization: 'Zoho-oauthtoken ' + token,
        'Content-Type': 'application/json'
      },
      body: data ? JSON.stringify(data) : undefined
    });
    let body = null;
    try { body = await resp.json(); } catch (e) { body = null; }
    if (!resp.ok) throw new Error('CRM ' + method + ' ' + path + ' -> HTTP ' + resp.status);
    return body;
  }

  async function noteOnDeal(dealId, title, content) {
    if (!dealId) return;
    try {
      await crm('post', '/Notes', {
        data: [{
          Note_Title: String(title).slice(0, 120),
          Note_Content: String(content).slice(0, 32000),
          Parent_Id: String(dealId),
          se_module: 'Deals'
        }]
      });
    } catch (e) {
      console.error('[accept-quote] CRM note failed for deal ' + dealId + ': ' + e.message);
    }
  }

  /** Setting this field is what a CRM workflow rule listens for. */
  async function setDealStatus(dealId, value) {
    if (!dealId) return;
    try {
      const payload = { data: [{ id: String(dealId) }], trigger: ['workflow'] };
      payload.data[0][DEAL_FIELD] = value;
      await crm('put', '/Deals', payload);
    } catch (e) {
      console.error('[accept-quote] CRM deal update failed ' + dealId + ': ' + e.message);
    }
  }

  const cf = (rec, name) => {
    const l = (rec && rec.custom_fields) || [];
    for (let i = 0; i < l.length; i++) if (l[i].api_name === name) return l[i].value;
    return null;
  };
  /**
   * Verified against this org: Books accepts api_name in custom_fields and
   * validates it against the schema, returning 400 / code 120138 naming the
   * offending field if it's wrong. So no customfield_id lookup is needed — but
   * never swallow the error, it's the most useful one in the system.
   */
  function setCf(id, kind, pairs) {
    const fields = Object.keys(pairs).map(k => ({ api_name: k, value: String(pairs[k]) }));
    return books('put', '/' + kind + '/' + id, { data: { custom_fields: fields } });
  }

  const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const money = n => '$' + Number(n || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // -- Signed link ------------------------------------------------------------
  // base64url, to match Deluge. Deluge's zoho.encryption.hmacsha256 takes the
  // SECRET first and the message second, and returns standard base64; the
  // Deluge side swaps +/ for -_ and strips padding so both ends agree. Hex
  // would need an undocumented third argument, and raw base64 isn't URL-safe.
  const sign = (num, exp) =>
    crypto.createHmac('sha256', LINK_SECRET).update(num + '.' + exp).digest('base64url');

  function verify(req, id) {
    const exp = String(req.query.e || ''), sig = String(req.query.t || '');
    if (!exp || !sig) return 'Missing link signature.';
    if (Number(exp) * 1000 < Date.now()) return 'This quote link has expired.';
    const a = Buffer.from(sign(id, exp)), b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'Invalid link.';
    return null;
  }

  /**
   * Accepts a Books estimate_id (fast path, what the Deluge link carries) or a
   * quote number. The number fallback tries estimate_number then
   * reference_number, because the CRM Finance integration doesn't always put
   * the QT- number in the same field on the Books side.
   */
  async function loadEstimate(key) {
    const k = String(key || '').trim();
    if (/^\d{6,}$/.test(k)) {
      try { return (await books('get', '/estimates/' + k)).estimate; } catch (e) { /* fall through */ }
    }
    let list = await books('get', '/estimates', { params: { estimate_number: k } });
    if (!list.estimates || !list.estimates.length) {
      list = await books('get', '/estimates', { params: { reference_number: k } });
    }
    if (!list.estimates || !list.estimates.length) return null;
    return (await books('get', '/estimates/' + list.estimates[0].estimate_id)).estimate;
  }

  // -- Classification ---------------------------------------------------------
  //
  // Estimate line items do NOT carry item_type / line_item_type / product_type
  // (verified against QT-001542 — all three absent). Sales order lines do, which
  // is why Sync_Costsheet can read them, but we classify before any SO exists.
  //
  // Source of truth is product_type on the item master. header_name
  // ("Product" / "Labor") is a fallback and a cross-check only — it reflects how
  // the rep arranged the quote, so it must not outrank the item itself. A labor
  // item dragged under the Product header would otherwise get billed on accept.
  const ITEM_TTL = 6 * 60 * 60 * 1000;
  const itemCache = new Map(); // item_id -> { productType, at }

  async function itemProductType(itemId) {
    const now = Date.now();
    const hit = itemCache.get(itemId);
    if (hit && now - hit.at < ITEM_TTL) return hit.productType;
    try {
      const r = await books('get', '/items/' + itemId);
      const pt = String((r.item && r.item.product_type) || '').toLowerCase();
      itemCache.set(itemId, { productType: pt, at: now });
      return pt;
    } catch (e) {
      console.error('[accept-quote] item lookup failed ' + itemId + ': ' + e.message);
      return '';
    }
  }

  function classify(line, types) {
    const id = String(line.item_id == null ? '' : line.item_id).trim();
    const header = String(line.header_name || '').trim().toLowerCase();

    // Hand-jammed line: no item_id, so no item master to consult. Books stamps
    // these as "service", but in practice they're special-order material a rep
    // typed in, so they bill today. Same assumption as Sync_Costsheet.
    if (!id) return 'handjam-material';

    const pt = types[id];
    if (pt === 'service' || pt === 'digital_service') {
      if (header === 'product') {
        console.warn('[accept-quote] HEADER MISMATCH: "' + line.name +
          '" is a service item under the Product header. Treating as labor.');
      }
      return 'labor';
    }
    if (pt === 'goods') {
      if (header === 'labor') {
        console.warn('[accept-quote] HEADER MISMATCH: "' + line.name +
          '" is a goods item under the Labor header. Treating as material.');
      }
      return 'material';
    }

    // Item lookup failed — transient API problem, not a data problem. Headers
    // are used inconsistently between reps, so they only help when present.
    if (header === 'labor') {
      console.error('[accept-quote] NO ITEM TYPE for "' + line.name +
        '" — falling back to Labor header.');
      return 'labor';
    }
    console.error('[accept-quote] NO ITEM TYPE for "' + line.name +
      '" and no usable header — billing as material. Check item ' + id + '.');
    return 'material';
  }

  /**
   * An entity-level discount applies to the WHOLE quote, but the invoice only
   * covers the material lines. A flat dollar discount therefore has to be
   * pro-rated by material share or the partial invoice eats the whole thing.
   * A percentage scales itself, so it passes through untouched.
   * Returns the value to hand Books as the invoice's `discount`.
   */
  function invoiceDiscount(est, matNet, allNet) {
    if (String(est.discount_type || '') !== 'entity_level') return est.discount;
    const d = String(est.discount == null ? '' : est.discount).trim();
    if (!d || d === '0') return d;
    if (d.indexOf('%') !== -1) return d;
    if (allNet <= 0) return 0;
    return r2(Number(d) * (matNet / allNet));
  }

  async function splitLines(est) {
    const lines = est.line_items || [];
    const ids = Array.from(new Set(
      lines.map(l => String(l.item_id == null ? '' : l.item_id).trim()).filter(Boolean)
    ));
    const types = {};
    await Promise.all(ids.map(async id => { types[id] = await itemProductType(id); }));

    const material = [], deferred = [], handjam = [];
    lines.forEach(l => {
      const k = classify(l, types);
      if (k === 'labor') { deferred.push(l); return; }
      material.push(l);
      if (k === 'handjam-material') handjam.push(l);
    });
    if (handjam.length) {
      console.log('[accept-quote] HANDJAM on ' + est.estimate_number + ': ' +
        handjam.map(l => (l.name || l.description) + ' $' + l.item_total).join(' | ') +
        ' — billed as material');
    }

    const net = l => Number(l.item_total || 0);
    const allNet = r2((est.line_items || []).reduce((a, l) => a + net(l), 0));
    const matNet = r2(material.reduce((a, l) => a + net(l), 0));

    // Flat-equivalent value of an entity-level discount, then the material share.
    let docDisc = 0;
    if (String(est.discount_type || '') === 'entity_level') {
      const d = String(est.discount == null ? '' : est.discount).trim();
      if (d && d !== '0') {
        docDisc = d.indexOf('%') !== -1 ? r2(allNet * parseFloat(d) / 100) : r2(Number(d));
      }
    }
    const matDisc = allNet > 0 ? r2(docDisc * (matNet / allNet)) : 0;
    const beforeTax = est.is_discount_before_tax !== false;

    // The org runs tax_rounding = entity_level, so accumulate unrounded and
    // round once at the end. Rounding per line drifts a cent or two.
    const tax = r2(material.reduce((a, l) => {
      const share = matNet > 0 ? net(l) / matNet : 0;
      const taxable = beforeTax ? net(l) - matDisc * share : net(l);
      return a + taxable * (Number(l.tax_percentage || 0) / 100);
    }, 0));

    // Adjustments (trip fees etc.) bill today with materials. Books applies
    // them after tax, so add at the end rather than into the taxable base.
    const adjustment = r2(Number(est.adjustment || 0));

    // Display estimate. Books remains the authority on the real invoice total.
    const preview = r2(matNet - matDisc + tax + adjustment);
    return {
      material, deferred, handjam, matNet, allNet,
      discount: matDisc, tax, adjustment,
      adjustmentLabel: est.adjustment_description || 'Adjustment',
      preview
    };
  }

  const wireLine = l => ({
    name: l.name || l.description || '',
    qty: Number(l.quantity || 0),
    unit: l.unit || '',
    total: Number(l.item_total || 0)
  });

  // -- Email control ----------------------------------------------------------
  async function sendInvoiceEmail(invoiceId, kind, est) {
    const inv = (await books('get', '/invoices/' + invoiceId)).invoice;
    if (cf(inv, 'cf_invoice_emailed')) return { skipped: true, reason: 'already emailed' };

    // Estimate carries the brand; fall back to FDF if we weren't handed one.
    let quote = est;
    if (!quote && inv.reference_number) {
      try { quote = await loadEstimate(inv.reference_number); } catch (e) { quote = null; }
    }
    const brand = brandFor(quote);
    const repEmail = await repEmailFor(quote);

    const paid = kind === 'paid';

    // UNPAID: send nothing custom. Books' own Estimates/Invoices template is
    // already branded per showroom, shows the amount and due date, and carries
    // a working PAY NOW button into /pay?invoice_id=. Passing subject/body here
    // would override all of that with plain text.
    //
    // PAID: the standard template still shows PAY NOW on a settled invoice,
    // which is confusing, so this one case gets custom copy.
    const mail = {};
    if (paid) {
      mail.subject = 'Payment received - ' + brand.name + ' invoice ' + inv.invoice_number;
      mail.body = [
        'Thank you - we received your payment of ' + money(inv.total) + '.',
        '',
        'Your materials are on order. We will call you to schedule installation as soon as they arrive.',
        '',
        'Your paid invoice is attached for your records.',
        '',
        brand.name + '  |  ' + brand.phone
      ].join('\n');
    }
    if (repEmail) {
      // Reply-to the rep so a customer reply reaches whoever built the quote.
      mail.reply_to = repEmail;
      mail.reply_to_mail_ids = [repEmail];
    }
    await books('post', '/invoices/' + invoiceId + '/email', { data: mail });
    await setCf(invoiceId, 'invoices', { cf_invoice_emailed: paid ? 'paid' : 'unpaid' }).catch(e => console.error('[accept-quote] setCf failed: ' + e.message));

    if (paid) {
      // Best effort. The paid invoice above already reads as a confirmation.
      try {
        const pay = await books('get', '/customerpayments', { params: { invoice_id: invoiceId } });
        const pid = pay.customerpayments && pay.customerpayments[0]
          ? pay.customerpayments[0].payment_id : null;
        if (pid) await books('post', '/customerpayments/' + pid + '/email', { data: {} });
      } catch (e) {
        console.warn('[accept-quote] receipt email skipped: ' + e.message);
      }
    }
    if (paid && quote) {
      noteOnDeal(quote.zcrm_potential_id, 'PAYMENT RECEIVED - ' + quote.estimate_number,
        'Materials paid in full: ' + money(inv.total) + ' on invoice ' + inv.invoice_number +
        '.\nMaterials can be ordered.');
      setDealStatus(quote.zcrm_potential_id, 'Paid');
    }
    console.log('[accept-quote] emailed ' + kind + ' invoice ' + inv.invoice_number);
    return { sent: true };
  }

  /** Call from your existing webhook after the payment is recorded. */
  async function afterPayment(invoiceId) {
    const t = timers.get(String(invoiceId));
    if (t) { clearTimeout(t); timers.delete(String(invoiceId)); }
    try {
      return await sendInvoiceEmail(invoiceId, 'paid');
    } catch (e) {
      console.error('[accept-quote] afterPayment ' + invoiceId, e.message);
      return { error: e.message };
    }
  }

  function scheduleFallback(invoiceId) {
    const key = String(invoiceId);
    if (timers.has(key)) return;
    const t = setTimeout(async () => {
      timers.delete(key);
      try {
        const inv = (await books('get', '/invoices/' + invoiceId)).invoice;
        if (cf(inv, 'cf_invoice_emailed')) return;
        await sendInvoiceEmail(invoiceId, Number(inv.balance) === 0 ? 'paid' : 'unpaid');
      } catch (e) {
        console.error('[accept-quote] fallback ' + invoiceId, e.message);
      }
    }, delayMs);
    timers.set(key, t);
  }

  // -- Accept -----------------------------------------------------------------
  async function acceptQuote(est) {
    const key = String(est.estimate_id);
    if (accepting.has(key)) throw new Error('Already processing this quote.');
    accepting.add(key);
    try {
      const existing = cf(est, 'cf_invoice_id');
      if (existing) {
        return { invoice: (await books('get', '/invoices/' + existing)).invoice, reused: true };
      }

      const split = await splitLines(est);
      const material = split.material, deferred = split.deferred;
      if (!material.length) throw new Error('No material lines to invoice.');

      // 1. Sales order - full scope, materials and labor.
      const so = (await books('post', '/salesorders', {
        data: {
          customer_id: est.customer_id,
          reference_number: est.estimate_number,
          date: new Date().toISOString().slice(0, 10),
          notes: est.notes, terms: est.terms,
          salesperson_name: est.salesperson_name,
          shipping_charge: est.shipping_charge,
          discount: est.discount, discount_type: est.discount_type,
          is_discount_before_tax: est.is_discount_before_tax,
          line_items: (est.line_items || []).map(l => ({
            item_id: l.item_id, name: l.name, description: l.description,
            rate: l.rate, quantity: l.quantity, unit: l.unit,
            tax_id: l.tax_id, item_custom_fields: l.item_custom_fields
          }))
        }
      })).salesorder;
      await books('post', '/salesorders/' + so.salesorder_id + '/approve').catch(() => {});

      // 2. Invoice - material lines only, linked to the SO so Books tracks
      //    quantity_invoiced and the labor stays open on the order.
      const soLines = (await books('get', '/salesorders/' + so.salesorder_id))
        .salesorder.line_items || [];
      const wanted = new Set(material.map(l => String(l.item_id)));
      const invLines = soLines.filter(l => wanted.has(String(l.item_id))).map(l => ({
        salesorder_item_id: l.line_item_id, item_id: l.item_id,
        name: l.name, description: l.description, rate: l.rate,
        quantity: l.quantity, unit: l.unit, tax_id: l.tax_id
      }));

      const invoice = (await books('post', '/invoices', {
        data: {
          customer_id: est.customer_id,
          reference_number: est.estimate_number,
          date: new Date().toISOString().slice(0, 10),
          // No document-level salesorder_id — not a documented create param.
          // Per-line salesorder_item_id is what links back to the SO and drives
          // quantity_invoiced, and that IS documented.
          shipping_charge: est.shipping_charge,
          discount: invoiceDiscount(est, split.matNet, split.allNet),
          discount_type: est.discount_type,
          is_discount_before_tax: est.is_discount_before_tax,
          // Trip fees and the like ride with materials. Books applies
          // adjustment after tax, so it hits the total rather than the base.
          adjustment: Number(est.adjustment || 0),
          adjustment_description: est.adjustment_description || '',
          notes: 'Materials for quote ' + est.estimate_number +
            (deferred.length ? '. Installation invoiced separately on completion.' : '.'),
          line_items: invLines
        }
      })).invoice;

      // Mark sent so it can accept a payment. Emailing stays under our control.
      await books('post', '/invoices/' + invoice.invoice_id + '/status/sent').catch(() => {});
      // cf_invoice_id on Invoices is a FORMULA field — read-only, and it already
      // computes to the invoice id, which is what your webhook keys off. Don't
      // write it; writing a formula field errors or is silently dropped.
      await setCf(invoice.invoice_id, 'invoices', {
        cf_accepted_at: new Date().toISOString(),
        cf_invoice_emailed: ''
      }).catch(e => console.error('[accept-quote] setCf failed: ' + e.message));

      await setCf(est.estimate_id, 'estimates', {
        cf_so_id: so.salesorder_id, cf_invoice_id: invoice.invoice_id
      }).catch(e => console.error('[accept-quote] setCf failed: ' + e.message));
      await books('post', '/estimates/' + est.estimate_id + '/status/accepted').catch(() => {});

      scheduleFallback(invoice.invoice_id);

      noteOnDeal(est.zcrm_potential_id, 'QUOTE ACCEPTED - ' + est.estimate_number,
        'Customer accepted online.\n' +
        'Sales Order: ' + so.salesorder_number + '\n' +
        'Invoice: ' + invoice.invoice_number + ' for ' + money(invoice.total) + ' (materials)\n' +
        (deferred.length
          ? 'Installation stays open on the sales order, invoiced on completion.\n'
          : '') +
        'Payment not yet received.');
      setDealStatus(est.zcrm_potential_id, 'Accepted');

      console.log('[accept-quote] accepted ' + est.estimate_number +
        ' SO=' + so.salesorder_number + ' INV=' + invoice.invoice_number);
      return { invoice, salesorder: so, reused: false };
    } finally {
      accepting.delete(key);
    }
  }

  // === JSON API ==============================================================

  app.get('/api/q/:id', async (req, res) => {
    const id = req.params.id;
    try {
      const bad = verify(req, id);
      if (bad) return res.status(403).json({ error: bad });
      const est = await loadEstimate(id);
      if (!est) return res.status(404).json({ error: "We couldn't find that quote." });

      if (String(est.status || '').toLowerCase() === 'declined') {
        return res.json({ state: 'declined', quoteNumber: est.estimate_number });
      }
      const invId = cf(est, 'cf_invoice_id');
      if (invId) {
        const inv = (await books('get', '/invoices/' + invId)).invoice;
        return res.json({
          state: Number(inv.balance) === 0 ? 'paid' : 'accepted',
          quoteNumber: est.estimate_number,
          customerName: est.customer_name,
          salesperson: est.salesperson_name || '',
          invoiceNumber: inv.invoice_number,
          total: Number(inv.total),
          balance: Number(inv.balance),
          hasInstall: Number(inv.total) < Number(est.total),
          payUrl: payUrlFor(inv.invoice_id)
        });
      }

      const s = await splitLines(est);

      // First view only — a customer refreshing shouldn't spam the Deal.
      if (!cf(est, 'cf_first_viewed')) {
        setCf(est.estimate_id, 'estimates',
          { cf_first_viewed: new Date().toISOString() }).catch(e => console.error('[accept-quote] setCf failed: ' + e.message));
        noteOnDeal(est.zcrm_potential_id, 'Quote opened by customer',
          'Quote ' + est.estimate_number + ' was opened online on ' +
          new Date().toLocaleString('en-US', { timeZone: 'America/Boise' }) +
          '. Materials due on acceptance: ' + money(s.preview) + '.');
        setDealStatus(est.zcrm_potential_id, 'Viewed');
      }

      res.json({
        state: 'open',
        quoteNumber: est.estimate_number,
        customerName: est.customer_name,
        salesperson: est.salesperson_name || '',
        expiresOn: est.expiry_date || '',
        materials: s.material.map(wireLine),
        deferred: s.deferred.map(wireLine),
        dueToday: s.preview,
        brand: brandFor(est).key,
        terms: est.terms || '',
        materialsSubtotal: s.matNet,
        discountToday: s.discount,
        taxToday: s.tax,
        adjustmentToday: s.adjustment,
        adjustmentLabel: s.adjustmentLabel,
        deferredTotal: r2(s.deferred.reduce(function (a, l) {
          return a + Number(l.item_total || 0); }, 0)),
        quoteTotal: Number(est.total || 0),
        pdfUrl: '/api/q/' + encodeURIComponent(id) + '/pdf'
      });
    } catch (e) {
      console.error('[accept-quote] GET ' + id, e.message);
      res.status(500).json({ error: 'Something went wrong loading this quote.' });
    }
  });

  app.post('/api/q/:id/accept', async (req, res) => {
    const id = req.params.id;
    const bad = verify(req, id);
    if (bad) return res.status(403).json({ error: bad });
    try {
      const est = await loadEstimate(id);
      if (!est) return res.status(404).json({ error: 'Quote not found.' });
      const { invoice } = await acceptQuote(est);
      res.json({
        ok: true,
        state: Number(invoice.balance) === 0 ? 'paid' : 'accepted',
        invoiceNumber: invoice.invoice_number,
        total: Number(invoice.total),
        balance: Number(invoice.balance),
        hasInstall: Number(invoice.total) < Number(est.total),
        payUrl: payUrlFor(invoice.invoice_id)
      });
    } catch (e) {
      console.error('[accept-quote] ACCEPT ' + id, e.message);
      res.status(500).json({ error: "We couldn't finish that." });
    }
  });

  app.post('/api/q/:id/later', async (req, res) => {
    const id = req.params.id;
    const bad = verify(req, id);
    if (bad) return res.status(403).json({ error: bad });
    try {
      const est = await loadEstimate(id);
      const invId = est && cf(est, 'cf_invoice_id');
      if (!invId) return res.status(404).json({ error: 'Nothing to send.' });
      const t = timers.get(String(invId));
      if (t) { clearTimeout(t); timers.delete(String(invId)); }
      await sendInvoiceEmail(invId, 'unpaid', est);
      res.json({ ok: true });
    } catch (e) {
      console.error('[accept-quote] LATER ' + id, e.message);
      res.json({ ok: true, deferred: true }); // sweep will catch it
    }
  });

  // -- Decline: a lost quote is pipeline data, so capture the reason ---------
  app.post('/api/q/:id/decline', async (req, res) => {
    const id = req.params.id;
    const bad = verify(req, id);
    if (bad) return res.status(403).json({ error: bad });
    try {
      const est = await loadEstimate(id);
      if (!est) return res.status(404).json({ error: 'Quote not found.' });
      if (cf(est, 'cf_invoice_id')) {
        return res.status(409).json({ error: 'This quote has already been accepted.' });
      }
      const raw = (req.body && req.body.reason) || req.query.reason || '';
      const reason = String(raw).slice(0, 300);

      if (reason) {
        await setCf(est.estimate_id, 'estimates', { cf_decline_reason: reason }).catch(e => console.error('[accept-quote] setCf failed: ' + e.message));
      }
      await books('post', '/estimates/' + est.estimate_id + '/status/declined');

      noteOnDeal(est.zcrm_potential_id, 'QUOTE DECLINED - ' + est.estimate_number,
        'Customer declined online.\nReason given: ' + (reason || 'none given') +
        '\nQuote total: ' + money(est.total));
      setDealStatus(est.zcrm_potential_id, 'Declined');

      console.log('[accept-quote] DECLINED ' + est.estimate_number +
        ' (' + (est.salesperson_name || 'no rep') + ') reason=' + (reason || 'none given'));
      res.json({ ok: true });
    } catch (e) {
      console.error('[accept-quote] DECLINE ' + id, e.message);
      res.status(500).json({ error: "We couldn't record that." });
    }
  });

  // -- PDF proxy: Books needs an OAuth token, so the browser can't fetch it ---
  app.get('/api/q/:id/pdf', async (req, res) => {
    const id = req.params.id;
    try {
      const bad = verify(req, id);
      if (bad) return res.status(403).json({ error: bad });
      const est = await loadEstimate(id);
      if (!est) return res.status(404).json({ error: 'Quote not found.' });

      const key = String(est.estimate_id);
      const now = Date.now();
      for (const [k, v] of pdfCache) if (now - v.at > PDF_TTL) pdfCache.delete(k);

      let buf = pdfCache.has(key) ? pdfCache.get(key).buf : null;
      if (!buf) {
        const token = await getZohoToken();
        const pdfUrl = new URL(BOOKS + '/estimates/' + key);
        pdfUrl.searchParams.set('organization_id', ORG_ID);
        pdfUrl.searchParams.set('accept', 'pdf');
        const r = await fetch(pdfUrl.toString(), {
          headers: { Authorization: 'Zoho-oauthtoken ' + token }
        });
        if (!r.ok) throw new Error('Books PDF returned ' + r.status);
        buf = Buffer.from(await r.arrayBuffer());
        pdfCache.set(key, { buf, at: now });
      }

      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition',
        'inline; filename="Quote-' + String(id).replace(/[^\w.-]/g, '') + '.pdf"');
      res.set('Cache-Control', 'private, max-age=300');
      res.send(buf);
    } catch (e) {
      console.error('[accept-quote] PDF ' + id, e.message);
      res.status(502).json({ error: "We couldn't load the quote document." });
    }
  });

  // Legacy links already in inboxes -> the site page, on the right brand's
  // domain. Deluge writes brand-correct links directly, so this only catches
  // old-format URLs — but sending a Pocatello customer to fdfloors.com would
  // still be wrong, so resolve the showroom before redirecting.
  app.get('/q/:id', async (req, res) => {
    const id = req.params.id;
    const qs = new URLSearchParams({
      q: id,
      e: String(req.query.e || ''),
      t: String(req.query.t || '')
    }).toString();

    let page = quotePage;
    // Only hit the API for a signed link — otherwise this is a free lookup for
    // anyone walking estimate ids.
    if (!verify(req, id)) {
      try {
        const est = await loadEstimate(id);
        if (est && brandFor(est).key === 'pf') page = quotePagePF;
      } catch (e) {
        console.warn('[accept-quote] brand lookup failed on legacy redirect: ' + e.message);
      }
    }
    res.redirect(302, page + (page.indexOf('?') === -1 ? '?' : '&') + qs);
  });

  // -- Durable sweep ----------------------------------------------------------
  app.post('/q/sweep', async (req, res) => {
    if (req.headers['x-sweep-key'] !== LINK_SECRET) return res.sendStatus(403);
    const out = { emailed: 0, voided: 0, errors: [] };
    try {
      const list = await books('get', '/invoices', { params: { status: 'unpaid', per_page: 200 } });
      const now = Date.now();
      for (const row of list.invoices || []) {
        try {
          const inv = (await books('get', '/invoices/' + row.invoice_id)).invoice;
          const acceptedAt = cf(inv, 'cf_accepted_at');
          if (!acceptedAt) continue; // not one of ours
          const age = now - Date.parse(acceptedAt);

          if (!cf(inv, 'cf_invoice_emailed') && age >= delayMs) {
            await sendInvoiceEmail(inv.invoice_id, Number(inv.balance) === 0 ? 'paid' : 'unpaid');
            out.emailed++;
          }
          if (voidDays > 0 && Number(inv.balance) > 0 && age >= voidDays * 86400000) {
            await books('post', '/invoices/' + inv.invoice_id + '/status/void');
            const so = inv.salesorder_id ||
              (inv.salesorders && inv.salesorders[0] && inv.salesorders[0].salesorder_id);
            if (so) await books('post', '/salesorders/' + so + '/status/void').catch(() => {});
            console.log('[accept-quote] voided stale ' + inv.invoice_number);
            out.voided++;
          }
        } catch (e) { out.errors.push(row.invoice_number + ': ' + e.message); }
      }
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return { afterPayment, acceptQuote, sendInvoiceEmail, splitLines, repEmailFor, books };
}
