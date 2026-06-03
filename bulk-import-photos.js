/**
 * Bulk photo import: one photo at a time — read → Collectr → Shopify add OR stock +1.
 * Duplicate check always queries Shopify live (no in-memory listing cache).
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
  ensureHomepageCollections,
  formatShopifyError,
} = require('./shopify');

function getMaxPhotos() {
  const n = parseInt(process.env.BULK_PHOTO_MAX || '100', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 100;
}

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
 * Session state for sequential photo uploads (no listing index — Shopify is queried per photo).
 */
async function createBulkSession(multiplier = 1.0) {
  return {
    multiplier,
    useOpenAi: hasOpenAiKey(),
    added: 0,
    incremented: 0,
    failed: 0,
    processed: 0,
    errors: [],
  };
}

/**
 * Process a single photo in an existing session.
 */
async function processOneImportPhoto(photo, session) {
  const label = photo.filename || `Photo ${session.processed + 1}`;
  const base64 = String(photo.image || '').replace(/^data:[^;]+;base64,/, '');
  const mimeType = photo.mimeType || 'image/jpeg';
  const multiplier = session.multiplier;

  session.processed += 1;
  const current = session.processed;

  const progress = (phase, detail) => ({
    phase,
    current,
    filename: label,
    detail,
    added: session.added,
    incremented: session.incremented,
    failed: session.failed,
  });

  try {
    if (!base64) throw new Error('Empty image data');

    const parsed = await parsePhoto(base64, mimeType, session.useOpenAi);
    console.log(`[BulkPhoto] ${label} parsed (${session.useOpenAi ? 'openai' : 'ocr'}):`, parsed);

    if (!session.useOpenAi && !parsed.cardNumber) {
      throw new Error('Could not read card number from photo (offline OCR)');
    }

    const { cards, searchMethod } = await findOnCollectr(parsed, session.useOpenAi);
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

    const shopResult = await addOrUpdateProduct(card, multiplier);

    if (shopResult.incremented) session.incremented += 1;
    else session.added += 1;

    await sleep(400);

    return {
      ok: true,
      filename: label,
      current,
      title: shopResult.product?.title || card.name,
      wasIncrement: !!shopResult.incremented,
      pickNote: pickNote || undefined,
      progress: [
        progress('parse', `#${parsed.cardNumber || '?'}`),
        progress('collectr', `${card.name}`),
        progress('shopify', shopResult.incremented ? 'Stock +1' : 'Added'),
      ],
      result: {
        cardNumber: card.cardNumber,
        subType: card.subType,
        searchMethod,
      },
    };
  } catch (err) {
    const msg = err.response ? formatShopifyError(err) : err.message;
    console.error(`[BulkPhoto] ${label}:`, msg);
    session.failed += 1;
    session.errors.push({ filename: label, error: msg });
    return {
      ok: false,
      filename: label,
      current,
      error: msg,
      progress: [progress('parse', msg)],
    };
  }
}

async function finishBulkSession(session) {
  try {
    await ensureHomepageCollections();
  } catch (e) {
    console.warn('[BulkPhoto] Homepage collections refresh skipped:', e.message);
  }

  return {
    added: session.added,
    incremented: session.incremented,
    failed: session.failed,
    total: session.processed,
    errors: session.errors,
  };
}

/**
 * Legacy: all photos in one request (still processes one-by-one internally).
 */
async function bulkImportPhotos(photos, multiplier = 1.0, onProgress) {
  const emit = (payload) => {
    if (typeof onProgress === 'function') onProgress(payload);
  };

  const maxPhotos = getMaxPhotos();
  if (!photos?.length) {
    throw new Error('Send at least one photo.');
  }
  if (photos.length > maxPhotos) {
    throw new Error(`Bulk photo import limited to ${maxPhotos} images per batch.`);
  }

  const session = await createBulkSession(multiplier);
  emit({ type: 'start', total: photos.length });

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    emit({
      type: 'progress',
      current: i + 1,
      total: photos.length,
      filename: photo.filename,
      phase: 'parse',
      added: session.added,
      incremented: session.incremented,
      failed: session.failed,
    });

    const row = await processOneImportPhoto(photo, session);
    emit({
      type: 'item',
      current: i + 1,
      total: photos.length,
      filename: row.filename,
      ok: row.ok,
      title: row.title,
      error: row.error,
      wasIncrement: row.wasIncrement,
      added: session.added,
      incremented: session.incremented,
      failed: session.failed,
    });
  }

  const results = await finishBulkSession(session);
  emit({ type: 'done', total: photos.length, ...results });
  return results;
}

module.exports = {
  bulkImportPhotos,
  createBulkSession,
  processOneImportPhoto,
  finishBulkSession,
  getMaxPhotos,
};
