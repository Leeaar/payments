// app.js

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";

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
      data.error_description || data.error || "Could not get Zoho access token",
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
    console.error("❌ Zoho invoice error:", data);
    throw new Error(data.message || "Could not fetch invoice from Zoho");
  }

  return data.invoice;
}

async function createZohoPaymentForInvoiceAmount(
  invoice,
  amount,
  opts = {},
) {
  const accessToken = await getZohoAccessToken();

  const payload = {
    customer_id: invoice.customer_id,
    amount: amount,
    date: new Date().toISOString().slice(0, 10),
    payment_mode: "Authorize.Net", // 👈 your label
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
    },
  );

  const data = await resp.json();
  if (data.code !== 0) {
    console.error("❌ Zoho payment create failed:", data);
    throw new Error(data.message || "Zoho did not accept payment");
  }

  console.log("✅ Payment recorded in Zoho:", data);
  return data;
}

// =====================================================
// 1) AUTHORIZE.NET WEBHOOK – RAW FIRST
// =====================================================
app.post("/anet-webhook", express.raw({ type: "*/*" }), async (req, res) => {
  console.log("=== ANet webhook hit ===");
  console.log("Headers:", req.headers);
  console.log("Raw body:", req.body.toString());

  // ----- signature check (case-insensitive) -----
  const sigHeader = req.headers["x-anet-signature"];
  let signatureOk = false;

  if (sigHeader && ANET_WEBHOOK_KEY) {
    const lower = sigHeader.toLowerCase();
    if (lower.startsWith("sha512=")) {
      const sentSig = lower.split("=", 2)[1];
      const computed = crypto
        .createHmac("sha512", Buffer.from(ANET_WEBHOOK_KEY, "hex"))
        .update(req.body)
        .digest("hex");

      if (computed.toLowerCase() === sentSig.toLowerCase()) {
        signatureOk = true;
        console.log("✅ Signature verified");
      } else {
        console.log("❌ Signature mismatch");
        console.log("Sent    :", sentSig.toLowerCase());
        console.log("Computed:", computed.toLowerCase());
      }
    } else {
      console.log("❌ Signature header present but not sha512=...");
    }
  } else {
    console.log("❌ Missing signature header or ANET_WEBHOOK_KEY");
  }

  // ----- parse body -----
  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (e) {
    console.log("❌ Could not parse webhook JSON:", e);
    return res.status(200).send("bad json");
  }

  console.log("Event type:", event.eventType);
  console.log("Payload:", event.payload);

  if (event.eventType !== "net.authorize.payment.authcapture.created") {
    console.log("Ignoring event:", event.eventType);
    return res.status(200).send("ignored");
  }

  const payload = event.payload || {};
  const amount = payload.authAmount;
  const anetTxnId = payload.id; // Authorize.Net transaction id
  const anetInvoiceNumber = payload.invoiceNumber || ""; // should be Zoho internal ID now

  const zohoInvoiceId = anetInvoiceNumber;

  if (!zohoInvoiceId) {
    console.log("❌ No Zoho invoice id in webhook");
    return res.status(200).send("no invoice id");
  }

  // fetch invoice so we can see balance and pretty number
  try {
    const invoice = await getZohoInvoice(zohoInvoiceId);
    const pretty = invoice.invoice_number;
    const invoiceBalance = Number(invoice.balance || 0);
    const paymentAmount = Number(amount || 0);

    // 👇 guard against already-paid or overpayment
    if (invoiceBalance <= 0) {
      console.log(
        "ℹ️ Invoice has no balance left in Zoho, skipping payment. Invoice:",
        zohoInvoiceId,
      );
    } else if (paymentAmount > invoiceBalance + 0.0001) {
      console.log(
        `ℹ️ Payment (${paymentAmount}) is more than invoice balance (${invoiceBalance}), skipping.`,
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
        paymentAmount,
      );
    }
  } catch (err) {
    console.log("❌ Error recording payment in Zoho:", err);
  }

  return res.status(200).send("ok");
});

// =====================================================
// 2) parse JSON for everything else
// =====================================================
app.use(express.json());

// =============================
// DEBUG ROUTES
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
    BASE_URL,
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

// =============================
// VIEW INVOICE RAW
// =============================
app.get("/invoice/:id", async (req, res) => {
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
    invoiceId,
  )}`;
  const cancelUrl = `${BASE_URL}/payment-cancelled?invoice_id=${encodeURIComponent(
    invoiceId,
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
          // send Zoho's internal ID as invoiceNumber, so webhook can map it back
          invoiceNumber: invoiceId,
          // show the pretty number as description
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
  console.log("Authorize.Net response:", data);

  if (!data.token) {
    throw new Error("Authorize.Net did not return a token");
  }

  return data.token;
}

// =============================
// /pay ROUTE
// =============================
app.get("/pay", async (req, res) => {
  const invoiceId = req.query.invoice_id;
  if (!invoiceId) {
    return res.status(400).send("Missing invoice_id");
  }

  try {
    const invoice = await getZohoInvoice(invoiceId);
    const balance = Number(invoice.balance || 0);

    // 👇 don’t let people pay invoices that are already paid
    if (balance <= 0) {
      return res
        .status(400)
        .send("<h2>This invoice is already paid.</h2>");
    }

    const amount = balance; // always use remaining balance
    const prettyNumber = invoice.invoice_number; // e.g. INV-001293

    const anetToken = await getAuthorizeNetToken({
      amount,
      invoiceId, // real Zoho ID
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
  res.send("<h2>Payment successful.</h2>");
});
app.get("/payment-cancelled", (req, res) => {
  res.send("<h2>Payment cancelled.</h2>");
});

// =============================
// START SERVER
// =============================
app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});
