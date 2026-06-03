/**
 * local-ocr.js
 * OCR (offline) to extract card number from an image.
 *
 * Goal: no OpenAI key required. We read text and try to find patterns like:
 * - 125/159
 * - 0102/09
 */

const { createWorker } = require('tesseract.js');
const sharp = require('sharp');

/** Production default: eng only (faster, no extra traineddata downloads on Railway). */
function getDefaultOcrLang() {
  if (process.env.OCR_LANG) return process.env.OCR_LANG.trim();
  if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) return 'eng';
  return 'eng+chi_sim+jpn';
}

let preloadPromise = null;

/** Warm OCR on server boot so first bulk photo is not a cold-start timeout. */
function preloadOcr() {
  if (preloadPromise) return preloadPromise;
  preloadPromise = (async () => {
    const worker = await createWorker(getDefaultOcrLang());
    await worker.terminate();
    console.log('[OCR] Ready (' + getDefaultOcrLang() + ')');
  })().catch((err) => {
    preloadPromise = null;
    console.warn('[OCR] Preload skipped:', err.message);
  });
  return preloadPromise;
}

function extractCardNumbers(text) {
  const t = (text || '').replace(/\s+/g, ' ');
  const out = new Set();

  // Standard: 1-3 digits / 1-3 digits
  for (const m of t.matchAll(/(\d{1,3})\s*\/\s*(\d{1,3})/g)) {
    out.add(`${parseInt(m[1], 10)}/${parseInt(m[2], 10)}`);
  }

  // Special: 4 digits / 2 digits (Gem Pack style like 0102/09)
  for (const m of t.matchAll(/(\d{4})\s*\/\s*(\d{2})/g)) {
    const left = m[1];
    const right = m[2];
    out.add(`${left}/${right}`);
  }

  return [...out];
}

function pickBestCardNumber(candidates) {
  if (!candidates?.length) return '';

  // Prefer 4/2 (0102/09) style first, then standard.
  const isFourTwo = (s) => /^\d{4}\/\d{2}$/.test(s);
  const isStd = (s) => /^\d{1,3}\/\d{1,3}$/.test(s);

  const fourTwo = candidates.filter(isFourTwo);
  // If we have any 4/2 candidates, prefer ones with a leading 0 (common for this style).
  const fourTwoLeading0 = fourTwo.filter((s) => s.startsWith('0'));
  if (fourTwoLeading0.length) {
    fourTwoLeading0.sort(); // deterministic
    return fourTwoLeading0[0];
  }
  if (fourTwo.length) {
    fourTwo.sort();
    return fourTwo[0];
  }

  const std = candidates.filter(isStd);
  if (std.length === 0) return candidates[0];

  // Prefer right side in typical set sizes (9, 10, 11, 30, 50, 60, 80, 100-300)
  const goodTotals = new Set([9, 10, 11, 30, 50, 60, 80, 100, 101, 102, 159, 189, 193, 217, 264, 270, 271, 288, 300, 350]);
  const scored = std
    .map((s) => {
      const [a, b] = s.split('/').map((x) => parseInt(x, 10));
      let score = 0;
      if (goodTotals.has(b)) score += 5;
      if (b >= 9 && b <= 400) score += 2;
      if (a >= 1 && a <= b) score += 2;
      if (a >= 10 && a <= 999) score += 1;
      // Penalize tiny fractions like 1/2, 2/10 etc.
      if (b <= 20) score -= 3;
      return { s, score };
    })
    .sort((x, y) => y.score - x.score);

  return scored[0]?.s || std[0];
}

async function ocrImageBase64(imageBase64, mimeType = 'image/jpeg', opts = {}) {
  const clean = String(imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!clean) throw new Error('Empty image data');
  const inputBuf = Buffer.from(clean, 'base64');

  const lang = opts.lang || getDefaultOcrLang();
  const worker = await createWorker(lang);
  try {
    await worker.setParameters({
      tessedit_char_whitelist: opts.whitelist || '0123456789/',
    });

    // Preprocess: try a few crops where card numbers usually appear (bottom area),
    // upscale, grayscale, and increase contrast for digits.
    const meta = await sharp(inputBuf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    const regions = [];

    if (w > 0 && h > 0) {
      regions.push({ name: 'bottom_strip', left: 0, top: Math.floor(h * 0.72), width: w, height: Math.floor(h * 0.28) });
      regions.push({ name: 'bottom_left', left: 0, top: Math.floor(h * 0.72), width: Math.floor(w * 0.65), height: Math.floor(h * 0.28) });
      regions.push({ name: 'bottom_center', left: Math.floor(w * 0.18), top: Math.floor(h * 0.70), width: Math.floor(w * 0.64), height: Math.floor(h * 0.30) });
    } else {
      regions.push({ name: 'full', left: 0, top: 0, width: 0, height: 0 });
    }

    const texts = [];
    for (const r of regions) {
      // eslint-disable-next-line no-await-in-loop
      let img = sharp(inputBuf);
      if (r.name !== 'full') {
        img = img.extract({ left: r.left, top: r.top, width: r.width, height: r.height });
      }
      // eslint-disable-next-line no-await-in-loop
      const pre = await img
        .resize({ width: Math.min(1400, (r.width || w) * 2), withoutEnlargement: false })
        .grayscale()
        .normalise()
        .threshold(165)
        .png()
        .toBuffer();

      // eslint-disable-next-line no-await-in-loop
      const ret = await worker.recognize(pre);
      const t = (ret?.data?.text || '').trim();
      if (t) texts.push(t);
    }

    return texts.join('\n');
  } finally {
    await worker.terminate();
  }
}

async function parseCardFromImageOffline(imageBase64, mimeType = 'image/jpeg') {
  const attempts = [
    { whitelist: '0123456789/', lang: getDefaultOcrLang() },
    { whitelist: '0123456789/', lang: 'eng' },
    // Allow some noise that often appears around the number.
    { whitelist: '0123456789/.-', lang: 'eng' },
  ];

  const results = [];
  for (const a of attempts) {
    // eslint-disable-next-line no-await-in-loop
    const text = await ocrImageBase64(imageBase64, mimeType, a);
    const cardNumbers = extractCardNumbers(text);
    results.push({ text, cardNumbers, cardNumber: pickBestCardNumber(cardNumbers), attempt: a });
    if (cardNumbers.length) break;
  }

  const best = results.find((r) => r.cardNumbers.length) || results[0] || { text: '', cardNumbers: [], cardNumber: '' };
  return {
    text: best.text,
    cardNumbers: best.cardNumbers,
    cardNumber: best.cardNumber,
    confidence: best.cardNumbers.length ? 'medium' : 'low',
    debugAttempts: results.map((r) => ({ cardNumbers: r.cardNumbers, cardNumber: r.cardNumber })),
  };
}

module.exports = {
  extractCardNumbers,
  pickBestCardNumber,
  ocrImageBase64,
  parseCardFromImageOffline,
  preloadOcr,
  getDefaultOcrLang,
};

