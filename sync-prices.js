/**
 * sync-prices.js
 * Fetches latest prices from Collectr for all managed products
 * and updates them in Shopify.
 *
 * Run manually:  node sync-prices.js
 * Or scheduled via server.js cron (runs daily at 6am)
 */

const { resolveCardForSync, closeBrowser } = require('./collectr');
const { getManagedProducts, updateProductPrice, ensureProductCardFields } = require('./shopify');

async function syncOneProduct(product, emit) {
  const log = (payload) => {
    if (typeof emit === 'function') emit(payload);
  };

  product = await ensureProductCardFields(product);

  if (!product.cardNumber) {
    throw new Error(
      'Missing card number — add "Number: 125/159" in the product description or re-add from Collectr'
    );
  }
  if (!product.subType) {
    throw new Error(
      'Missing finish — add "Finish: Normal" in the description, include " — Normal" in the title, or re-add from Collectr'
    );
  }

  log({
    type: 'progress',
    title: product.title,
    phase: 'collectr',
    detail: `Finding #${product.cardNumber} · ${product.subType}`,
  });

  const freshCard = await resolveCardForSync({
    collectrId: product.collectrId,
    collectrUrl: product.collectrUrl,
    title: product.title,
    subType: product.subType,
    cardNumber: product.cardNumber,
  });

  if (!freshCard || freshCard.price === 0) {
    throw new Error(
      `No Collectr price for #${product.cardNumber} · ${product.subType} — check number and finish match Collectr`
    );
  }

  log({ type: 'progress', title: product.title, phase: 'shopify' });

  const newPrice = await updateProductPrice(
    product.productId,
    product.variantId,
    freshCard,
    product.multiplier
  );

  console.log(
    `  ✓ ${product.title}: $${newPrice} (#${product.cardNumber} ${product.subType}, market $${freshCard.price})`
  );

  return { newPrice, freshCard };
}

async function syncAllPrices(onProgress) {
  const emit = (payload) => {
    if (typeof onProgress === 'function') onProgress(payload);
  };

  console.log(`[${new Date().toISOString()}] Starting price sync...`);
  emit({ type: 'phase', message: 'Loading products from Shopify…' });

  let products;
  try {
    products = await getManagedProducts();
    console.log(`Found ${products.length} managed products to sync.`);
  } catch (err) {
    console.error('Failed to fetch managed products from Shopify:', err.message);
    if (require.main === module) process.exit(1);
    throw err;
  }

  if (products.length === 0) {
    console.log('No managed products found. Add cards via the admin UI first.');
    emit({ type: 'done', total: 0, updated: 0, failed: 0, errors: [] });
    return { success: 0, failed: 0, errors: [] };
  }

  const total = products.length;
  const results = { success: 0, failed: 0, errors: [] };
  emit({ type: 'start', total });

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const current = i + 1;

    emit({
      type: 'progress',
      current,
      total,
      title: product.title,
      phase: 'collectr',
      detail: product.cardNumber
        ? `#${product.cardNumber} · ${product.subType || '?'}`
        : 'missing card number',
      updated: results.success,
      failed: results.failed,
    });

    try {
      console.log(`Syncing: ${product.title} (#${product.cardNumber || '?'} · ${product.subType || '?'})`);

      const { newPrice } = await syncOneProduct(product, emit);

      results.success++;

      emit({
        type: 'item',
        current,
        total,
        title: product.title,
        ok: true,
        price: newPrice,
        updated: results.success,
        failed: results.failed,
      });

      await sleep(1500);
    } catch (err) {
      console.error(`  ✗ ${product.title}: ${err.message}`);
      results.failed++;
      results.errors.push({ product: product.title, error: err.message });

      emit({
        type: 'item',
        current,
        total,
        title: product.title,
        ok: false,
        error: err.message,
        updated: results.success,
        failed: results.failed,
      });
    }
  }

  await closeBrowser();

  console.log(`\nSync complete: ${results.success} updated, ${results.failed} failed.`);
  if (results.errors.length > 0) {
    console.log('Errors:');
    results.errors.forEach((e) => console.log(`  - ${e.product}: ${e.error}`));
  }

  emit({ type: 'done', total, updated: results.success, failed: results.failed, errors: results.errors });
  return results;
}

async function syncProductById(productId) {
  const products = await getManagedProducts();
  const product = products.find((p) => String(p.productId) === String(productId));
  if (!product) throw new Error('Managed product not found');
  const { newPrice, freshCard } = await syncOneProduct(product);
  await closeBrowser();
  return { product, newPrice, freshCard };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  syncAllPrices()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Sync failed:', err);
      process.exit(1);
    });
}

module.exports = { syncAllPrices, syncOneProduct, syncProductById };
