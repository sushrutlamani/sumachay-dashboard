const express = require('express');
const path    = require('path');
const fs      = require('fs');
const app     = express();

// ── CRM in-memory cache ──────────────────────────────────
let crmCache   = null;
let zohoToken  = null, zohoTokenExpiry = 0;

function loadDataJson() {
  try {
    crmCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
    console.log('CRM: loaded data.json snapshot');
  } catch(e) {
    crmCache = { leads: [], deals: [], fetchedAt: null };
  }
}

async function getZohoToken() {
  if (zohoToken && Date.now() < zohoTokenExpiry) return zohoToken;
  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ACCOUNTS_URL = 'https://accounts.zoho.com' } = process.env;
  if (!ZOHO_CLIENT_ID) return null;
  const res = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET, refresh_token: ZOHO_REFRESH_TOKEN })
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('Zoho token exchange failed: ' + JSON.stringify(json));
  zohoToken = json.access_token;
  zohoTokenExpiry = Date.now() + ((json.expires_in || 3600) - 60) * 1000;
  return zohoToken;
}

async function zohoGet(module, fields) {
  const token = await getZohoToken();
  if (!token) return null;
  const apiDomain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().substring(0, 10);
  let allData = [];
  for (let page = 1; page <= 10; page++) {
    const qs = new URLSearchParams({ per_page: '200', page: String(page), sort_by: 'Created_Time', sort_order: 'desc', fields });
    const res = await fetch(`${apiDomain}/crm/v2/${module}?${qs}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    const json = await res.json();
    const data = json.data || [];
    if (!data.length) break;
    const filtered = data.filter(r => (r.Created_Time || '').substring(0, 10) >= cutoffStr);
    allData = allData.concat(filtered);
    const oldest = data[data.length - 1];
    if (!oldest || (oldest.Created_Time || '').substring(0, 10) < cutoffStr) break;
    if (!json.info?.more_records) break;
  }
  return allData;
}

async function refreshCRM() {
  const [leads, deals] = await Promise.all([
    zohoGet('Leads', 'Lead_Status,Lead_Source,Created_Time'),
    zohoGet('Deals', 'Deal_Name,Stage,Amount,Lead_Source,Created_Time')
  ]);
  if (!leads || !deals) throw new Error('Zoho credentials not configured — set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN in Railway');
  crmCache = { leads, deals, fetchedAt: new Date().toISOString() };
  console.log(`CRM refreshed: ${leads.length} leads, ${deals.length} deals`);
}

// Boot: load snapshot, then refresh via API if credentials exist
loadDataJson();
if (process.env.ZOHO_CLIENT_ID) {
  refreshCRM().catch(e => console.error('CRM refresh failed:', e.message));
  setInterval(() => refreshCRM().catch(e => console.error('CRM refresh failed:', e.message)), 24 * 60 * 60 * 1000);
}

// ── Routes ───────────────────────────────────────────────
app.get('/api/data', (_req, res) => res.json(crmCache));

app.get('/api/refresh', async (_req, res) => {
  try {
    await refreshCRM();
    res.json(crmCache);
  } catch(e) {
    console.error('CRM refresh failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function shopifyGet(endpoint) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) throw new Error('SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN env vars not set');
  const res = await fetch(`https://${store}/admin/api/2024-01${endpoint}`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Shopify ${res.status}: ${body.substring(0, 200)}`);
  }
  return res.json();
}

app.get('/api/shopify', async (req, res) => {
  try {
    const [ordersData, productsData] = await Promise.all([
      shopifyGet('/orders.json?status=any&limit=250&fields=id,name,created_at,total_price,financial_status,fulfillment_status,line_items,customer'),
      shopifyGet('/products.json?limit=250&fields=id,title,status,variants,vendor,product_type')
    ]);
    res.json({
      orders:   ordersData.orders   || [],
      products: productsData.products || [],
      fetchedAt: new Date().toISOString()
    });
  } catch(e) {
    console.error('Shopify:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname)));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard on port ${PORT}`));
