// app.js

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";
import mountAcceptQuote from "./accept-quote.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// =============================
// ENV VARS
// =============================
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ORG_ID = process.env.ZOHO_ORG_ID || "852929343";

const ANET_LOGIN = process.env.ANET_LOGIN;
const ANET_KEY = process.env.ANET_KEY;
const ANET_WEBHOOK_KEY = process.env.ANET_WEBHOOK_KEY; // Authorize.Net Signature Key (hex)
const BASE_URL = process.env.BASE_URL || "https://payments-nleq.onrender.com";

// Gate for the debug + raw-invoice routes. Without this they are wide open.
const DEBUG_KEY = process.env.DEBUG_KEY;

// Set RATE_LIMITS=off if throttling ever gets in the way. /quote is public and
// creates CRM records, so leaving it on is the safer default.
const RATE_LIMITS_ON = process.env.RATE_LIMITS !== "off";

// Temporary escape hatch. If signature verification starts rejecting real
// Authorize.Net webhooks, set this to "true" to keep payments recording while
// you sort out ANET_WEBHOOK_KEY — then REMOVE IT. Unsigned webhooks let anyone
// mark any invoice paid.
// Signature enforcement is OPT-IN until the key is proven working. Seven days
// of production logs showed 100% mismatch, so defaulting this on would have
// stopped every payment from recording. Run check-anet-key.js, fix the key,
// confirm "✅ Signature verified" in the logs, THEN set ANET_ENFORCE_SIG=true.
const ANET_ENFORCE_SIG = process.env.ANET_ENFORCE_SIG === "true";

// Set to "true" to restore the old full headers + raw body webhook logging.
// Off by default because raw bodies contain customer payment detail, but it's
// exactly what let us diagnose the signature mismatch.
const WEBHOOK_VERBOSE = process.env.WEBHOOK_VERBOSE === "true";

// Every webhook in seven days of logs came from this IP. Cloudflare fronts
// Render, so cf-connecting-ip is set by Cloudflare and can't be forged by the
// sender. Used as a fallback check while the signature key is unresolved:
// accept if the signature verifies OR the source IP is Authorize.Net.
// OFF by default. Seven days of logs is thin evidence that Authorize.Net only
// ever sends from one IP — if they rotate, this would silently stop payments
// recording. Turn it on deliberately, not as a side effect of a feature deploy.
const ANET_IP_GUARD = process.env.ANET_IP_GUARD === "true";

const ANET_IPS = (process.env.ANET_WEBHOOK_IPS || "198.241.206.38")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

function clientIp(req) {
  return String(
    req.headers["cf-connecting-ip"] ||
      req.headers["true-client-ip"] ||
      String(req.headers["x-forwarded-for"] || "").split(",")[0] ||
      req.ip ||
      ""
  ).trim();
}

// =============================
// ZOHO TOKEN CACHE
// =============================
let zohoTokenCache = {
  access_token: null,
  expires_at: 0,
};

async function getZohoAccessToken() {
  const now = Date.now();
  if (zohoTokenCache.access_token && zohoTokenCache.expires_at > now + 5000) {
    return zohoTokenCache.access_token;
  }

  const body = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const resp = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    body,
  });

  const data = await resp.json();
  if (!data.access_token) {
    console.error("❌ Zoho token error:", data);
    throw new Error(
      data.error_description ||
        data.error ||
        "Could not get Zoho access token"
    );
  }

  zohoTokenCache.access_token = data.access_token;
  zohoTokenCache.expires_at =
    Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600000);

  console.log("✅ Zoho token refreshed");
  return data.access_token;
}

// =============================
// SECURITY HELPERS
// =============================

// Routes behind this return 404 (not 403) so a scanner learns nothing.
function requireDebugKey(req, res, next) {
  if (DEBUG_KEY && req.headers["x-debug-key"] === DEBUG_KEY) return next();
  return res.sendStatus(404);
}

// Dead simple in-memory throttle. No dependency, resets on restart, good
// enough to stop someone hammering the public quote endpoint.
const rateBuckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    if (!RATE_LIMITS_ON) return next();
    const ip = String(req.headers["x-forwarded-for"] || req.ip || "")
      .split(",")[0]
      .trim();
    const now = Date.now();

    if (rateBuckets.size > 5000) {
      for (const [k, v] of rateBuckets) {
        if (now - v.start > windowMs) rateBuckets.delete(k);
      }
    }

    const rec = rateBuckets.get(ip);
    if (!rec || now - rec.start > windowMs) {
      rateBuckets.set(ip, { start: now, n: 1 });
      return next();
    }
    if (rec.n >= max) {
      console.log("⛔ Rate limited:", ip, req.path);
      return res.status(429).json({
        success: false,
        message: "Too many requests. Please try again in a few minutes.",
      });
    }
    rec.n++;
    return next();
  };
}

// =============================
// ZOHO HELPERS
// =============================
async function getZohoInvoice(invoiceId) {
  const accessToken = await getZohoAccessToken();
  const url = `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORG_ID}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  const data = await resp.json();
  if (data.code !== 0) {
    console.error("❌ Zoho invoice error:", data);
    throw new Error(data.message || "Could not fetch invoice from Zoho");
  }

  return data.invoice;
}

async function createZohoPaymentForInvoiceAmount(invoice, amount, opts = {}) {
  const accessToken = await getZohoAccessToken();

  const payload = {
    customer_id: invoice.customer_id,
    amount: amount,
    date: new Date().toISOString().slice(0, 10),
    payment_mode: "Authorize.Net",
    reference_number: opts.reference_number || "",
    description: opts.description || "",
    invoices: [
      {
        invoice_id: invoice.invoice_id,
        amount_applied: amount,
      },
    ],
  };

  const resp = await fetch(
    `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${ZOHO_ORG_ID}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await resp.json();
  if (data.code !== 0) {
    console.error("❌ Zoho payment create failed:", data);
    throw new Error(data.message || "Zoho did not accept payment");
  }

  console.log("✅ Payment recorded in Zoho:", data);
  return data;
}

/**
 * Authorize.Net doesn't always put the Zoho invoice id in the same field.
 *
 *   Started by /pay          -> invoiceNumber IS the Zoho invoice id
 *   Started by Zoho Books    -> invoiceNumber is the human number (INV-002372)
 *                               and merchantReferenceId holds the Zoho id
 *
 * The Books-originated ones matter because **Books records those payments
 * itself**. The webhook arriving afterwards is a duplicate, not a gap. The old
 * code failed to resolve them and errored, which looked like a lost payment but
 * was actually the thing preventing a double-post.
 */
async function resolveZohoInvoiceId(payload) {
  const raw = String(payload.invoiceNumber || "").trim();
  const ref = String(payload.merchantReferenceId || "").trim();

  if (/^\d{6,}$/.test(raw)) return raw;
  if (/^\d{6,}$/.test(ref)) {
    console.log("ℹ️ Zoho-originated payment. Id from merchantReferenceId:", ref);
    return ref;
  }
  if (raw) {
    try {
      const accessToken = await getZohoAccessToken();
      const url =
        `https://www.zohoapis.com/books/v3/invoices?organization_id=${ZOHO_ORG_ID}` +
        `&invoice_number=${encodeURIComponent(raw)}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      });
      const data = await resp.json();
      const hit = data.invoices && data.invoices[0];
      if (hit) {
        console.log("ℹ️ Resolved", raw, "->", hit.invoice_id);
        return hit.invoice_id;
      }
      console.log("❌ No Zoho invoice matches number", raw);
    } catch (e) {
      console.log("❌ Invoice number lookup failed:", e.message);
    }
  }
  return "";
}

/**
 * Has this Authorize.Net transaction already been posted against the invoice?
 *
 * Covers every duplicate source at once: Books recording its own gateway
 * payments, Authorize.Net retrying a webhook, and us reprocessing. Keyed on the
 * transaction id, which we write into reference_number when we create a payment.
 */
async function paymentAlreadyRecorded(invoiceId, anetTxnId) {
  if (!anetTxnId) return false;
  try {
    const accessToken = await getZohoAccessToken();
    const url = `https://www.zohoapis.com/books/v3/invoices/${invoiceId}/payments?organization_id=${ZOHO_ORG_ID}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    const data = await resp.json();
    const list = data.payments || [];
    const hit = list.find(
      (p) => String(p.reference_number || "").trim() === String(anetTxnId).trim()
    );
    if (hit) {
      console.log("ℹ️ Transaction", anetTxnId, "already recorded as payment",
        hit.payment_id, "- skipping.");
      return true;
    }
    return false;
  } catch (e) {
    // Can't tell — let the balance check downstream decide rather than risking
    // a silent miss.
    console.log("⚠️ Could not check existing payments:", e.message);
    return false;
  }
}

// =====================================================
// 1) AUTHORIZE.NET WEBHOOK – RAW FIRST
// =====================================================
// we put this BEFORE json() so ANet signature still matches
app.post("/anet-webhook", express.raw({ type: "*/*" }), async (req, res) => {
  console.log("=== ANet webhook hit ===");
  if (WEBHOOK_VERBOSE) {
    console.log("Headers:", req.headers);
    console.log("Raw body:", req.body.toString());
  }

  const sigHeader = req.headers["x-anet-signature"];
  let signatureOk = false;

  if (sigHeader && ANET_WEBHOOK_KEY) {
    const lower = String(sigHeader).toLowerCase();
    if (lower.startsWith("sha512=")) {
      const sentSig = lower.split("=", 2)[1];
      const computed = crypto
        .createHmac("sha512", Buffer.from(ANET_WEBHOOK_KEY, "hex"))
        .update(req.body)
        .digest("hex");

      // Constant-time compare so we don't leak the signature byte by byte.
      const a = Buffer.from(computed.toLowerCase());
      const b = Buffer.from(String(sentSig).toLowerCase());
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        signatureOk = true;
        console.log("✅ Signature verified");
      } else {
        console.log("❌ Signature mismatch");
      }
    } else {
      console.log("❌ Signature header present but not sha512=...");
    }
  } else {
    console.log("❌ Missing signature header or ANET_WEBHOOK_KEY");
  }

  // ---------------------------------------------------------------------
  // ENFORCEMENT. Without this, anyone who can guess a Zoho invoice id can
  // POST a fake authcapture event and have Books record a payment that never
  // happened. Return 200 so Authorize.Net doesn't retry-storm a forgery.
  // ---------------------------------------------------------------------
  const srcIp = clientIp(req);
  const ipOk = ANET_IPS.includes(srcIp);

  if (!signatureOk) {
    if (ANET_ENFORCE_SIG) {
      console.log("🚫 REJECTED — signature invalid and enforcement is on. IP:", srcIp);
      return res.status(200).send("bad signature");
    }
    if (ANET_IP_GUARD && !ipOk) {
      console.log("🚫 REJECTED — bad signature from non-Authorize.Net IP:", srcIp);
      return res.status(200).send("rejected");
    }
    console.log(
      "⚠️  Signature not verified. Source IP:", srcIp,
      ipOk ? "(matches Authorize.Net)" : "(NOT a known Authorize.Net IP)",
      "— processing anyway. ANET_IP_GUARD and ANET_ENFORCE_SIG are both off."
    );
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (e) {
    console.log("❌ Could not parse webhook JSON:", e);
    return res.status(200).send("bad json");
  }

  console.log("Event type:", event.eventType);
  if (WEBHOOK_VERBOSE) console.log("Payload:", event.payload);

  if (event.eventType !== "net.authorize.payment.authcapture.created") {
    console.log("Ignoring event:", event.eventType);
    return res.status(200).send("ignored");
  }

  const payload = event.payload || {};
  const amount = payload.authAmount;
  const anetTxnId = payload.id;
  const zohoInvoiceId = await resolveZohoInvoiceId(payload);

  if (!zohoInvoiceId) {
    console.log("❌ Could not resolve a Zoho invoice from this webhook.",
      "invoiceNumber:", payload.invoiceNumber,
      "merchantReferenceId:", payload.merchantReferenceId);
    return res.status(200).send("no invoice id");
  }

  try {
    const invoice = await getZohoInvoice(zohoInvoiceId);
    const pretty = invoice.invoice_number;
    const invoiceBalance = Number(invoice.balance || 0);
    const paymentAmount = Number(amount || 0);

    if (await paymentAlreadyRecorded(zohoInvoiceId, anetTxnId)) {
      // Nothing to do. Most often a Books-originated payment that Books already
      // posted, or an Authorize.Net webhook retry.
    } else if (invoiceBalance <= 0) {
      console.log(
        "ℹ️ Invoice has no balance left in Zoho, skipping payment. Invoice:",
        zohoInvoiceId
      );
    } else if (paymentAmount > invoiceBalance + 0.0001) {
      console.log(
        `ℹ️ Payment (${paymentAmount}) is more than invoice balance (${invoiceBalance}), skipping.`
      );
    } else {
      await createZohoPaymentForInvoiceAmount(invoice, paymentAmount, {
        reference_number: anetTxnId,
        description: `Invoice ${pretty} paid via Authorize.Net`,
      });
      console.log(
        "✅ Recorded payment in Zoho for",
        zohoInvoiceId,
        "amount",
        paymentAmount
      );

      // If this invoice came from an accepted quote, send the PAID invoice and
      // cancel the pending unpaid-invoice email. No-ops on ordinary invoices.
      await quoteFlow.afterPayment(zohoInvoiceId);
    }
  } catch (err) {
    console.log("❌ Error recording payment in Zoho:", err);
  }

  return res.status(200).send("ok");
});

// =====================================================
// 2) BASIC CORS + JSON FOR EVERYTHING ELSE
// =====================================================

// CORS — keep it dead simple so Render doesn't choke
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (
    origin === "https://fdfloors.com" ||
    origin === "https://www.fdfloors.com" ||
    origin === "https://pocatelloflooring.com" ||
    origin === "https://www.pocatelloflooring.com"
  ) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Vary", "Origin");
  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS"
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// now we can parse JSON bodies for normal routes
app.use(express.json({ limit: "256kb" }));

// =====================================================
// 3) QUOTE ACCEPTANCE
// =====================================================
// Mounted here on purpose: the CORS middleware above only covers routes
// declared after it, so these inherit it.
const quoteFlow = mountAcceptQuote(app, {
  getZohoToken: getZohoAccessToken,
  ORG_ID: ZOHO_ORG_ID,
  LINK_SECRET: process.env.QUOTE_LINK_SECRET,
  PAY_BASE: BASE_URL,
  PAY_PATH: "/pay",
  QUOTE_PAGE: process.env.QUOTE_PAGE || "https://fdfloors.com/quote/",
  QUOTE_PAGE_PF:
    process.env.QUOTE_PAGE_PF || "https://pocatelloflooring.com/quote/",
  EMAIL_DELAY_MIN: process.env.EMAIL_DELAY_MIN,
  VOID_UNPAID_DAYS: process.env.VOID_UNPAID_DAYS,
});

// =============================
// DEBUG ROUTES  (gated)
// =============================
app.get("/", (req, res) => {
  res.send("✅ Zoho + Authorize.Net payment service is running.");
});

app.get("/debug/env", requireDebugKey, (req, res) => {
  res.json({
    ZOHO_CLIENT_ID: !!ZOHO_CLIENT_ID,
    ZOHO_ORG_ID,
    ANET_LOGIN: !!ANET_LOGIN,
    ANET_KEY: !!ANET_KEY,
    ANET_WEBHOOK_KEY: !!ANET_WEBHOOK_KEY,
    QUOTE_LINK_SECRET: !!process.env.QUOTE_LINK_SECRET,
    ANET_ENFORCE_SIG,
    WEBHOOK_VERBOSE,
    RATE_LIMITS_ON,
    ANET_IP_GUARD,
    ANET_IPS,
    BASE_URL,
  });
});

// Diagnoses why the Authorize.Net webhook signature never verifies. Replays a
// real captured webhook from the 27 Jul logs against every plausible reading of
// ANET_WEBHOOK_KEY. Delete this route once the key is sorted.
app.get("/debug/anet-sig", requireDebugKey, (req, res) => {
  const BODY =
    '{"notificationId":"e591c2ba-3448-484e-a23c-ca5f10a7ac6f","eventType":"net.authorize.payment.authcapture.created","eventDate":"2026-07-27T20:18:42.2353931Z","webhookId":"dc19dc6c-7e8f-40bb-a645-c0eac6b5d23c","payload":{"responseCode":1,"authCode":"05259D","avsResponse":"Y","authAmount":3317.40,"fraudList":[{"fraudFilter":"Amount Filter","fraudAction":"report"}],"invoiceNumber":"5032827000019119030","entityName":"transaction","id":"81716921721"}}';
  const EXPECTED =
    "c4a5a74461d66d3d6921158802b5b93b0d0367b27135b149fa798d4faffb0f22456a630f9110bb8a73e292126f84526779e9019fde30201b1fe26551a34a9bfd";

  const key = ANET_WEBHOOK_KEY || "";
  if (!key) return res.json({ error: "ANET_WEBHOOK_KEY is not set" });

  const buf = Buffer.from(BODY, "utf8");
  const variants = {
    "hex-decoded bytes (current code)": () =>
      crypto.createHmac("sha512", Buffer.from(key, "hex")),
    "raw string as-is": () => crypto.createHmac("sha512", key),
    "raw string trimmed": () => crypto.createHmac("sha512", key.trim()),
    "raw string uppercased": () =>
      crypto.createHmac("sha512", key.trim().toUpperCase()),
    "raw string lowercased": () =>
      crypto.createHmac("sha512", key.trim().toLowerCase()),
    "hex-decoded trimmed": () =>
      crypto.createHmac("sha512", Buffer.from(key.trim(), "hex")),
    "base64-decoded": () =>
      crypto.createHmac("sha512", Buffer.from(key.trim(), "base64")),
  };

  const results = {};
  let winner = null;
  for (const [name, make] of Object.entries(variants)) {
    try {
      const got = make().update(buf).digest("hex").toLowerCase();
      const ok = got === EXPECTED;
      if (ok) winner = name;
      results[name] = ok ? "*** MATCH ***" : got.slice(0, 16) + "...";
    } catch (e) {
      results[name] = "error: " + e.message;
    }
  }

  res.json({
    bodyLength: buf.length,
    bodyIntact: buf.length === 448,
    keyLength: key.length,
    keyLooksHex: /^[0-9a-fA-F]+$/.test(key),
    keyHasWhitespace: /\s/.test(key),
    results,
    answer: winner,
    verdict: winner
      ? "Use this variant in the webhook handler, then set ANET_ENFORCE_SIG=true."
      : "No variant matched — ANET_WEBHOOK_KEY is the wrong credential. The " +
        "Signature Key is 128 hex chars; the API Transaction Key is ~16. Get a " +
        "new Signature Key from Account > Settings > Security Settings > API " +
        "Credentials & Keys.",
  });
});

app.get("/debug/zoho-token", requireDebugKey, async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    res.json({ access_token: token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================
// VIEW INVOICE RAW  (gated — this is customer PII)
// =============================
app.get("/invoice/:id", requireDebugKey, async (req, res) => {
  try {
    const invoice = await getZohoInvoice(req.params.id);
    res.json({ code: 0, invoice });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================
// AUTHORIZE.NET TOKEN HELPER
// =============================
async function getAuthorizeNetToken({ amount, invoiceId, prettyNumber }) {
  if (!ANET_LOGIN || !ANET_KEY) {
    throw new Error("Authorize.Net credentials missing");
  }

  const successUrl = `${BASE_URL}/payment-success?invoice_id=${encodeURIComponent(
    invoiceId
  )}`;
  const cancelUrl = `${BASE_URL}/payment-cancelled?invoice_id=${encodeURIComponent(
    invoiceId
  )}`;

  const payload = {
    getHostedPaymentPageRequest: {
      merchantAuthentication: {
        name: ANET_LOGIN,
        transactionKey: ANET_KEY,
      },
      transactionRequest: {
        transactionType: "authCaptureTransaction",
        amount: Number(amount).toFixed(2),
        order: {
          invoiceNumber: invoiceId,
          description: prettyNumber ? `Invoice ${prettyNumber}` : "Invoice",
        },
      },
      hostedPaymentSettings: {
        setting: [
          {
            settingName: "hostedPaymentReturnOptions",
            settingValue: JSON.stringify({
              showReceipt: false,
              url: successUrl,
              urlText: "Continue",
              cancelUrl: cancelUrl,
              cancelUrlText: "Cancel",
            }),
          },
        ],
      },
    },
  };

  const resp = await fetch("https://api.authorize.net/xml/v1/request.api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();

  if (!data.token) {
    console.error("❌ Authorize.Net token error:", data);
    throw new Error("Authorize.Net did not return a token");
  }

  return data.token;
}

// =============================
// /pay ROUTE
// =============================
app.get("/pay", rateLimit(30, 60 * 1000), async (req, res) => {
  const invoiceId = req.query.invoice_id;
  if (!invoiceId) {
    return res.status(400).send("Missing invoice_id");
  }

  try {
    const invoice = await getZohoInvoice(invoiceId);
    const balance = Number(invoice.balance || 0);

    if (balance <= 0) {
      return res.status(400).send("<h2>This invoice is already paid.</h2>");
    }

    const amount = balance;
    const prettyNumber = invoice.invoice_number;

    const anetToken = await getAuthorizeNetToken({
      amount,
      invoiceId,
      prettyNumber,
    });

    res.send(`
      <html>
        <body>
          <h3>Redirecting to secure payment...</h3>
          <form id="anetForm" method="post" action="https://accept.authorize.net/payment/payment">
            <input type="hidden" name="token" value="${anetToken}" />
          </form>
          <script>
            document.getElementById('anetForm').submit();
          </script>
        </body>
      </html>
    `);
  } catch (e) {
    console.error("Error starting payment:", e);
    res.status(500).send("Error starting payment: " + e.message);
  }
});

// =============================
// SUCCESS / CANCEL
// =============================
app.get("/payment-success", (req, res) => {
  // Quote payments can hand back a ?back= URL so the customer lands on the
  // branded confirmation instead of this bare page. Prefix-checked to keep
  // it from becoming an open redirect.
  const back = String(req.query.back || "");
  const backOk = ["https://fdfloors.com/", "https://www.fdfloors.com/",
                  "https://pocatelloflooring.com/", "https://www.pocatelloflooring.com/"];
  if (backOk.some((prefix) => back.startsWith(prefix))) {
    return res.redirect(302, back);
  }
  res.send("<h2>Payment successful.</h2>");
});
app.get("/payment-cancelled", (req, res) => {
  res.send("<h2>Payment cancelled.</h2>");
});

// =====================================================
// QUOTE ENDPOINT - BigCommerce Integration
// =====================================================

// Helper: Search for existing Zoho Account
async function searchZohoAccount(accountName, email) {
  const accessToken = await getZohoAccessToken();
  const searchCriteria = `((Account_Name:equals:${accountName})or(Email:equals:${email}))`;
  const searchUrl = `https://www.zohoapis.com/crm/v2/Accounts/search?criteria=${encodeURIComponent(
    searchCriteria
  )}`;

  const resp = await fetch(searchUrl, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });

  const data = await resp.json();
  return data.data && data.data.length > 0 ? data.data[0] : null;
}

// Helper: Create new Zoho Account (with logging + Email + real error output)
async function createZohoAccount(customerData) {
  const accessToken = await getZohoAccessToken();

  const accountData = {
    Account_Name:
      customerData.company ||
      `${customerData.firstName} ${customerData.lastName}`,
    Phone: customerData.phone || null,
    Email: customerData.email || null, // <-- add Email so we can search by it too
    Website: customerData.company
      ? `https://${customerData.company.toLowerCase().replace(/\s/g, "")}.com`
      : null,
    Billing_Street: customerData.addressLine1 || null,
    Billing_City: customerData.city || null,
    Billing_State: customerData.state || customerData.stateOrProvince || null,
    Billing_Code: customerData.postalCode || customerData.zip || null,
    Billing_Country: customerData.countryCode || "US",
  };

  console.log("📦 Creating Zoho Account with data:", accountData);

  const resp = await fetch("https://www.zohoapis.com/crm/v2/Accounts", {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: [accountData] }),
  });

  const data = await resp.json();
  console.log(
    "📥 Zoho Accounts create response:",
    JSON.stringify(data, null, 2)
  );

  // HTTP-level failure
  if (!resp.ok) {
    throw new Error(
      `Failed to create Zoho account (HTTP ${resp.status}): ${
        data.message || "Unknown HTTP error"
      }`
    );
  }

  // CRM-level failure
  if (!data.data || !data.data[0] || data.data[0].code !== "SUCCESS") {
    const first = data.data && data.data[0];
    const msg =
      (first && first.message) ||
      data.message ||
      JSON.stringify(data);
    throw new Error(`Failed to create Zoho account: ${msg}`);
  }

  return data.data[0].details.id;
}

// Helper: Search for existing Zoho Contact
async function searchZohoContact(email) {
  const accessToken = await getZohoAccessToken();
  const searchCriteria = `(Email:equals:${email})`;
  const searchUrl = `https://www.zohoapis.com/crm/v2/Contacts/search?criteria=${encodeURIComponent(
    searchCriteria
  )}`;

  const resp = await fetch(searchUrl, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });

  const data = await resp.json();
  return data.data && data.data.length > 0 ? data.data[0] : null;
}

// Helper: Create new Zoho Contact
async function createZohoContact(customerData, accountId) {
  const accessToken = await getZohoAccessToken();

  const contactData = {
    First_Name: customerData.firstName,
    Last_Name: customerData.lastName,
    Email: customerData.email,
    Phone: customerData.phone,
    Mailing_Street: customerData.addressLine1,
    Mailing_City: customerData.city,
    Mailing_State: customerData.state || customerData.stateOrProvince,
    Mailing_Zip: customerData.postalCode || customerData.zip,
    Mailing_Country: customerData.countryCode || "US",
    Account_Name: { id: accountId },
  };

  const resp = await fetch("https://www.zohoapis.com/crm/v2/Contacts", {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: [contactData] }),
  });

  const data = await resp.json();
  if (!data.data || !data.data[0] || data.data[0].code !== "SUCCESS") {
    throw new Error("Failed to create Zoho contact");
  }

  return data.data[0].details.id;
}

// Helper: Create Zoho Deal
async function createZohoDeal(customerData, accountId, contactId, cartTotal) {
  const accessToken = await getZohoAccessToken();

  const dealData = {
    Deal_Name: `Website Quote - ${customerData.firstName} ${customerData.lastName}`,
    Stage: "Quote Requested",
    Account_Name: { id: accountId },
    Contact_Name: { id: contactId },
    Amount: cartTotal || 0,
    Lead_Source: "Website Quote Form",
    Description:
      customerData.specialInstructions ||
      customerData.comments ||
      "Quote requested via website",
  };

  const resp = await fetch("https://www.zohoapis.com/crm/v2/Deals", {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: [dealData] }),
  });

  const data = await resp.json();
  if (!data.data || !data.data[0] || data.data[0].code !== "SUCCESS") {
    throw new Error("Failed to create Zoho deal");
  }

  return data.data[0].details.id;
}

// Helper: Create Zoho Quote
async function createZohoQuote(dealId, contactId, items) {
  const accessToken = await getZohoAccessToken();

  const lineItems = items.map((item) => ({
    product: item.zohoProductId ? { id: item.zohoProductId } : null,
    Product_Name: item.name,
    quantity: item.quantity,
    list_price: 0,
    Description: item.options ? JSON.stringify(item.options) : "",
  }));

  const quoteData = {
    Subject: `Quote for Deal ${dealId}`,
    Deal_Name: { id: dealId },
    Contact_Name: { id: contactId },
    Quote_Stage: "Draft",
    Product_Details: lineItems,
  };

  const resp = await fetch("https://www.zohoapis.com/crm/v2/Quotes", {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: [quoteData] }),
  });

  const data = await resp.json();
  if (!data.data || !data.data[0] || data.data[0].code !== "SUCCESS") {
    throw new Error("Failed to create Zoho quote");
  }

  return data.data[0].details.id;
}

// Main quote endpoint — public, so throttled and input-capped
app.post("/quote", rateLimit(5, 10 * 60 * 1000), async (req, res) => {
  try {
    console.log("📝 Quote request received:", JSON.stringify(req.body, null, 2));

    const { customer, items, notes } = req.body;

    if (
      !customer ||
      !customer.email ||
      !customer.firstName ||
      !customer.lastName
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing required customer information",
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(customer.email))) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address",
      });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No items in quote request",
      });
    }

    if (items.length > 200) {
      return res.status(400).json({
        success: false,
        message: "Too many items in this request",
      });
    }

    // 1) account
    let accountId;
    const existingAccount = await searchZohoAccount(
      customer.company || `${customer.firstName} ${customer.lastName}`,
      customer.email
    );

    if (existingAccount) {
      accountId = existingAccount.id;
      console.log("✅ Found existing account:", accountId);
    } else {
      accountId = await createZohoAccount(customer);
      console.log("✅ Created account:", accountId);
    }

    // 2) contact
    let contactId;
    const existingContact = await searchZohoContact(customer.email);
    if (existingContact) {
      contactId = existingContact.id;
      console.log("✅ Found existing contact:", contactId);
    } else {
      contactId = await createZohoContact(customer, accountId);
      console.log("✅ Created contact:", contactId);
    }

    // 3) deal
    const cartTotal = items.reduce(
      (sum, item) => sum + (item.quantity || 0),
      0
    );
    const dealId = await createZohoDeal(
      { ...customer, specialInstructions: notes },
      accountId,
      contactId,
      cartTotal
    );
    console.log("✅ Created deal:", dealId);

    // 4) quote
    const quoteId = await createZohoQuote(dealId, contactId, items);
    console.log("✅ Created quote:", quoteId);

    res.json({
      success: true,
      message:
        "Quote request submitted successfully! Our team will contact you shortly.",
      data: {
        accountId,
        contactId,
        dealId,
        quoteId,
      },
    });
  } catch (error) {
    console.error("❌ Error processing quote:", error);
    res.status(500).json({
      success: false,
      message:
        "An error occurred while processing your quote request. Please try again or contact us directly.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// Test endpoint
app.get("/quote/test", (req, res) => {
  res.json({
    status: "Quote endpoint ready",
    endpoint: "POST /quote",
    server: "payments-nleq.onrender.com",
    timestamp: new Date().toISOString(),
  });
});

// =============================
// STARTUP CHECKS
// =============================
if (!DEBUG_KEY) {
  console.warn("⚠️  DEBUG_KEY not set — /debug/* and /invoice/:id return 404");
}
if (!process.env.QUOTE_LINK_SECRET) {
  console.warn("⚠️  QUOTE_LINK_SECRET not set — quote links will not validate");
}
if (!ANET_ENFORCE_SIG) {
  console.warn(
    "⚠️  ANET_ENFORCE_SIG is OFF. Webhook signatures logged, not enforced." +
      (ANET_IP_GUARD ? " IP guard ON: " + ANET_IPS.join(", ") : " IP guard OFF.")
  );
}

// =============================
// START SERVER
// =============================
app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});
