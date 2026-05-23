/**
 * sync-prices.js
 * Fetches latest prices from Collectr for all managed products
 * and updates them in Shopify.
 *
 * Run manually:  node sync-prices.js
 * Or scheduled via server.js cron (runs daily at 6am)
 */

const { resolveCardForSync, closeBrowser } = require('./collectr');
const { getManagedProducts, updateProductPrice } = require('./shopify');

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
    emit({ type: 'done', success: 0, failed: 0, errors: [], total: 0 });
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
      updated: results.success,
      failed: results.failed,
    });

    try {
      console.log(`Syncing: ${product.title}`);

      const freshCard = await resolveCardForSync({
        collectrId: product.collectrId,
        collectrUrl: product.collectrUrl,
        title: product.title,
        subType: product.subType,
      });

      if (!freshCard || freshCard.price === 0) {
        throw new Error(
          'Could not fetch price from Collectr (wrong variant or missing collectr_id — re-add card from search)'
        );
      }

      emit({
        type: 'progress',
        current,
        total,
        title: product.title,
        phase: 'shopify',
        updated: results.success,
        failed: results.failed,
      });

      const newPrice = await updateProductPrice(
        product.productId,
        product.variantId,
        freshCard,
        product.multiplier
      );

      console.log(`  ✓ ${product.title}: $${newPrice} (market: $${freshCard.price}, multiplier: ${product.multiplier}x)`);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run directly if called as a script
if (require.main === module) {
  syncAllPrices()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Sync failed:', err);
      process.exit(1);
    });
}

module.exports = { syncAllPrices };
