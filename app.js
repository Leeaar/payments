import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// pull from env (what you put in Render)
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ORG_ID = process.env.ZOHO_ORG_ID || "852929343";

// simple in-memory cache so we don’t spam Zoho
let zohoTokenCache = {
  access_token: null,
  expires_at: 0,
};

// get or refresh an access token
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
    throw new Error(data.error_description || "Could not get Zoho access token");
  }

  zohoTokenCache.access_token = data.access_token;
  // expires_in is in seconds
  zohoTokenCache.expires_at = Date.now() + (data.expires_in || 3600) * 1000;

  return data.access_token;
}

// root
app.get("/", (req, res) => {
  res.send("✅ payments service is running");
});

// debug to see what env the server sees
app.get("/debug/env", (req, res) => {
  res.json({
    ZOHO_CLIENT_ID: ZOHO_CLIENT_ID?.slice(0, 25),
    ZOHO_REFRESH_TOKEN: ZOHO_REFRESH_TOKEN?.slice(0, 35),
    ZOHO_ORG_ID,
  });
});

// debug to see current token
app.get("/debug/zoho-token", async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    res.json({ access_token: token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 👉 actual route you tried to hit
app.get("/invoice/:id", async (req, res) => {
  const invoiceId = req.params.id;
  try {
    const accessToken = await getZohoAccessToken();

    const url = `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORG_ID}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
    });

    const data = await resp.json();
    res.json(data);
  } catch (e) {
    console.error("invoice fetch error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});
