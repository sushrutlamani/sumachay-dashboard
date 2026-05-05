const express = require('express');
const path    = require('path');
const app     = express();

app.get('/api/data', (req, res) => {
  res.sendFile(path.join(__dirname, 'data.json'));
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
