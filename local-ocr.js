/**
 * local-ocr.js
 * OCR (offline) to extract card number from a photo.
 *
 * Tuned for Pokémon CRI (Crimson Invasion) style numbers: 0xx/086 at bottom-left.
 */

const { createWorker } = require('tesseract.js');
const sharp = require('sharp');

/** Card numbers are digits — always use English traineddata (fast, reliable). */
function getDefaultOcrLang() {
  if (process.env.OCR_LANG) return process.env.OCR_LANG.trim();
  return 'eng';
}

/** CRI set size — most sample photos are CRI EN 0xx/086. */
const CRI_SET_TOTAL = 86;

const COMMON_SET_TOTALS = ['86', '96', '102', '159', '189', '193', '217', '264', '271', '288'];
const THREE_DIGIT_TOTALS = ['086', '096', '102', '159', '189', '193', '217', '264', '271', '288'];

function isFourTwo(s) {
  return /^\d{4}\/\d{2}$/.test(s);
}

let preloadPromise = null;
let sharedWorker = null;
let sharedWorkerLang = null;

async function getSharedWorker(lang = 'eng') {
  if (sharedWorker && sharedWorkerLang === lang) return sharedWorker;
  if (sharedWorker) {
    await sharedWorker.terminate();
    sharedWorker = null;
    sharedWorkerLang = null;
  }
  sharedWorker = await createWorker(lang);
  sharedWorkerLang = lang;
  return sharedWorker;
}

async function terminateSharedWorker() {
  if (sharedWorker) {
    await sharedWorker.terminate();
    sharedWorker = null;
    sharedWorkerLang = null;
  }
}

function preloadOcr() {
  if (preloadPromise) return preloadPromise;
  preloadPromise = (async () => {
    await getSharedWorker(getDefaultOcrLang());
    console.log('[OCR] Ready (' + getDefaultOcrLang() + ', CRI-tuned)');
  })().catch((err) => {
    preloadPromise = null;
    console.warn('[OCR] Preload skipped:', err.message);
  });
  return preloadPromise;
}

function isCopyrightYear(n) {
  return n >= 1990 && n <= 2039;
}

function isPlausibleCardNumber(s) {
  if (!s || typeof s !== 'string') return false;
  if (isFourTwo(s)) return true;

  const parts = s.split('/');
  if (parts.length !== 2) return false;
  const a = parseInt(parts[0], 10);
  const b = parseInt(parts[1], 10);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < 1) return false;
  if (isCopyrightYear(a) || isCopyrightYear(b)) return false;
  if (a > 400) return false;
  if (a > b && b < 50) return false;
  if (b < 9) return false;
  if (b <= 20 && a <= 9) return false;
  return true;
}

function isCriCardNumber(s) {
  if (!isPlausibleCardNumber(s)) return false;
  const [a, b] = s.split('/').map((x) => parseInt(x, 10));
  return b === CRI_SET_TOTAL && a >= 1 && a <= CRI_SET_TOTAL;
}

function scoreCardNumber(s) {
  if (!isPlausibleCardNumber(s)) return -100;
  const [a, b] = s.split('/').map((x) => parseInt(x, 10));
  let score = 0;

  // Strong CRI preference: 1–86 / 86
  if (b === CRI_SET_TOTAL) {
    score += 30;
    if (a >= 1 && a <= CRI_SET_TOTAL) score += 15;
  }

  if (COMMON_SET_TOTALS.includes(String(b))) score += 8;
  if (b >= 30 && b <= 400) score += 3;
  if (a >= 1 && a <= b) score += 6;
  if (a <= 200) score += 2;

  // Penalize copyright / glare misreads
  if (b === 202 || b === 2026 || a === 2026) score -= 40;
  if (b !== CRI_SET_TOTAL && b < 50) score -= 15;
  if (b <= 20) score -= 20;
  if (a > b) score -= 15;
  if (isCopyrightYear(a)) score -= 35;
  if (a > 999) score -= 25;

  return score;
}

/** Pull CRI numbers from digit runs: 04370861 → 43/86, 013086 → 13/86 */
function extractCriFromDigits(text) {
  const out = new Set();
  const compact = (text || '').replace(/[^\d]/g, '');

  // ...086 anywhere in stream (OCR often drops the slash)
  let idx = 0;
  while ((idx = compact.indexOf('086', idx)) !== -1) {
    const before = compact.slice(Math.max(0, idx - 8), idx);
    for (const len of [3, 2, 1]) {
      if (before.length < len) continue;
      const a = parseInt(before.slice(-len), 10);
      if (a >= 1 && a <= CRI_SET_TOTAL) out.add(`${a}/${CRI_SET_TOTAL}`);
    }
    idx += 1;
  }

  // Token blobs: 043708650, 06870865
  const tokens = (text || '').replace(/\s+/g, ' ').split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const blob = tok.replace(/[^\d]/g, '');
    if (blob.length < 5 || blob.length > 14) continue;

    const m086 = blob.match(/^(\d{3})\d{0,5}086/);
    if (m086) {
      const a = parseInt(m086[1], 10);
      if (a >= 1 && a <= CRI_SET_TOTAL) out.add(`${a}/${CRI_SET_TOTAL}`);
    }
    const m86 = blob.match(/^(\d{2,3})\d{0,6}86$/);
    if (m86) {
      const a = parseInt(m86[1], 10);
      if (a >= 1 && a <= CRI_SET_TOTAL) out.add(`${a}/${CRI_SET_TOTAL}`);
    }
  }

  // Spaced fragments: "0 43" → 043, "3 2" → 32
  const spaced = (text || '').match(/(?:\d\s+){1,6}\d/g) || [];
  for (const chunk of spaced) {
    const digits = chunk.replace(/\s/g, '');
    if (digits.length >= 2 && digits.length <= 3) {
      const a = parseInt(digits, 10);
      if (a >= 1 && a <= CRI_SET_TOTAL) out.add(`${a}/${CRI_SET_TOTAL}`);
    }
  }

  // Single-digit runs in footer OCR: "4 0 1 3" → 013, 040, 401...
  const singles = (text || '').match(/(?:\b\d\b\s*){3,6}/g) || [];
  for (const run of singles) {
    const digits = run.replace(/\s/g, '').slice(0, 3);
    if (digits.length === 3) {
      const a = parseInt(digits, 10);
      if (a >= 1 && a <= CRI_SET_TOTAL) out.add(`${a}/${CRI_SET_TOTAL}`);
    }
  }

  return [...out];
}

function extractCardNumbers(text) {
  const t = (text || '').replace(/\s+/g, ' ');
  const out = new Set();

  for (const n of extractCriFromDigits(text)) out.add(n);

  for (const m of t.matchAll(/(\d{1,3})\s*\/\s*0?86\b/g)) {
    const a = parseInt(m[1], 10);
    if (a >= 1 && a <= CRI_SET_TOTAL) out.add(`${a}/${CRI_SET_TOTAL}`);
  }

  for (const m of t.matchAll(/(\d{1,3})\s*\/\s*(\d{2,3})/g)) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (isCopyrightYear(a) || isCopyrightYear(b)) continue;
    out.add(`${a}/${b}`);
  }

  for (const tok of t.split(/\s+/).filter(Boolean)) {
    const blob = tok.replace(/[^\d]/g, '');
    if (blob.length < 6 || blob.length > 14) continue;

    for (const total3 of THREE_DIGIT_TOTALS) {
      const b = parseInt(total3, 10);
      const re = new RegExp(`^(\\d{3})\\d{0,4}${total3}`);
      const m = blob.match(re);
      if (m) {
        const a = parseInt(m[1], 10);
        if (a >= 1 && a <= b) out.add(`${a}/${b}`);
      }
    }

    for (const total of COMMON_SET_TOTALS) {
      const b = parseInt(total, 10);
      const re = new RegExp(`^(\\d{2,3})\\d{0,6}${total}`);
      const m = blob.match(re);
      if (m) {
        const a = parseInt(m[1], 10);
        if (a >= 1 && a <= b) out.add(`${a}/${b}`);
      }
    }
  }

  return [...out].filter(isPlausibleCardNumber);
}

function pickBestCardNumber(candidates) {
  const pool = (candidates || []).filter(isPlausibleCardNumber);
  const cri = pool.filter(isCriCardNumber);
  if (!cri.length) return '';

  const ranked = [...new Set(cri)]
    .map((s) => ({ s, score: scoreCardNumber(s) }))
    .sort((x, y) => y.score - x.score);

  return ranked[0]?.s || '';
}

function rankCardNumberCandidates(candidates) {
  const cri = (candidates || []).filter(isCriCardNumber);
  return [...new Set(cri)]
    .map((s) => ({ s, score: scoreCardNumber(s) }))
    .sort((x, y) => y.score - x.score)
    .map((r) => r.s);
}

function buildCropRegions(w, h) {
  if (w <= 0 || h <= 0) return [{ name: 'full' }];

  const mk = (name, leftPct, topPct, widthPct, heightPct) => ({
    name,
    left: Math.floor(w * leftPct),
    top: Math.floor(h * topPct),
    width: Math.max(160, Math.floor(w * widthPct)),
    height: Math.max(60, Math.floor(h * heightPct)),
  });

  // CRI: "0xx/086" sits above the ©2026 copyright line (not on it).
  return [
    mk('cri_number', 0.12, 0.805, 0.52, 0.075),
    mk('cri_number_up', 0.10, 0.785, 0.55, 0.09),
    mk('cri_footer', 0.04, 0.775, 0.65, 0.11),
    mk('cri_mid', 0.08, 0.76, 0.70, 0.14),
    mk('number_bl_tight', 0.0, 0.72, 0.60, 0.18),
    mk('number_bl_wide', 0.0, 0.68, 0.78, 0.22),
    { name: 'full' },
  ];
}

async function preprocessRegion(inputBuf, region, variant) {
  let img = sharp(inputBuf).rotate();
  if (region.name !== 'full') {
    const meta = await sharp(inputBuf).rotate().metadata();
    const maxTop = Math.max(0, (meta.height || 0) - region.height);
    const maxLeft = Math.max(0, (meta.width || 0) - region.width);
    const top = Math.min(region.top, maxTop);
    const left = Math.min(region.left, maxLeft);
    const height = Math.min(region.height, (meta.height || region.height) - top);
    const width = Math.min(region.width, (meta.width || region.width) - left);
    if (width < 40 || height < 20) return null;
    img = img.extract({ left, top, width, height });
  }

  const meta = await img.metadata();
  const targetW = Math.max(1400, Math.min(2600, (meta.width || 1200) * 2.5));
  img = img.resize({ width: targetW, withoutEnlargement: false });

  if (variant === 'soft') {
    return img.grayscale().normalise().sharpen().png().toBuffer();
  }
  if (variant === 'contrast') {
    return img.grayscale().normalise().sharpen({ sigma: 1.4 }).linear(1.8, -40).png().toBuffer();
  }
  if (variant === 'threshold') {
    return img.grayscale().normalise().threshold(145).png().toBuffer();
  }
  if (variant === 'threshold_high') {
    return img.grayscale().normalise().threshold(175).png().toBuffer();
  }
  if (variant === 'invert') {
    return img.grayscale().normalise().negate().linear(1.2, 0).threshold(160).png().toBuffer();
  }
  return img.grayscale().normalise().sharpen().linear(1.4, -30).png().toBuffer();
}

async function recognizeRegion(worker, inputBuf, region, variant, psm) {
  const pre = await preprocessRegion(inputBuf, region, variant);
  if (!pre) return '';

  await worker.setParameters({
    tessedit_char_whitelist: '0123456789/',
    tessedit_pageseg_mode: psm,
  });
  const ret = await worker.recognize(pre);
  return (ret?.data?.text || '').trim();
}

const PRIMARY_PASSES = [
  { region: 'cri_number', variant: 'contrast', psm: '11' },
  { region: 'cri_number', variant: 'threshold', psm: '11' },
  { region: 'cri_number_up', variant: 'contrast', psm: '11' },
  { region: 'cri_footer', variant: 'contrast', psm: '11' },
  { region: 'cri_mid', variant: 'contrast', psm: '7' },
  { region: 'number_bl_tight', variant: 'contrast', psm: '11' },
];

const FALLBACK_PASSES = [
  { region: 'cri_number_up', variant: 'invert', psm: '11' },
  { region: 'cri_footer', variant: 'threshold_high', psm: '7' },
  { region: 'cri_mid', variant: 'soft', psm: '6' },
  { region: 'number_bl_wide', variant: 'threshold', psm: '11' },
  { region: 'number_bl_wide', variant: 'invert', psm: '11' },
];

async function ocrImageBase64(imageBase64, mimeType = 'image/jpeg', opts = {}) {
  const result = await ocrImageWithVotes(imageBase64, mimeType, opts);
  return result.text;
}

async function ocrImageWithVotes(imageBase64, mimeType = 'image/jpeg', opts = {}) {
  const clean = String(imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!clean) throw new Error('Empty image data');
  const inputBuf = Buffer.from(clean, 'base64');

  const worker = await getSharedWorker(opts.lang || 'eng');
  const meta = await sharp(inputBuf).rotate().metadata();
  const regions = buildCropRegions(meta.width || 0, meta.height || 0);
  const passes = opts.passes || PRIMARY_PASSES;
  const votes = new Map();

  const texts = [];

  const runPasses = async (list) => {
    for (const pass of list) {
      const region = regions.find((r) => r.name === pass.region) || regions[0];
      // eslint-disable-next-line no-await-in-loop
      const text = await recognizeRegion(worker, inputBuf, region, pass.variant, pass.psm);
      if (text) texts.push(text);
      const nums = extractCardNumbers(text);
      const fromSlash = /\d{1,3}\s*\/\s*0?86/.test(text);
      for (const n of nums) {
        if (!isCriCardNumber(n)) continue;
        const weight = fromSlash && text.includes(n.split('/')[0]) ? 2 : 1;
        votes.set(n, (votes.get(n) || 0) + weight);
      }
    }
  };

  await runPasses(passes);
  if (!votes.size && !opts.passes) {
    await runPasses(FALLBACK_PASSES);
  }

  return { text: texts.join('\n'), votes };
}

function pickBestFromVotes(votes) {
  if (!votes?.size) return { cardNumber: '', rankedCandidates: [] };

  const ranked = [...votes.entries()]
    .map(([s, count]) => ({
      s,
      count,
      num: parseInt(s.split('/')[0], 10),
      score: scoreCardNumber(s) + count * 12,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.count - a.count ||
        b.num - a.num
    );

  return {
    cardNumber: ranked[0]?.s || '',
    rankedCandidates: ranked.map((r) => r.s),
  };
}

async function parseCardFromImageOffline(imageBase64, mimeType = 'image/jpeg') {
  const { text, votes } = await ocrImageWithVotes(imageBase64, mimeType, { lang: 'eng' });
  const { cardNumber, rankedCandidates } = pickBestFromVotes(votes);
  const cardNumbers = rankedCandidates.length
    ? rankedCandidates
    : extractCardNumbers(text).filter(isCriCardNumber);

  return {
    text,
    cardNumbers,
    cardNumber,
    rankedCandidates,
    confidence: isCriCardNumber(cardNumber) ? 'high' : cardNumber ? 'medium' : 'low',
    setHint: 'CRI',
    debugAttempts: [{ cardNumbers, cardNumber, votes: Object.fromEntries(votes) }],
  };
}

module.exports = {
  extractCardNumbers,
  extractCriFromDigits,
  pickBestCardNumber,
  rankCardNumberCandidates,
  isPlausibleCardNumber,
  isCriCardNumber,
  ocrImageBase64,
  ocrImageWithVotes,
  parseCardFromImageOffline,
  preloadOcr,
  getDefaultOcrLang,
  terminateSharedWorker,
  CRI_SET_TOTAL,
};
