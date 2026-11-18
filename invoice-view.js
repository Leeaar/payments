/**
 * Branded invoice page + PDF download.
 *
 *   GET  /i?id=<invoice_id>&e=<exp>&t=<sig>      branded invoice page
 *   GET  /i/pdf?id=<invoice_id>&e=<exp>&t=<sig>  invoice PDF (download)
 *   POST /hooks/invoice-link?invoice_id=<id>     Books workflow webhook: writes
 *                                                the signed link to cf_invoice_link
 *
 * Why a stored link: the Books email template can't compute an HMAC, so the
 * signed URL lives in the invoice custom field cf_invoice_link and the
 * template inserts it as a placeholder. Three things keep that field filled:
 *   1. the Books workflow webhook on invoice create (the normal path),
 *   2. accept-quote.js, which calls ensureLink() before it emails an invoice,
 *   3. a 10-minute sweep over recent and unpaid invoices (the safety net).
 *
 * The webhook needs no key: it never returns the link, it only writes it onto
 * the invoice, so calling it tells an outsider nothing.
 *
 * Signatures are over "inv.<id>.<exp>" with QUOTE_LINK_SECRET, so a quote
 * token can never open an invoice and vice versa.
 */
import crypto from 'crypto';

const BOOKS = 'https://www.zohoapis.com/books/v3';
const LINK_DAYS = 400; // invoices get looked up long after they're paid
const SWEEP_MS = 10 * 60 * 1000;

export default function mountInvoiceView(app, opts) {
  const { getZohoToken, ORG_ID, LINK_SECRET, BASE_URL } = opts;
  const base = String(BASE_URL || '').replace(/\/$/, '');
  if (!LINK_SECRET) console.error('[invoice-view] QUOTE_LINK_SECRET missing — invoice links disabled');

  const BRANDS = {
    pf:  { key: 'pf',  name: 'Pocatello Flooring',    phone: '(208) 233-5667', site: 'https://pocatelloflooring.com', accent: '#1F4E79' },
    fdf: { key: 'fdf', name: 'Factory Direct Floors', phone: '(208) 233-0074', site: 'https://fdfloors.com',           accent: '#E8000A' }
  };
  const brandFor = inv => {
    const show = String(((inv && inv.custom_field_hash) || {}).cf_showroom || '').toLowerCase();
    return show.indexOf('pocatello') !== -1 ? BRANDS.pf : BRANDS.fdf;
  };

  // -- Books ------------------------------------------------------------------
  async function books(method, path, { params = {}, data = null, raw = false } = {}) {
    const token = await getZohoToken();
    const url = new URL(BOOKS + path);
    Object.entries(Object.assign({ organization_id: ORG_ID }, params)).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });
    const resp = await fetch(url.toString(), {
      method: method.toUpperCase(),
      headers: { Authorization: 'Zoho-oauthtoken ' + token, 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined
    });
    if (raw) {
      if (!resp.ok) throw new Error('Books ' + path + ' -> HTTP ' + resp.status);
      return Buffer.from(await resp.arrayBuffer());
    }
    let body = null;
    try { body = await resp.json(); } catch (e) { /* non-JSON */ }
    if (!body || body.code !== 0) {
      throw new Error('Books ' + method.toUpperCase() + ' ' + path + ' -> ' +
        ((body && body.message) || 'HTTP ' + resp.status));
    }
    return body;
  }
  const loadInvoice = async id => (await books('get', '/invoices/' + id)).invoice;

  // -- Signing ----------------------------------------------------------------
  const sign = (id, exp) =>
    crypto.createHmac('sha256', LINK_SECRET).update('inv.' + id + '.' + exp).digest('base64url');

  function linkFor(id) {
    const exp = Math.floor(Date.now() / 1000) + LINK_DAYS * 86400;
    return base + '/i?id=' + encodeURIComponent(id) + '&e=' + exp + '&t=' + sign(id, exp);
  }

  function verify(q) {
    const id = String(q.id || ''), exp = String(q.e || ''), sig = String(q.t || '');
    if (!/^\d{6,}$/.test(id) || !exp || !sig) return 'This invoice link is incomplete.';
    if (Number(exp) * 1000 < Date.now()) return 'This invoice link has expired. Call us and we will send a new one.';
    const a = Buffer.from(sign(id, exp)), b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'This invoice link is not valid.';
    return null;
  }

  const linkOf = inv => String(((inv && inv.custom_field_hash) || {}).cf_invoice_link || '');
  // Refresh when missing or within 30 days of expiry.
  function linkIsFresh(link) {
    const m = link.match(/[?&]e=(\d+)/);
    return !!m && Number(m[1]) * 1000 > Date.now() + 30 * 86400 * 1000;
  }

  /** Make sure the invoice carries a working signed link. Returns the link. */
  async function ensureLink(invoiceOrId) {
    if (!LINK_SECRET) return '';
    const inv = typeof invoiceOrId === 'object' ? invoiceOrId : await loadInvoice(invoiceOrId);
    const cur = linkOf(inv);
    if (cur && linkIsFresh(cur)) return cur;
    const link = linkFor(inv.invoice_id);
    await books('put', '/invoices/' + inv.invoice_id, {
      data: { custom_fields: [{ api_name: 'cf_invoice_link', value: link }] }
    });
    console.log('[invoice-view] link set on ' + inv.invoice_number);
    return link;
  }

  // -- Rendering --------------------------------------------------------------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qty = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const fmtDate = d => {
    if (!d) return '';
    const t = new Date(d + 'T12:00:00');
    return isNaN(t) ? d : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const addr = a => {
    if (!a) return '';
    const lines = [a.attention, a.address || a.street, a.street2,
      [a.city, a.state].filter(Boolean).join(', ') + (a.zip ? ' ' + a.zip : '')]
      .map(s => String(s || '').trim()).filter(Boolean);
    return lines.map(esc).join('<br>');
  };

  function page(brand, title, inner) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} | ${esc(brand.name)}</title>
<style>
:root{--accent:${brand.accent};--ink:#1A1A1A;--muted:#666;--line:#e5e5e5}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--ink);background:#f5f5f5}
.wrap{max-width:820px;margin:0 auto;padding:24px 16px 48px}
.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.brand{font-weight:800;font-size:20px}.brand span{color:var(--accent)}
.phone{color:var(--muted);text-decoration:none;font-size:14px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:24px}
.top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);padding-bottom:18px}
h1{margin:0 0 4px;font-size:24px}.muted{color:var(--muted);font-size:14px}
.due{text-align:right}.due .amt{font-size:30px;font-weight:800}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;text-transform:uppercase}
.pill.paid{background:#e6f4ea;color:#1e7e34}.pill.open{background:#fdecea;color:var(--accent)}
.addr{display:flex;flex-wrap:wrap;gap:32px;padding:18px 0;border-bottom:1px solid var(--line);font-size:14px;line-height:1.5}
.addr b{display:block;font-size:12px;color:var(--muted);text-transform:uppercase;margin-bottom:4px}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:14px}
th{text-align:left;font-size:12px;color:var(--muted);text-transform:uppercase;border-bottom:1px solid var(--line);padding:8px 6px}
td{padding:10px 6px;border-bottom:1px solid #f0f0f0;vertical-align:top}.r{text-align:right;white-space:nowrap}
.desc{color:var(--muted);font-size:13px}
.totals{margin-left:auto;max-width:320px;margin-top:12px;font-size:14px}
.totals div{display:flex;justify-content:space-between;padding:5px 0}
.totals .grand{font-weight:800;font-size:16px;border-top:1px solid var(--line);margin-top:4px;padding-top:9px}
.btns{display:flex;flex-wrap:wrap;gap:12px;margin-top:22px}
.btn{flex:1 1 200px;text-align:center;padding:14px 18px;border-radius:8px;font-weight:700;text-decoration:none;font-size:16px}
.btn.pay{background:var(--accent);color:#fff}.btn.pdf{background:#fff;color:var(--ink);border:2px solid var(--ink)}
.notes{margin-top:22px;font-size:13px;color:var(--muted);white-space:pre-line;line-height:1.5}
.foot{text-align:center;margin-top:20px;font-size:13px;color:var(--muted)}
@media(max-width:560px){.due{text-align:left}.hide-sm{display:none}}
</style></head><body><div class="wrap">
<div class="head"><div class="brand">${esc(brand.name)}<span>.</span></div>
<a class="phone" href="tel:${esc(brand.phone.replace(/\D/g, ''))}">${esc(brand.phone)}</a></div>
${inner}
<div class="foot">Questions about this invoice? Call ${esc(brand.phone)}.</div>
</div></body></html>`;
  }

  function invoiceHtml(inv, q) {
    const brand = brandFor(inv);
    const paid = Number(inv.balance) <= 0;
    const qs = 'id=' + encodeURIComponent(inv.invoice_id) + '&e=' + encodeURIComponent(q.e) + '&t=' + encodeURIComponent(q.t);
    const rows = (inv.line_items || []).map(li => `<tr>
<td>${esc(li.name)}${li.description ? `<div class="desc">${esc(li.description)}</div>` : ''}</td>
<td class="r">${qty(li.quantity)} ${esc(li.unit || '')}</td>
<td class="r hide-sm">${money(li.rate)}</td>
<td class="r">${money(li.item_total)}</td></tr>`).join('');
    const line = (label, val, cls) => `<div${cls ? ` class="${cls}"` : ''}><span>${esc(label)}</span><span>${val}</span></div>`;
    const totals = [
      line('Subtotal', money(inv.sub_total)),
      Number(inv.discount_total) ? line('Discount', '-' + money(inv.discount_total)) : '',
      Number(inv.shipping_charge) ? line('Freight', money(inv.shipping_charge)) : '',
      ...(inv.taxes || []).map(t => line(t.tax_name, money(t.tax_amount))),
      Number(inv.adjustment) ? line(inv.adjustment_description || 'Adjustment', money(inv.adjustment)) : '',
      line('Total', money(inv.total), 'grand'),
      Number(inv.payment_made) ? line('Paid', '-' + money(inv.payment_made)) : '',
      Number(inv.credits_applied) ? line('Credits', '-' + money(inv.credits_applied)) : '',
      line('Balance due', money(inv.balance), 'grand')
    ].join('');
    const payUrl = base + '/pay?invoice_id=' + encodeURIComponent(inv.invoice_id);
    const shipTo = addr(inv.shipping_address), billTo = addr(inv.billing_address);
    const inner = `<div class="card">
<div class="top"><div><h1>Invoice ${esc(inv.invoice_number)}</h1>
<div class="muted">Issued ${esc(fmtDate(inv.date))}${inv.due_date && !paid ? ' &middot; Due ' + esc(fmtDate(inv.due_date)) : ''}</div>
<div style="margin-top:8px"><span class="pill ${paid ? 'paid' : 'open'}">${paid ? 'Paid' : 'Balance due'}</span></div></div>
<div class="due"><div class="muted">${paid ? 'Paid in full' : 'Amount due'}</div><div class="amt">${money(paid ? inv.total : inv.balance)}</div></div></div>
<div class="addr"><div><b>Customer</b>${esc(inv.customer_name)}${billTo ? '<br>' + billTo : ''}</div>
${shipTo ? `<div><b>Ship / install to</b>${shipTo}</div>` : ''}
${inv.salesperson_name ? `<div><b>Your sales rep</b>${esc(inv.salesperson_name)}</div>` : ''}</div>
<table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r hide-sm">Rate</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<div class="totals">${totals}</div>
<div class="btns">
${paid ? '' : `<a class="btn pay" href="${esc(payUrl)}">Pay ${money(inv.balance)} now</a>`}
<a class="btn pdf" href="${esc(base + '/i/pdf?' + qs)}">Download PDF</a></div>
${inv.terms ? `<div class="notes">${esc(inv.terms)}</div>` : ''}
</div>`;
    return page(brand, 'Invoice ' + inv.invoice_number, inner);
  }

  const errorHtml = msg => page(BRANDS.fdf, 'Invoice', `<div class="card"><h1>We couldn't open this invoice</h1><p class="muted">${esc(msg)}</p></div>`);

  // -- Routes -----------------------------------------------------------------
  app.get('/i', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex');
    const bad = verify(req.query);
    if (bad) return res.status(403).send(errorHtml(bad));
    try {
      const inv = await loadInvoice(req.query.id);
      if (inv.status === 'void' || inv.status === 'draft') {
        return res.status(404).send(errorHtml('This invoice is no longer active. Please call us.'));
      }
      console.log('[invoice-view] viewed ' + inv.invoice_number);
      res.send(invoiceHtml(inv, req.query));
    } catch (e) {
      console.error('[invoice-view] load ' + req.query.id + ': ' + e.message);
      res.status(502).send(errorHtml('Something went wrong loading your invoice. Please try again or call us.'));
    }
  });

  const pdfCache = new Map(); // id@last_modified -> { buf, at }
  app.get('/i/pdf', async (req, res) => {
    const bad = verify(req.query);
    if (bad) return res.status(403).send(errorHtml(bad));
    try {
      const inv = await loadInvoice(req.query.id);
      const key = inv.invoice_id + '@' + inv.last_modified_time;
      const now = Date.now();
      for (const [k, v] of pdfCache) if (now - v.at > 10 * 60 * 1000) pdfCache.delete(k);
      let buf = pdfCache.has(key) ? pdfCache.get(key).buf : null;
      if (!buf) {
        buf = await books('get', '/invoices/' + inv.invoice_id, { params: { accept: 'pdf' }, raw: true });
        pdfCache.set(key, { buf, at: now });
      }
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment; filename="' +
        String(inv.invoice_number).replace(/[^\w.-]/g, '') + '.pdf"');
      res.set('Cache-Control', 'private, no-store');
      res.send(buf);
    } catch (e) {
      console.error('[invoice-view] pdf ' + req.query.id + ': ' + e.message);
      res.status(502).send(errorHtml("We couldn't load the PDF. Please try again or call us."));
    }
  });

  // Books workflow webhook. Light rate limit; it only writes, never reveals.
  const hookHits = new Map();
  async function hook(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.ip || '';
    const now = Date.now(), h = hookHits.get(ip) || { n: 0, at: now };
    if (now - h.at > 60000) { h.n = 0; h.at = now; }
    h.n++; hookHits.set(ip, h);
    if (h.n > 60) return res.sendStatus(429);
    const id = String((req.query && req.query.invoice_id) || (req.body && req.body.invoice_id) || '');
    if (!/^\d{6,}$/.test(id)) return res.status(400).json({ ok: false });
    res.json({ ok: true }); // answer Books immediately; the write happens after
    try { await ensureLink(id); } catch (e) { console.error('[invoice-view] hook ' + id + ': ' + e.message); }
  }
  app.post('/hooks/invoice-link', hook);
  app.get('/hooks/invoice-link', hook);

  // Safety net: newest invoices plus every unpaid one.
  async function sweep() {
    if (!LINK_SECRET) return;
    let set = 0;
    try {
      const seen = new Set();
      const lists = [
        await books('get', '/invoices', { params: { sort_column: 'created_time', sort_order: 'D', per_page: 200 } })
      ];
      for (let p = 1; p <= 10; p++) {
        const l = await books('get', '/invoices', { params: { status: 'unpaid', per_page: 200, page: p } });
        lists.push(l);
        if (!(l.page_context && l.page_context.has_more_page)) break;
      }
      for (const l of lists) {
        for (const row of l.invoices || []) {
          if (seen.has(row.invoice_id) || row.status === 'void' || row.status === 'draft') continue;
          seen.add(row.invoice_id);
          const cur = String((row.custom_field_hash || {}).cf_invoice_link || row.cf_invoice_link || '');
          if (cur && linkIsFresh(cur)) continue;
          try { await ensureLink(row.invoice_id); set++; }
          catch (e) { console.error('[invoice-view] sweep ' + row.invoice_number + ': ' + e.message); }
        }
      }
      if (set) console.log('[invoice-view] sweep set ' + set + ' link(s)');
    } catch (e) {
      console.error('[invoice-view] sweep failed: ' + e.message);
    }
  }
  setTimeout(sweep, 30 * 1000);
  setInterval(sweep, SWEEP_MS);

  return { ensureLink, linkFor };
}
