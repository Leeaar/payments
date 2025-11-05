// =============================
// Imports & setup
// =============================
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// needed so ANet can send us JSON later
app.use(express.json());

// =============================
// Env vars (from Render)
// =============================
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ORG_ID = process.env.ZOHO_ORG_ID || "852929343";

const ANET_LOGIN = process.env.ANET_LOGIN;      // your Authorize.Net API Login ID
const ANET_KEY = process.env.ANET_KEY;          // your Authorize.Net Transaction Key

// your public Render URL
const BASE_URL =
  process.env.BASE_URL || "https://payments-nleq.onrender.com";

// =============================
// Zoho access token cache
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

  const params = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const resp = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    body: params,
  });

  const data = await resp.json();
  if (!data.access_token) {
    console.error("Zoho token error:", data);
    throw new Error(
      data.error_description || data.error || "Could not get Zoho access token"
    );
  }

  zohoTokenCache.access_token = data.access_token;
  zohoTokenCache.expires_at =
    Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600000);

  console.log("✅ Zoho token refreshed");
  return data.access_token;
}

// =============================
// Helper: get invoice from Zoho
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
    console.error("Zoho invoice error:", data);
    throw new Error(data.message || "Could not fetch invoice from Zoho");
  }
  return data.invoice;
}

// =============================
// Helper: get Authorize.Net hosted payment token
// =============================
async function getAuthorizeNetToken({ amount, invoiceId, invoiceNumber }) {
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
          invoiceNumber: invoiceNumber || invoiceId,
          // stash zoho invoice id so it comes back in webhook later
          description: `zoho_invoice_id=${invoiceId}`,
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
  console.log("Authorize.Net response:", data);

  if (!data.token) {
    throw new Error("Authorize.Net did not return a token");
  }

  return data.token;
}

// =============================
// ROUTES
// =============================

// health
app.get("/", (req, res) => {
  res.send("✅ Zoho + Authorize.Net payment service is running.");
});

// debug env
app.get("/debug/env", (req, res) => {
  res.json({
    ZOHO_CLIENT_ID: ZOHO_CLIENT_ID ? "loaded" : "missing",
    ZOHO_ORG_ID,
    ANET_LOGIN: ANET_LOGIN ? "loaded" : "missing",
    ANET_KEY: ANET_KEY ? "loaded" : "missing",
    BASE_URL,
  });
});

// debug zoho token
app.get("/debug/zoho-token", async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    res.json({ access_token: token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// raw invoice view (what you just tested)
app.get("/invoice/:id", async (req, res) => {
  try {
    const invoice = await getZohoInvoice(req.params.id);
    res.json({ code: 0, invoice });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// main payment route
// usage: /pay?invoice_id=5032827000008443267
app.get("/pay", async (req, res) => {
  const invoiceId = req.query.invoice_id;
  if (!invoiceId) {
    return res.status(400).send("Missing invoice_id");
  }

  try {
    // 1) get invoice from zoho
    const invoice = await getZohoInvoice(invoiceId);
    const amount = invoice.balance || invoice.total;
    const invoiceNumber = invoice.invoice_number;

    // 2) get ANet hosted payment token
    const anetToken = await getAuthorizeNetToken({
      amount,
      invoiceId,
      invoiceNumber,
    });

    // 3) auto-post to ANet
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

// simple success / cancel placeholders
app.get("/payment-success", (req, res) => {
  res.send("<h2>Payment successful.</h2>");
});
app.get("/payment-cancelled", (req, res) => {
  res.send("<h2>Payment cancelled.</h2>");
});

// =============================
// TEMP Authorize.Net webhook
// =============================
// This is ONLY so you can save the webhook in the ANet dashboard.
// After ANet accepts it, we can replace this with the real verified one.
app.post("/anet-webhook", (req, res) => {
  console.log("✅ Authorize.Net webhook ping received:", req.body);
  res.status(200).send("ok");
});

// =============================
// Start server
// =============================
app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});
