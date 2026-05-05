const express = require('express');
const path    = require('path');
const app     = express();

// ── Token cache (re-used until 60s before expiry) ──
let cachedToken = null, tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const {
    ZOHO_CLIENT_ID,
    ZOHO_CLIENT_SECRET,
    ZOHO_REFRESH_TOKEN,
    ZOHO_ACCOUNTS_URL = 'https://accounts.zoho.com'
  } = process.env;

  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    throw new Error('Missing Zoho OAuth env vars. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN in Railway.');
  }

  const res = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: ZOHO_REFRESH_TOKEN
    })
  });

  const json = await res.json();
  if (!json.access_token) throw new Error('Token exchange failed: ' + JSON.stringify(json));

  cachedToken = json.access_token;
  tokenExpiry = Date.now() + ((json.expires_in || 3600) - 60) * 1000;
  return cachedToken;
}

async function zohoGet(module, fields) {
  const token     = await getAccessToken();
  const apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
  const qs = new URLSearchParams({ per_page: '200', sort_by: 'Created_Time', sort_order: 'desc', fields });
  const res = await fetch(`${apiDomain}/crm/v2/${module}?${qs}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` }
  });
  const json = await res.json();
  return json.data || [];
}

// ── API route: single call returns both modules ──
app.get('/api/data', async (req, res) => {
  try {
    const [leads, deals] = await Promise.all([
      zohoGet('Leads', 'Lead_Status,Lead_Source,Created_Time'),
      zohoGet('Deals', 'Deal_Name,Stage,Amount,Lead_Source,Created_Time')
    ]);
    res.json({ leads, deals, fetchedAt: new Date().toISOString() });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname)));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard on port ${PORT}`));
