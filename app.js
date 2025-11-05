import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// we’ll use express.json for most routes
app.use(express.json());

// =============================
// ENV VARS
// =============================
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ORG_ID = process.env.ZOHO_ORG_ID || "852929343";

const ANET_LOGIN = process.env.ANET_LOGIN;
const ANET_KEY = process.env.ANET_KEY;
const ANET_WEBHOOK_KEY = process.env.ANET_WEBHOOK_KEY; // Signature Key from ANet

const BASE_URL =
  process.env.BASE_URL || "https://payments-nleq.onrender.com";

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
    console.error("Zoho invoice error:", data);
    throw new Error(data.message || "Could not fetch invoice from Zoho");
  }
  return data.invoice;
}

async function createZohoPaymentForInvoiceAmount(invoice, amount) {
  const accessToken = await getZohoAccessToken();
  const payload = {
    customer_id: invoice.customer_id,
    amount: amount,
    date: new Date().toISOString().slice(0, 10),
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
    console.error("Zoho payment create failed:", data);
    throw new Error(data.message || "Zoho did not accept payment");
  }
  console.log("✅ Payment recorded in Zoho:", data.payment_id);
  return data;
}

// =============================
// AUTHORIZE.NET HELPER
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
          // stash the Zoho invoice id so it shows up in webhook
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

app.get("/", (req, res) => {
  res.send("✅ Zoho + Authorize.Net payment service is running.");
});

app.get("/debug/env", (req, res) => {
  res.json({
    ZOHO_CLIENT_ID: !!ZOHO_CLIENT_ID,
    ZOHO_ORG_ID,
    ANET_LOGIN: !!ANET_LOGIN,
    ANET_KEY: !!ANET_KEY,
    ANET_WEBHOOK_KEY: !!ANET_WEBHOOK_KEY,
  });
});

app.get("/debug/zoho-token", async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    res.json({ access_token: token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/invoice/:id", async (req, res) => {
  try {
    const invoice = await getZohoInvoice(req.params.id);
    res.json({ code: 0, invoice });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// main payment route
app.get("/pay", async (req, res) => {
  const invoiceId = req.query.invoice_id;
  if (!invoiceId) {
    return res.status(400).send("Missing invoice_id");
  }

  try {
    const invoice = await getZohoInvoice(invoiceId);
    const amount = invoice.balance || invoice.total;
    const invoiceNumber = invoice.invoice_number;

    const anetToken = await getAuthorizeNetToken({
      amount,
      invoiceId,
      invoiceNumber,
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

app.get("/payment-success", (req, res) => {
  res.send("<h2>Payment successful.</h2>");
});

app.get("/payment-cancelled", (req, res) => {
  res.send("<h2>Payment cancelled.</h2>");
});

// =============================
// REAL Authorize.Net webhook
// =============================
// we need raw body for signature, so define route separately
app.post(
  "/anet-webhook",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      // 1) verify signature
      const sigHeader = req.headers["x-anet-signature"];
      if (!sigHeader || !sigHeader.startsWith("SHA512=")) {
        console.error("Missing or bad signature header");
        return res.status(401).send("bad signature");
      }

      const sentSig = sigHeader.split("=", 2)[1];
      const rawBody = req.body; // Buffer

      // Signature Key from ANet is hex, so use as-is
      const hmac = crypto
        .createHmac("sha512", Buffer.from(ANET_WEBHOOK_KEY, "hex"))
        .update(rawBody)
        .digest("hex");

      if (hmac.toLowerCase() !== sentSig.toLowerCase()) {
        console.error("Signature mismatch");
        return res.status(401).send("invalid signature");
      }

      // 2) parse JSON now that signature is verified
      const event = JSON.parse(rawBody.toString());
      console.log("✅ Verified ANet webhook:", event.eventType);

      if (
        event.eventType !== "net.authorize.payment.authcapture.created"
      ) {
        // we only care about successful captures
        return res.status(200).send("ignored");
      }

      const payload = event.payload || {};
      const amount = payload.authAmount;
      const invoiceNumber = payload.invoiceNumber || "";
      const description = payload.description || "";

      // try to pull Zoho invoice id from description
      let zohoInvoiceId = null;
      const match = description.match(/zoho_invoice_id=([A-Za-z0-9]+)/);
      if (match) {
        zohoInvoiceId = match[1];
      } else {
        // fallback: maybe we used the Zoho invoice id as invoiceNumber
        zohoInvoiceId = invoiceNumber;
      }

      if (!zohoInvoiceId) {
        console.error("Could not determine Zoho invoice id from webhook");
        return res.status(200).send("no invoice found");
      }

      // 3) fetch invoice from Zoho
      const invoice = await getZohoInvoice(zohoInvoiceId);

      // 4) create payment in Zoho for the captured amount
      await createZohoPaymentForInvoiceAmount(invoice, amount);

      return res.status(200).send("ok");
    } catch (err) {
      console.error("Error handling ANet webhook:", err);
      // still return 200 so ANet doesn't retry like crazy
      return res.status(200).send("logged error");
    }
  }
);

// =============================
// Start server
// =============================
app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});

