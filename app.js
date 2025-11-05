import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// ==================== CACHED TOKEN HANDLER ====================
let ZOHO_TOKEN_CACHE = {
  access_token: null,
  expires_at: 0,
};

async function getZohoAccessToken() {
  const now = Date.now();

  // Reuse if still valid
  if (ZOHO_TOKEN_CACHE.access_token && ZOHO_TOKEN_CACHE.expires_at > now + 5000) {
    console.log("Using cached Zoho token");
    return ZOHO_TOKEN_CACHE.access_token;
  }

  console.log("Refreshing Zoho access token...");
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const resp = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    body: params,
  });

  const json = await resp.json();
  if (!json.access_token) {
    console.error("Zoho token fetch failed:", json);
    throw new Error(json.error_description || "Could not get Zoho access token");
  }

  ZOHO_TOKEN_CACHE.access_token = json.access_token;
  ZOHO_TOKEN_CACHE.expires_at = Date.now() + (json.expires_in || 3600) * 1000;
  console.log("Zoho token refreshed successfully.");
  return json.access_token;
}

// ==================== ROUTES ====================

// Root test
app.get("/", (req, res) => {
  res.send("✅ Zoho + Authorize.Net payment service is running.");
});

// Debug - show environment variables (safe subset)
app.get("/debug/env", (req, res) => {
  res.json({
    ZOHO_CLIENT_ID: process.env.ZOHO_CLIENT_ID,
    ZOHO_ORG_ID: process.env.ZOHO_ORG_ID,
    ANET_LOGIN: process.env.ANET_LOGIN ? "✔️ Loaded" : "❌ Missing",
    ANET_KEY: process.env.ANET_KEY ? "✔️ Loaded" : "❌ Missing",
  });
});

// Debug - manually test token
app.get("/debug/zoho-token", async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    res.json({ access_token: token, cached: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== INVOICE HANDLER ====================
app.get("/pay", async (req, res) => {
  const invoiceId = req.query.invoice_id;
  if (!invoiceId) return res.status(400).send("Missing invoice_id");

  try {
    const accessToken = await getZohoAccessToken();
    const orgId = process.env.ZOHO_ORG_ID;

    const url = `https://books.zoho.com/api/v3/invoices/${invoiceId}?organization_id=${orgId}`;
    const headers = { Authorization: `Zoho-oauthtoken ${accessToken}` };

    const resp = await fetch(url, { headers });
    const data = await resp.json();

    if (data.code !== 0) {
      console.error("Zoho API error:", data);
      return res.status(500).send("Failed to fetch invoice data from Zoho.");
    }

    const invoice = data.invoice;
    const amount = invoice.balance || invoice.total;
    const customerName = invoice.customer_name;

    // Display payment form
    res.send(`
      <html>
      <head><title>Pay Invoice ${invoice.invoice_number}</title></head>
      <body style="font-family:sans-serif; text-align:center; margin-top:100px;">
        <h1>Invoice ${invoice.invoice_number}</h1>
        <p>Customer: ${customerName}</p>
        <p>Amount Due: $${amount}</p>
        <form id="payment-form" method="POST" action="https://accept.authorize.net/payment/payment">
          <input type="hidden" name="token" value="${process.env.ANET_KEY}">
          <button type="submit" style="padding:10px 20px; font-size:18px;">Pay Now</button>
        </form>
      </body>
      </html>
    `);
  } catch (e) {
    console.error("Error starting payment:", e);
    res.status(500).send("Error starting payment: " + e.message);
  }
});

// ==================== SERVER ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
