/**
 * bulk-import-photos.js
 * Bulk upload card photos → OpenAI read → Collectr match → Shopify add.
 */

const { hasOpenAiKey, parseCardImage, searchCollectrFromParsed, pickAutoCollectrCard } = require('./card-vision');
const { parseCardFromImageOffline } = require('./local-ocr');
const { searchCards } = require('./collectr');
const { cardNumbersMatch } = require('./collectr-match');
const { addOrUpdateProduct, formatShopifyError } = require('./shopify');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Array<{filename?: string, image: string, mimeType?: string}>} photos
 * @param {number} multiplier
 * @param {function} onProgress
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
  if (!hasOpenAiKey() && photos.length > maxPhotosOcr) {
    throw new Error(`Bulk photo import without OpenAI is limited to ${maxPhotosOcr} images per batch.`);
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

      let parsed;
      let cards;
      let searchMethod = null;
      let card = null;
      let reason = null;

      if (hasOpenAiKey()) {
        parsed = await parseCardImage(base64, mimeType);
        console.log(`[BulkPhoto] ${label} parsed (openai):`, parsed);

        emit({
          type: 'progress',
          current,
          total,
          filename: label,
          phase: 'collectr',
          detail: `#${parsed.cardNumber || '?'} · ${parsed.name || '?'}`,
          added: results.added,
          incremented: results.incremented,
          failed: results.failed,
        });

        const r = await searchCollectrFromParsed(parsed);
        cards = r.cards;
        searchMethod = r.searchMethod;
        const picked = pickAutoCollectrCard(cards, parsed);
        card = picked.card;
        reason = picked.reason;
      } else {
        const offline = await parseCardFromImageOffline(base64, mimeType);
        parsed = {
          name: '',
          cardNumber: offline.cardNumber || '',
          setName: '',
          subType: '',
          language: 'other',
          confidence: offline.confidence,
        };
        console.log(`[BulkPhoto] ${label} parsed (ocr):`, parsed, offline.cardNumbers);

        if (!parsed.cardNumber) {
          throw new Error('Could not read card number from photo (offline OCR)');
        }

        emit({
          type: 'progress',
          current,
          total,
          filename: label,
          phase: 'collectr',
          detail: `#${parsed.cardNumber}`,
          added: results.added,
          incremented: results.incremented,
          failed: results.failed,
        });

        cards = await searchCards(parsed.cardNumber);
        searchMethod = 'card_number';
        const byNum = (cards || []).filter((c) => cardNumbersMatch(c.cardNumber, parsed.cardNumber));
        if (byNum.length === 1) {
          card = byNum[0];
        } else if (byNum.length === 0) {
          reason = 'No Collectr match for this card number';
        } else {
          reason = `${byNum.length} matches for this number (different finishes) — needs OpenAI or manual search`;
        }
      }

      if (!card) {
        throw new Error(reason || 'No matching Collectr listing');
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

      const shopResult = await addOrUpdateProduct(card, multiplier);

      if (shopResult.incremented) results.incremented++;
      else results.added++;

      emit({
        type: 'item',
        current,
        total,
        filename: label,
        ok: true,
        title: card.name,
        subType: card.subType,
        cardNumber: card.cardNumber,
        searchMethod,
        wasIncrement: !!shopResult.incremented,
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
