import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

app.get("/pay", async (req, res) => {
  const invoiceId = req.query.invoice_id;
  if (!invoiceId) return res.status(400).send("Missing invoice_id");

  // TODO: optionally call Zoho Books to fetch real invoice amount
  const amount = 250.00;

  const token = await getAuthNetToken(amount, invoiceId);

  res.send(`
    <html>
      <body>
        <h3>Redirecting to secure payment...</h3>
        <form id="payment-form" action="https://accept.authorize.net/payment/payment" method="post">
          <input type="hidden" name="token" value="${token}" />
        </form>
        <script>document.getElementById('payment-form').submit();</script>
      </body>
    </html>
  `);
});

async function getAuthNetToken(amount, invoiceId) {
  const body = {
    getHostedPaymentPageRequest: {
      merchantAuthentication: {
        name: process.env.ANET_LOGIN,
        transactionKey: process.env.ANET_KEY
      },
      transactionRequest: {
        transactionType: "authCaptureTransaction",
        amount: amount.toFixed(2),
        userFields: {
          userField: [{ name: "invoice_id", value: invoiceId }]
        }
      },
      hostedPaymentSettings: {
        setting: [
          {
            settingName: "hostedPaymentReturnOptions",
            settingValue: JSON.stringify({
              showReceipt: false,
              url: "https://pay.yourdomain.com/thankyou",
              urlText: "Return",
              cancelUrl: "https://pay.yourdomain.com/cancel",
              cancelUrlText: "Cancel"
            })
          }
        ]
      }
    }
  };

  const resp = await fetch("https://api.authorize.net/xml/v1/request.api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  return json.token;
}

app.listen(3000, () => console.log("Server running on port 3000"));
