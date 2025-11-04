// app.js
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE_URL =
  process.env.BASE_URL || "https://payments-nleq.onrender.com"; // change if your render url is different

/**
 * REQUIRED ENV VARS (Render -> Environment):
 * ANET_LOGIN
 * ANET_KEY
 * ZOHO_CLIENT_ID
 * ZOHO_CLIENT_SECRET
 * ZOHO_REFRESH_TOKEN
 * ZOHO_ORG_ID  (yours was 852929343)
 */

// ======================================================
// 1) ZOHO HELPERS
// ======================================================
async function getZohoAccessToken() {
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
  // if Zoho says no, we want to see it in logs
  if (!json.access_token) {
    console.error("Zoho token error:", json);
    throw new Error("Could not get Zoho access token");
  }
  return json.access_token;
}

async function getZohoInvoice(invoiceId) {
  console.log("=== GET INVOICE FROM ZOHO BOOKS ===", invoiceId);
  const orgId = process.env.ZOHO_ORG_ID || "852929343";
  const accessToken = await getZohoAccessToken();

  const url = `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${orgId}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });
  const data = await resp.json();
  console.log("Zoho invoice response:", data);

  if (data.code === 0) {
    const inv = data.invoice;
    return {
      invoice_id: invoiceId,
      invoice_number: inv.invoice_number,
      customer_name: inv.customer_name,
      customer_id: inv.customer_id,
      email: inv.email,
      balance: inv.balance,
      total: inv.total,
      date: inv.date,
      due_date: inv.due_date,
      status: inv.status,
    };
  } else {
    return { error: data.message || "Unknown Zoho error" };
  }
}

// ======================================================
// 2) AUTHORIZE.NET HELPER
// ======================================================
async function getAuthorizeNetHostedToken({ amount, invoiceId, invoiceNumber }) {
  const loginId = process.env.ANET_LOGIN;
  const transKey = process.env.ANET_KEY;
  if (!loginId || !transKey) {
    throw new Error("Authorize.Net credentials missing");
  }

  const successUrl = `${BASE_URL}/payment-success?invoice_id=${encodeURIComponent(
    invoiceId
  )}`;
  const cancelUrl = `${BASE_URL}/payment-cancelled?invoice_id=${encodeURIComponent(
    invoiceId
  )}`;

  const body = {
    getHostedPaymentPageRequest: {
      merchantAuthentication: {
        name: loginId,
        transactionKey: transKey,
      },
      transactionRequest: {
        transactionType: "authCaptureTransaction",
        amount: Number(amount).toFixed(2),
        order: {
          invoiceNumber: invoiceNumber || invoiceId,
        },
        userFields: {
          userField: [
            { name: "invoice_id", value: invoiceId },
            { name: "invoice_number", value: invoiceNumber || "" },
          ],
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
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json();
  console.log("Authorize.Net response:", json);

  if (!json.token) {
    throw new Error("Authorize.Net did not return token");
  }

  return json.token;
}

// ======================================================
// 3) ROUTES
// ======================================================

// a) root
app.get("/", (req, res) => {
  res.send("<h2>Payments service is running.</h2>");
});

// b) OAuth callback (just so Zoho has somewhere to send you)
app.get("/oauth/callback", (req, res) => {
  const code = req.query.code;
  res.send(`<h2>Zoho OAuth code received</h2><pre>${code || "no code"}</pre>`);
});

// c) DEBUG: see what Zoho is actually returning for your env vars
app.get("/debug/zoho-token", async (req, res) => {
  try {
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
    res.json(json);
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

// d) start payment: /pay?invoice_id=5032827000006984109
app.get("/pay", async (req, res) => {
  try {
    const invoiceId = req.query.invoice_id;
    if (!invoiceId) {
      return res.status(400).send("Missing invoice_id");
    }

    // 1. fetch invoice from Zoho
    const invoice = await getZohoInvoice(invoiceId);
    if (invoice.error) {
      return res
        .status(500)
        .send("Could not fetch invoice from Zoho: " + invoice.error);
    }

    // 2. use balance or total
    const amount = invoice.balance || invoice.total;
    // 3. get Authorize.Net hosted token
    const anetToken = await getAuthorizeNetHostedToken({
      amount,
      invoiceId,
      invoiceNumber: invoice.invoice_number,
    });

    // 4. auto-post to Authorize.Net
    res.send(`
      <html>
        <body>
          <h3>Redirecting to secure payment...</h3>
          <form id="payment-form" action="https://accept.authorize.net/payment/payment" method="post">
            <input type="hidden" name="token" value="${anetToken}" />
          </form>
          <script>
            document.getElementById('payment-form').submit();
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error starting payment: " + err.message);
  }
});

// e) payment cancelled
app.get("/payment-cancelled", (req, res) => {
  res.send("<h2>Payment cancelled.</h2>");
});

// f) payment success (simple version)
app.get("/payment-success", async (req, res) => {
  try {
    const invoiceId = req.query.invoice_id;
    if (!invoiceId) {
      return res.status(400).send("Missing invoice_id");
    }

    const invoice = await getZohoInvoice(invoiceId);
    if (invoice.error) {
      return res
        .status(500)
        .send("Could not fetch invoice in success handler: " + invoice.error);
    }

    const accessToken = await getZohoAccessToken();
    const orgId = process.env.ZOHO_ORG_ID || "852929343";
    const amountToApply = invoice.balance;

    const paymentPayload = {
      customer_id: invoice.customer_id,
      amount: amountToApply,
      date: new Date().toISOString().slice(0, 10),
      invoices: [
        {
          invoice_id: invoiceId,
          amount_applied: amountToApply,
        },
      ],
    };

    const resp = await fetch(
      `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${orgId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(paymentPayload),
      }
    );

    const data = await resp.json();
    console.log("Zoho payment create resp:", data);

    if (data.code && data.code !== 0) {
      return res
        .status(500)
        .send("Zoho did not accept payment: " + (data.message || ""));
    }

    res.send("<h2>Payment successful and recorded in Zoho.</h2>");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error in payment-success: " + err.message);
  }
});

// ======================================================
// START SERVER
// ======================================================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
