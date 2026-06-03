/**
 * Bulk photo import: read photo → Collectr match → Shopify add OR stock +1.
 * Fails only when Collectr cannot be matched (missing from Shopify creates a new listing).
 */

const {
  hasOpenAiKey,
  parseCardImage,
  searchCollectrFromParsed,
  pickCardForBulkImport,
} = require('./card-vision');
const { parseCardFromImageOffline } = require('./local-ocr');
const { searchCards } = require('./collectr');
const {
  addOrUpdateProduct,
  buildListingIndex,
  getManagedProductsCached,
  ensureHomepageCollections,
  invalidateManagedProductsCache,
  formatShopifyError,
  listingKey,
} = require('./shopify');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parsePhoto(base64, mimeType, useOpenAi) {
  if (useOpenAi) {
    return parseCardImage(base64, mimeType);
  }
  const offline = await parseCardFromImageOffline(base64, mimeType);
  return {
    name: '',
    cardNumber: offline.cardNumber || '',
    setName: '',
    subType: '',
    language: 'other',
    confidence: offline.confidence,
  };
}

async function findOnCollectr(parsed, useOpenAi) {
  if (useOpenAi) {
    const r = await searchCollectrFromParsed(parsed);
    return { cards: r.cards, searchMethod: r.searchMethod };
  }
  if (!parsed.cardNumber) {
    return { cards: [], searchMethod: null };
  }
  const cards = await searchCards(parsed.cardNumber);
  return { cards, searchMethod: 'card_number' };
}

/**
 * @param {Array<{filename?: string, image: string, mimeType?: string}>} photos
 * @param {number} multiplier
 * @param {function} onProgress — SSE events (start, progress, item, done)
 */
async function bulkImportPhotos(photos, multiplier = 1.0, onProgress) {
  const emit = (payload) => {
    if (typeof onProgress === 'function') onProgress(payload);
  };

  const maxPhotos = parseInt(process.env.BULK_PHOTO_MAX || '25', 10);
  const maxPhotosOcr = parseInt(process.env.BULK_PHOTO_OCR_MAX || '10', 10);
  if (!photos?.length) {
    throw new Error('Send at least one photo.');
  }
  if (photos.length > maxPhotos) {
    throw new Error(`Bulk photo import limited to ${maxPhotos} images per batch.`);
  }

  const useOpenAi = hasOpenAiKey();
  if (!useOpenAi && photos.length > maxPhotosOcr) {
    throw new Error(
      `Bulk photo import without OpenAI is limited to ${maxPhotosOcr} images per batch.`
    );
  }

  let listingIndex = null;
  try {
    const managed = await getManagedProductsCached();
    listingIndex = buildListingIndex(managed);
  } catch (e) {
    console.warn('[BulkPhoto] Could not preload Shopify listings:', e.message);
  }

  const total = photos.length;
  const results = { added: 0, incremented: 0, failed: 0, total, errors: [] };
  emit({ type: 'start', total });

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const current = i + 1;
    const label = photo.filename || `Photo ${current}`;
    const base64 = String(photo.image || '').replace(/^data:[^;]+;base64,/, '');
    const mimeType = photo.mimeType || 'image/jpeg';

    emit({
      type: 'progress',
      current,
      total,
      filename: label,
      phase: 'parse',
      added: results.added,
      incremented: results.incremented,
      failed: results.failed,
    });

    try {
      if (!base64) throw new Error('Empty image data');

      const parsed = await parsePhoto(base64, mimeType, useOpenAi);
      console.log(`[BulkPhoto] ${label} parsed (${useOpenAi ? 'openai' : 'ocr'}):`, parsed);

      if (!useOpenAi && !parsed.cardNumber) {
        throw new Error('Could not read card number from photo (offline OCR)');
      }

      emit({
        type: 'progress',
        current,
        total,
        filename: label,
        phase: 'collectr',
        detail: `#${parsed.cardNumber || '?'}${parsed.name ? ` · ${parsed.name}` : ''}`,
        added: results.added,
        incremented: results.incremented,
        failed: results.failed,
      });

      const { cards, searchMethod } = await findOnCollectr(parsed, useOpenAi);
      if (!cards?.length) {
        throw new Error('No match on Collectr — check card number or try a clearer photo');
      }

      const { card, reason: pickNote } = pickCardForBulkImport(cards, parsed);
      if (!card) {
        throw new Error(pickNote || 'No matching Collectr listing');
      }

      if (pickNote) {
        console.warn(`[BulkPhoto] ${label}: ${pickNote}`);
      }

      emit({
        type: 'progress',
        current,
        total,
        filename: label,
        phase: 'shopify',
        detail: `${card.name} · ${card.subType || ''}`,
        added: results.added,
        incremented: results.incremented,
        failed: results.failed,
      });

      const shopResult = await addOrUpdateProduct(card, multiplier, { listingIndex });

      if (listingIndex && card.collectrId) {
        const key = listingKey(card.collectrId, card.subType);
        listingIndex.set(key, {
          productId: shopResult.product?.id,
          variantId: shopResult.product?.variants?.[0]?.id,
          title: shopResult.product?.title || card.name,
          collectrId: String(card.collectrId),
          subType: card.subType,
          inventoryQuantity: shopResult.quantity,
        });
      }

      if (shopResult.incremented) results.incremented++;
      else results.added++;

      emit({
        type: 'item',
        current,
        total,
        filename: label,
        ok: true,
        title: shopResult.product?.title || card.name,
        subType: card.subType,
        cardNumber: card.cardNumber,
        searchMethod,
        wasIncrement: !!shopResult.incremented,
        pickNote: pickNote || undefined,
        added: results.added,
        incremented: results.incremented,
        failed: results.failed,
      });

      await sleep(800);
    } catch (err) {
      const msg = err.response ? formatShopifyError(err) : err.message;
      console.error(`[BulkPhoto] ${label}:`, msg);
      results.failed++;
      results.errors.push({ filename: label, error: msg });

      emit({
        type: 'item',
        current,
        total,
        filename: label,
        ok: false,
        error: msg,
        added: results.added,
        incremented: results.incremented,
        failed: results.failed,
      });
    }
  }

  try {
    await ensureHomepageCollections();
    invalidateManagedProductsCache();
  } catch (e) {
    console.warn('[BulkPhoto] Homepage collections refresh skipped:', e.message);
  }

  emit({
    type: 'done',
    total,
    added: results.added,
    incremented: results.incremented,
    failed: results.failed,
    errors: results.errors,
  });

  return results;
}

module.exports = { bulkImportPhotos };
