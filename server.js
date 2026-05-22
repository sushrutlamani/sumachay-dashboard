require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();

// ── CRM data from Zoho API ───────────────────────────────
let crmCache = { leads: [], deals: [], fetchedAt: null };

async function getZohoAccessToken() {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
  });
  const res = await fetch(process.env.ZOHO_TOKEN_URL, { method: 'POST', body: params });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Zoho token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function zohoGetAll(token, module) {
  const base = process.env.ZOHO_API_BASE;
  let page = 1, records = [];
  while (true) {
    const res = await fetch(`${base}/${module}?per_page=200&page=${page}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const data = await res.json();
    if (!data.data || data.data.length === 0) break;
    records = records.concat(data.data);
    if (!data.info?.more_records) break;
    page++;
  }
  return records;
}

async function fetchCrmData() {
  try {
    const token = await getZohoAccessToken();
    const [leads, deals] = await Promise.all([
      zohoGetAll(token, 'Leads'),
      zohoGetAll(token, 'Deals'),
    ]);
    crmCache = { leads, deals, fetchedAt: new Date().toISOString() };
    console.log(`CRM: fetched ${leads.length} leads, ${deals.length} deals from Zoho`);
  } catch(e) {
    console.error('CRM: Zoho fetch failed:', e.message);
  }
}

fetchCrmData();
setInterval(fetchCrmData, 15 * 60 * 1000); // refresh every 15 min

// ── Zoho Inventory ───────────────────────────────────────
let inventoryCache = { items: [], salesOrders: [], purchaseOrders: [], fetchedAt: null };

async function getInventoryToken() {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     process.env.ZOHO_INVENTORY_CLIENT_ID,
    client_secret: process.env.ZOHO_INVENTORY_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_INVENTORY_REFRESH_TOKEN,
  });
  const res = await fetch(process.env.ZOHO_TOKEN_URL, { method: 'POST', body: params });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Inventory token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function inventoryGetAll(token, endpoint, key) {
  const base = process.env.ZOHO_INVENTORY_BASE;
  let page = 1, records = [];
  while (true) {
    const res = await fetch(`${base}/${endpoint}?per_page=200&page=${page}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const data = await res.json();
    if (!data[key] || data[key].length === 0) break;
    records = records.concat(data[key]);
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return records;
}

async function fetchInventoryData() {
  try {
    const token = await getInventoryToken();
    const [items, salesOrders, purchaseOrders] = await Promise.all([
      inventoryGetAll(token, 'items',          'items'),
      inventoryGetAll(token, 'salesorders',    'salesorders'),
      inventoryGetAll(token, 'purchaseorders', 'purchaseorders'),
    ]);
    inventoryCache = { items, salesOrders, purchaseOrders, fetchedAt: new Date().toISOString() };
    console.log(`Inventory: ${items.length} items, ${salesOrders.length} sales orders, ${purchaseOrders.length} POs`);
  } catch(e) {
    console.error('Inventory fetch failed:', e.message);
  }
}

fetchInventoryData();
setInterval(fetchInventoryData, 15 * 60 * 1000);

// ── Shopify order history for velocity (2 years) ─────────
let velocityOrders = [];

function parseNextUrl(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

async function fetchShopifyOrderHistory() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) return;
  try {
    const since = new Date();
    since.setFullYear(since.getFullYear() - 2);
    let url = `https://${store}/admin/api/2024-01/orders.json?status=any&limit=250&created_at_min=${since.toISOString()}&fields=created_at,line_items`;
    let orders = [], pages = 0;
    while (url) {
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      const data = await res.json();
      if (data.orders?.length) orders = orders.concat(data.orders);
      url = parseNextUrl(res.headers.get('link'));
      pages++;
    }
    velocityOrders = orders;
    console.log(`Shopify history: ${orders.length} orders (${pages} pages, 2yr)`);
  } catch(e) {
    console.error('Shopify history fetch failed:', e.message);
  }
}

fetchShopifyOrderHistory();
setInterval(fetchShopifyOrderHistory, 6 * 60 * 60 * 1000); // refresh every 6hr

// ── Routes ───────────────────────────────────────────────
app.get('/api/data',      (_req, res) => res.json(crmCache));
app.get('/api/inventory', (_req, res) => res.json({ ...inventoryCache, velocityOrders }));

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
