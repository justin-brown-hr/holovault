/**
 * sync-prices.js
 * Fetches latest prices from Collectr for all managed products
 * and updates them in Shopify.
 *
 * Run manually:  node sync-prices.js
 * Or scheduled via server.js cron (runs daily at 6am)
 */

const { searchCards, getCardDetails, closeBrowser } = require('./collectr');
const { getManagedProducts, updateProductPrice } = require('./shopify');

async function syncAllPrices() {
  console.log(`[${new Date().toISOString()}] Starting price sync...`);

  let products;
  try {
    products = await getManagedProducts();
    console.log(`Found ${products.length} managed products to sync.`);
  } catch (err) {
    console.error('Failed to fetch managed products from Shopify:', err.message);
    process.exit(1);
  }

  if (products.length === 0) {
    console.log('No managed products found. Add cards via the admin UI first.');
    return;
  }

  const results = { success: 0, failed: 0, errors: [] };

  for (const product of products) {
    try {
      console.log(`Syncing: ${product.title}`);

      let freshCard = null;

      // Prefer fetching by Collectr URL (most accurate)
      if (product.collectrUrl) {
        freshCard = await getCardDetails(product.collectrUrl);
      }

      // Fallback: search by title
      if (!freshCard && product.title) {
        const searchResults = await searchCards(product.title);
        if (searchResults.length > 0) {
          // Pick the best match (first result)
          freshCard = searchResults[0];
        }
      }

      if (!freshCard || freshCard.price === 0) {
        throw new Error('Could not fetch price from Collectr');
      }

      const newPrice = await updateProductPrice(
        product.productId,
        product.variantId,
        freshCard,
        product.multiplier
      );

      console.log(`  ✓ ${product.title}: $${newPrice} (market: $${freshCard.price}, multiplier: ${product.multiplier}x)`);
      results.success++;

      // Small delay to avoid hammering Collectr
      await sleep(1500);
    } catch (err) {
      console.error(`  ✗ ${product.title}: ${err.message}`);
      results.failed++;
      results.errors.push({ product: product.title, error: err.message });
    }
  }

  await closeBrowser();

  console.log(`\nSync complete: ${results.success} updated, ${results.failed} failed.`);
  if (results.errors.length > 0) {
    console.log('Errors:');
    results.errors.forEach((e) => console.log(`  - ${e.product}: ${e.error}`));
  }

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
