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
const {
  addOrUpdateProduct,
  bulkAddCards,
  getManagedProductsCached,
  invalidateManagedProductsCache,
  setMultiplier,
  deleteProduct,
  deleteAllManagedProducts,
  formatShopifyError,
  hasShopifyCredentials,
  getAuthMode,
  getAuthStatus,
  ensureAccessToken,
} = require('./shopify');
const { syncAllPrices, syncProductById } = require('./sync-prices');
const { hasOpenAiKey, searchByCardImage } = require('./card-vision');
const { bulkImportPhotos } = require('./bulk-import-photos');

function getConfig() {
  return {
    shopify: {
      store: process.env.SHOPIFY_STORE || '',
      authMode: getAuthMode(),
      apiVersion: process.env.SHOPIFY_API_VERSION || '2024-04',
    },
    sync: {
      defaultMultiplier: parseFloat(process.env.DEFAULT_MULTIPLIER || '1.0'),
      cronSchedule: process.env.CRON_SCHEDULE || '0 6 * * *',
    },
  };
}

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Middleware ────────────────────────────────────────────────────────────────

function requireToken(req, res, next) {
  if (!hasShopifyCredentials()) {
    return res.status(401).json({
      error:
        'Shopify credentials missing. Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (auto-refresh), or SHOPIFY_TOKEN.',
    });
  }
  next();
}

// ── API Routes ────────────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  const { shopify } = getConfig();
  const connected = hasShopifyCredentials();
  let auth = getAuthStatus();
  if (connected) {
    try {
      await ensureAccessToken();
      auth = getAuthStatus();
    } catch (err) {
      return res.status(500).json({ connected: false, store: shopify.store, error: err.message });
    }
  }
  res.json({
    connected,
    store: shopify.store,
    authMode: shopify.authMode,
    scopes: auth.scopes,
    tokenExpiresAt: auth.expiresAt,
    tokenExpiresInHours: auth.expiresInHours,
    imageSearch: hasOpenAiKey(),
  });
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

app.post('/api/search-image', async (req, res) => {
  const { image, mimeType } = req.body || {};
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'Upload an image (base64 in JSON body).' });
  }
  if (!hasOpenAiKey()) {
    return res.status(503).json({
      error: 'OPENAI_API_KEY missing — add your key to .env and restart the app.',
    });
  }

  const clean = image.replace(/^data:[^;]+;base64,/, '');

  try {
    const { cards, parsed, searchMethod, queriesTried } = await searchByCardImage(
      clean,
      mimeType || 'image/jpeg'
    );
    res.json({ cards, parsed, searchMethod, queriesTried });
  } catch (err) {
    console.error('[ImageSearch] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/add-card', requireToken, async (req, res) => {
  const { card, multiplier } = req.body;
  const { sync, shopify } = getConfig();

  if (!card || !card.name) return res.status(400).json({ error: 'Card data is required.' });

  const mult = parseFloat(multiplier) || sync.defaultMultiplier;

  try {
    const result = await addOrUpdateProduct(card, mult);
    const product = result.product;
    const storeHandle = shopify.store.replace('.myshopify.com', '');
    res.json({
      success: true,
      incremented: result.incremented,
      quantity: result.quantity,
      warning: result.warning || null,
      product: {
        id: product.id,
        title: product.title,
        price: result.price || product.variants[0]?.price,
        quantity: result.quantity,
        shopifyUrl: `https://admin.shopify.com/store/${storeHandle}/products/${product.id}`,
      },
    });
  } catch (err) {
    const shopifyDetail = err.response?.data;
    console.error('Add card error:', err.message, shopifyDetail || '');
    res.status(500).json({
      error: formatShopifyError(err),
      status: err.response?.status || null,
      shopify: shopifyDetail || null,
    });
  }
});

app.post('/api/bulk-import-photos', requireToken, async (req, res) => {
  const { photos, multiplier } = req.body || {};
  const { sync } = getConfig();
  const mult = parseFloat(multiplier) || sync.defaultMultiplier;
  const useStream =
    req.query.stream === '1' || String(req.headers.accept || '').includes('text/event-stream');

  if (!hasOpenAiKey()) {
    return res.status(503).json({
      error: 'OPENAI_API_KEY missing — add your key to .env and restart the app.',
    });
  }

  if (!Array.isArray(photos) || photos.length === 0) {
    return res.status(400).json({ error: 'Send { photos: [{ image, mimeType, filename }] }.' });
  }

  if (!useStream) {
    try {
      const results = await bulkImportPhotos(photos, mult);
      res.json({ success: true, ...results });
    } catch (err) {
      console.error('Bulk photo import error:', err.message);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  try {
    await bulkImportPhotos(photos, mult, (event) => writeSse(res, event));
  } catch (err) {
    console.error('Bulk photo stream error:', err.message);
    writeSse(res, { type: 'error', error: err.message });
  }
  res.end();
});

app.post('/api/bulk-add', requireToken, async (req, res) => {
  const { cards, multiplier, onlyNew } = req.body;
  const { sync } = getConfig();

  if (!Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ error: 'Send { cards: [...] } with at least one card from search results.' });
  }

  const mult = parseFloat(multiplier) || sync.defaultMultiplier;

  try {
    const results = await bulkAddCards(cards, mult, { onlyNew: !!onlyNew });
    res.json({ success: true, ...results });
  } catch (err) {
    console.error('Bulk add error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products', requireToken, async (req, res) => {
  try {
    const products = await getManagedProductsCached();
    res.json({ products });
  } catch (err) {
    console.error('Products error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products/delete-all', requireToken, async (req, res) => {
  if (req.body?.confirm !== 'DELETE ALL') {
    return res.status(400).json({
      error: 'Send { "confirm": "DELETE ALL" } to permanently remove all collectr-managed products.',
    });
  }

  try {
    const results = await deleteAllManagedProducts();
    res.json({ success: true, ...results });
  } catch (err) {
    console.error('Delete all error:', err.message);
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

app.post('/api/products/:id/sync', requireToken, async (req, res) => {
  const { id } = req.params;
  try {
    invalidateManagedProductsCache();
    const { newPrice, freshCard, product } = await syncProductById(id);
    res.json({
      success: true,
      price: newPrice,
      marketPrice: freshCard.price,
      cardNumber: product.cardNumber,
      subType: product.subType,
    });
  } catch (err) {
    console.error('Sync one error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function writeSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const syncJobs = new Map();
let activeSyncJobId = null;

function createSyncJob() {
  const id = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const job = {
    id,
    status: 'running',
    phase: 'starting',
    message: 'Starting…',
    total: 0,
    current: 0,
    updated: 0,
    failed: 0,
    detail: '',
    errors: [],
    startedAt: now,
    finishedAt: null,
  };
  syncJobs.set(id, job);
  activeSyncJobId = id;
  return job;
}

function applySyncEvent(job, evt) {
  if (!evt || !job) return;
  if (evt.type === 'phase') {
    job.message = evt.message || job.message;
    job.phase = 'phase';
    return;
  }
  if (evt.type === 'start') {
    job.total = evt.total || 0;
    job.current = 0;
    job.updated = 0;
    job.failed = 0;
    job.phase = 'running';
    job.message = `Syncing ${job.total} products…`;
    return;
  }
  if (evt.type === 'progress') {
    if (evt.current != null) job.current = evt.current;
    if (evt.total != null) job.total = evt.total;
    if (evt.updated != null) job.updated = evt.updated;
    if (evt.failed != null) job.failed = evt.failed;
    if (evt.phase) job.phase = evt.phase;
    job.message =
      evt.current != null && evt.total != null
        ? `Card ${evt.current} of ${evt.total}`
        : job.message;
    job.detail = evt.detail || evt.title || '';
    return;
  }
  if (evt.type === 'item') {
    if (evt.current != null) job.current = evt.current;
    if (evt.total != null) job.total = evt.total;
    if (evt.updated != null) job.updated = evt.updated;
    if (evt.failed != null) job.failed = evt.failed;
    if (!evt.ok) {
      job.errors.push({
        product: evt.title || 'Product',
        error: evt.error || 'Sync failed',
      });
    }
    job.detail = evt.ok
      ? `✓ ${evt.title || ''}${evt.price ? ` → $${evt.price}` : ''}`.trim()
      : `✗ ${evt.title || ''}: ${evt.error || 'Sync failed'}`.trim();
    return;
  }
  if (evt.type === 'done') {
    job.status = 'done';
    job.phase = 'done';
    job.total = evt.total || job.total;
    job.updated = evt.updated ?? evt.success ?? job.updated;
    job.failed = evt.failed ?? job.failed;
    job.errors = Array.isArray(evt.errors) ? evt.errors : job.errors;
    job.message = `Done — ${job.updated} updated, ${job.failed} failed`;
    job.detail = '';
    job.finishedAt = new Date().toISOString();
  }
}

function startSyncJob() {
  const job = createSyncJob();
  (async () => {
    try {
      await syncAllPrices((evt) => applySyncEvent(job, evt));
      if (job.status !== 'done') {
        job.status = 'done';
        job.phase = 'done';
        job.finishedAt = new Date().toISOString();
      }
    } catch (err) {
      console.error('Sync job error:', err.message);
      job.status = 'failed';
      job.phase = 'failed';
      job.message = err.message || 'Sync failed';
      job.errors.push({ product: 'Sync job', error: job.message });
      job.finishedAt = new Date().toISOString();
    } finally {
      if (activeSyncJobId === job.id) activeSyncJobId = null;
    }
  })();
  return job;
}

app.post('/api/sync/start', requireToken, async (req, res) => {
  if (activeSyncJobId) {
    const running = syncJobs.get(activeSyncJobId);
    if (running && running.status === 'running') {
      return res.status(409).json({
        success: false,
        error: 'A sync is already running.',
        jobId: running.id,
        job: running,
      });
    }
  }
  const job = startSyncJob();
  res.json({ success: true, jobId: job.id, job });
});

app.get('/api/sync/status/:id', requireToken, async (req, res) => {
  const job = syncJobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Sync job not found' });
  }
  res.json({ success: true, job });
});

app.post('/api/sync', requireToken, async (req, res) => {
  try {
    const results = await syncAllPrices();
    res.json({
      success: true,
      updated: results.success,
      failed: results.failed,
      errors: results.errors,
    });
  } catch (err) {
    console.error('Sync error:', err.message);
    res.status(500).json({ success: false, error: err.message });
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
app.listen(PORT, async () => {
  invalidateManagedProductsCache();
  const { shopify, sync: s } = getConfig();
  console.log(`\nHolo Vault Price Sync running at http://localhost:${PORT}`);
  console.log(`Shopify store: ${shopify.store}`);
  console.log('Sync: reads card # / finish from metafields or product description (v2)');
  if (!hasShopifyCredentials()) {
    console.log(
      '⚠️  Shopify credentials missing. Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (or SHOPIFY_TOKEN) in .env / Railway.'
    );
  } else {
    try {
      await ensureAccessToken();
      const auth = getAuthStatus();
      if (auth.mode === 'client_credentials') {
        console.log(`✓ Shopify auth: client credentials (auto-refresh), scopes: ${auth.scopes || '—'}`);
        if (auth.expiresInHours != null) {
          console.log(`  Token valid ~${auth.expiresInHours}h (refreshes automatically before expiry)`);
        }
      } else {
        console.log('✓ Shopify auth: static SHOPIFY_TOKEN');
      }
      console.log(`Daily sync scheduled: ${s.cronSchedule}`);
    } catch (err) {
      console.log('⚠️  Shopify auth failed:', err.message);
    }
  }
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await closeBrowser();
  process.exit(0);
});
