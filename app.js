import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import bodyParser from "body-parser";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// ====== Environment Variables ======
const {
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_ORG_ID
} = process.env;

let accessToken = null;
let tokenExpiry = 0;

// ====== TOKEN REFRESH ======
async function getZohoAccessToken() {
  const now = Date.now();
  if (accessToken && now < tokenExpiry) {
    return accessToken;
  }

  console.log("🔁 Refreshing Zoho access token...");
  const body = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token"
  });

  const response = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    console.error("❌ Zoho token refresh failed:", data);
    throw new Error("Could not get Zoho access token");
  }

  accessToken = data.access_token;
  tokenExpiry = now + 1000 * (data.expires_in - 60);
  console.log("✅ Got new Zoho access token");
  return accessToken;
}

// ====== GET INVOICE DETAILS ======
app.get("/invoice/:id", async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    const invoiceId = req.params.id;
    const url = `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORG_ID}`;

    const response = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Invoice fetch error:", err);
    res.status(500).json({ error: "Failed to fetch invoice" });
  }
});

// ====== DEBUG TOKEN ======
app.get("/debug/zoho-token", async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    res.json({ access_token: token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====== TEST ROUTE ======
app.get("/", (req, res) => {
  res.send("✅ Payments service is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
