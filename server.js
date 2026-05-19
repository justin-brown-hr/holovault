/**
 * server.js
 * Reads ALL config from environment variables.
 * Use .env file for local dev, Railway Variables for production.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { searchCards, closeBrowser } = require('./collectr');
const { createProduct, getManagedProducts, setMultiplier, deleteProduct } = require('./shopify');
const { syncAllPrices } = require('./sync-prices');

function getConfig() {
  return {
    shopify: {
      store: process.env.SHOPIFY_STORE || '',
      accessToken: process.env.SHOPIFY_TOKEN || '',
      apiVersion: process.env.SHOPIFY_API_VERSION || '2024-04',
    },
    sync: {
      defaultMultiplier: parseFloat(process.env.DEFAULT_MULTIPLIER || '1.0'),
      cronSchedule: process.env.CRON_SCHEDULE || '0 6 * * *',
    },
  };
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Middleware ────────────────────────────────────────────────────────────────

function requireToken(req, res, next) {
  const { shopify } = getConfig();
  if (!shopify.accessToken) {
    return res.status(401).json({ error: 'SHOPIFY_TOKEN env var not set.' });
  }
  next();
}

// ── API Routes ────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const { shopify } = getConfig();
  res.json({ connected: !!shopify.accessToken, store: shopify.store });
});

app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (query.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters.' });

  console.log(`[Search] Querying Collectr for: "${query}"`);
  console.log(`[Search] URL: https://app.getcollectr.com/?query=${encodeURIComponent(query)}`);

  try {
    const cards = await searchCards(query);
    console.log(`[Search] Found ${cards.length} results for "${query}"`);
    res.json({ cards });
  } catch (err) {
    console.error('[Search] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/add-card', requireToken, async (req, res) => {
  const { card, multiplier } = req.body;
  const { sync, shopify } = getConfig();

  if (!card || !card.name) return res.status(400).json({ error: 'Card data is required.' });

  const mult = parseFloat(multiplier) || sync.defaultMultiplier;

  try {
    const product = await createProduct(card, mult);
    const storeHandle = shopify.store.replace('.myshopify.com', '');
    res.json({
      success: true,
      product: {
        id: product.id,
        title: product.title,
        price: product.variants[0]?.price,
        shopifyUrl: `https://admin.shopify.com/store/${storeHandle}/products/${product.id}`,
      },
    });
  } catch (err) {
    console.error('Add card error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products', requireToken, async (req, res) => {
  try {
    const products = await getManagedProducts();
    res.json({ products });
  } catch (err) {
    console.error('Products error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', requireToken, async (req, res) => {
  const { id } = req.params;
  try {
    await deleteProduct(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/products/:id/multiplier', requireToken, async (req, res) => {
  const { id } = req.params;
  const { multiplier } = req.body;
  if (!multiplier || isNaN(parseFloat(multiplier))) return res.status(400).json({ error: 'Valid multiplier required.' });

  try {
    await setMultiplier(id, parseFloat(multiplier));
    res.json({ success: true, multiplier: parseFloat(multiplier) });
  } catch (err) {
    console.error('Multiplier error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sync', requireToken, async (req, res) => {
  res.json({ success: true, message: 'Sync started. Check server logs.' });
  try {
    await syncAllPrices();
  } catch (err) {
    console.error('Sync error:', err.message);
  }
});

// ── Cron ──────────────────────────────────────────────────────────────────────

const { sync } = getConfig();
cron.schedule(sync.cronSchedule, async () => {
  console.log(`[CRON] Price sync started at ${new Date().toISOString()}`);
  try {
    await syncAllPrices();
  } catch (err) {
    console.error('[CRON] Sync failed:', err.message);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const { shopify, sync: s } = getConfig();
  console.log(`\nHolo Vault Price Sync running at http://localhost:${PORT}`);
  console.log(`Shopify store: ${shopify.store}`);
  if (!shopify.accessToken) {
    console.log('⚠️  SHOPIFY_TOKEN not set. Add it to your .env file or Railway Variables.');
  } else {
    console.log('✓ Shopify token found — ready to go.');
    console.log(`Daily sync scheduled: ${s.cronSchedule}`);
  }
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await closeBrowser();
  process.exit(0);
});
