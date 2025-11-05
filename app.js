import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// your env from Render
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ORG_ID = process.env.ZOHO_ORG_ID || "852929343";
const ANET_LOGIN = process.env.ANET_LOGIN;
const ANET_KEY = process.env.ANET_KEY;

// your render base url
const BASE_URL =
  process.env.BASE_URL || "https://payments-nleq.onrender.com";

// --------- simple in-memory Zoho token cache ----------
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

  return data.access_token;
}

// --------- fetch invoice from Zoho ----------
async function getZohoInvoice(invoiceId) {
  const token = await getZohoAccessToken();
  const url = `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORG_ID}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
    },
  });
  const data = await resp.json();
  if (data.code !== 0) {
    console.error("Zoho invoice error:", data);
    throw new Error(data.message || "Could not fetch invoice from Zoho");
  }
  return data.invoice;
}

// --------- get Authorize.Net hosted payment token ----------
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

// ------------------- ROUTES -------------------

// health
app.get("/", (req, res) => {
  res.send("✅ Zoho + Authorize.Net payment service is running.");
});

// debug env
app.get("/debug/env", (req, res) => {
  res.json({
    ZOHO_CLIENT_ID: ZOHO_CLIENT_ID?.slice(0, 25),
    ZOHO_REFRESH_TOKEN: ZOHO_REFRESH_TOKEN?.slice(0, 30),
    ZOHO_ORG_ID,
    ANET_LOGIN: ANET_LOGIN ? "present" : "missing",
  });
});

// debug token (uses cache so we don't get rate limited)
app.get("/debug/zoho-token", async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    res.json({ access_token: token, cached: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// basic invoice view (raw JSON like you just saw)
app.get("/invoice/:id", async (req, res) => {
  try {
    const invoice = await getZohoInvoice(req.params.id);
    res.json({ code: 0, invoice });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 👉 main payment route
// usage: /pay?invoice_id=5032827000008443267
app.get("/pay", async (req, res) => {
  const invoiceId = req.query.invoice_id;
  if (!invoiceId) {
    return res.status(400).send("Missing invoice_id");
  }

  try {
    // 1) pull invoice from Zoho
    const invoice = await getZohoInvoice(invoiceId);
    const amount = invoice.balance || invoice.total;
    const invoiceNumber = invoice.invoice_number;

    // 2) get Authorize.Net token for that amount
    const anetToken = await getAuthorizeNetToken({
      amount,
      invoiceId,
      invoiceNumber,
    });

    // 3) auto-post to Authorize.Net
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

// success + cancel just show a message for now
app.get("/payment-success", (req, res) => {
  res.send("<h2>Payment successful. You can close this window.</h2>");
});

app.get("/payment-cancelled", (req, res) => {
  res.send("<h2>Payment cancelled.</h2>");
});

app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});
