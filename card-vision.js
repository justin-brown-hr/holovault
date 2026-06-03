/**
 * card-vision.js
 * Read Pokémon card details from a photo (OpenAI vision), then search Collectr.
 */

const axios = require('axios');
const { searchCards } = require('./collectr');
const { pickMatchingCard, cardNumbersMatch, normalizeSubType } = require('./collectr-match');

const PARSE_PROMPT = `You are reading a Pokémon TCG card from a photo.
Return ONLY valid JSON with these fields:
{
  "name": "English Pokémon name if you can determine it (e.g. Sprigatito). If only non-English text is visible, give the best English equivalent name.",
  "cardNumber": "Card number like 125/159 or 0102/09 — digits and slash only, no # prefix",
  "setName": "Set name in English if visible",
  "subType": "Finish: Normal, Holofoil, Reverse Holofoil, etc.",
  "language": "english, japanese, chinese, or other",
  "confidence": "high, medium, or low"
}
If a field is not visible, use an empty string. cardNumber must match pattern NN/NN or NNN/NN when visible.`;

function hasOpenAiKey() {
  return !!(process.env.OPENAI_API_KEY || '').trim();
}

function getOpenAiKey() {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) {
    throw new Error('OPENAI_API_KEY missing — add your key to .env (see .env.example)');
  }
  return key;
}

function formatOpenAiError(err) {
  const data = err.response?.data?.error;
  if (data?.code === 'insufficient_quota') {
    return 'OpenAI quota exceeded — add billing/credits at platform.openai.com/account/billing';
  }
  if (err.response?.status === 429) {
    return 'OpenAI rate limit — wait a minute and try again';
  }
  if (data?.message) return data.message;
  return err.message || 'OpenAI vision request failed';
}

/**
 * Parse card fields from a base64 image (no data: prefix).
 */
async function parseCardImage(imageBase64, mimeType = 'image/jpeg') {
  const apiKey = getOpenAiKey();
  const model = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
  const dataUrl = `data:${mimeType};base64,${imageBase64}`;

  let res;
  try {
    res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PARSE_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 400,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );
  } catch (err) {
    throw new Error(formatOpenAiError(err));
  }

  const raw = res.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Vision API returned no content');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Vision API returned invalid JSON');
  }

  return {
    name: String(parsed.name || '').trim(),
    cardNumber: String(parsed.cardNumber || '').trim().replace(/^#/, ''),
    setName: String(parsed.setName || '').trim(),
    subType: String(parsed.subType || '').trim(),
    language: String(parsed.language || '').trim(),
    confidence: String(parsed.confidence || '').trim(),
  };
}

function narrowResults(cards, parsed) {
  if (!cards?.length) return [];

  let pool = cards;

  if (parsed.cardNumber) {
    const byNum = pool.filter((c) => cardNumbersMatch(c.cardNumber, parsed.cardNumber));
    if (byNum.length) pool = byNum;
  }

  if (parsed.subType) {
    const exact = pickMatchingCard(pool, {
      cardNumber: parsed.cardNumber || undefined,
      subType: parsed.subType,
    });
    if (exact) return [exact];

    const want = normalizeSubType(parsed.subType);
    const byFinish = pool.filter((c) => normalizeSubType(c.subType) === want);
    if (byFinish.length) pool = byFinish;
  }

  if (parsed.name && pool.length > 1) {
    const wantName = parsed.name.toLowerCase();
    const byName = pool.filter((c) => (c.name || '').toLowerCase().includes(wantName));
    if (byName.length) pool = byName;
  }

  return pool;
}

/**
 * Pick exactly one Collectr card for auto-import (strict finish + number when possible).
 */
function pickAutoCollectrCard(cards, parsed) {
  if (!cards?.length) {
    return { card: null, reason: 'No Collectr results' };
  }

  if (parsed.cardNumber && parsed.subType) {
    const exact = pickMatchingCard(cards, {
      cardNumber: parsed.cardNumber,
      subType: parsed.subType,
    });
    if (exact) return { card: exact, reason: null };
  }

  const narrowed = narrowResults(cards, parsed);
  if (narrowed.length === 1) return { card: narrowed[0], reason: null };

  if (parsed.cardNumber) {
    const byNum = cards.filter((c) => cardNumbersMatch(c.cardNumber, parsed.cardNumber));
    if (byNum.length === 1) return { card: byNum[0], reason: null };
  }

  if (narrowed.length > 1) {
    return { card: null, reason: `${narrowed.length} matches — need clearer photo or finish` };
  }
  if (cards.length > 1) {
    return { card: null, reason: `${cards.length} Collectr results — could not pick one` };
  }

  return { card: cards[0], reason: null };
}

/**
 * Pick a Collectr listing for bulk photo import.
 * Prefer strict match; if finish is unknown, use first match for that card number so we can still add to Shopify.
 */
function pickCardForBulkImport(cards, parsed) {
  if (!cards?.length) {
    return { card: null, reason: 'No Collectr results', ambiguous: false };
  }

  const strict = pickAutoCollectrCard(cards, parsed);
  if (strict.card) {
    return { card: strict.card, reason: null, ambiguous: false };
  }

  const narrowed = narrowResults(cards, parsed);
  if (narrowed.length === 1) {
    return { card: narrowed[0], reason: null, ambiguous: false };
  }

  if (parsed.cardNumber) {
    const byNum = cards.filter((c) => cardNumbersMatch(c.cardNumber, parsed.cardNumber));
    if (byNum.length >= 1) {
      const chosen = byNum[0];
      const ambiguous = byNum.length > 1;
      const reason = ambiguous
        ? `${byNum.length} Collectr variants for #${parsed.cardNumber} — using first match (add finish in Shopify if needed)`
        : null;
      return { card: chosen, reason, ambiguous };
    }
  }

  if (cards.length >= 1) {
    return { card: cards[0], reason: 'No card number on photo — using first Collectr result', ambiguous: true };
  }

  return { card: null, reason: 'No Collectr results', ambiguous: false };
}

async function resolveCardFromImage(imageBase64, mimeType = 'image/jpeg') {
  const parsed = await parseCardImage(imageBase64, mimeType);
  const { cards, searchMethod, queriesTried } = await searchCollectrFromParsed(parsed);
  const { card, reason } = pickAutoCollectrCard(cards, parsed);
  return { parsed, card, searchMethod, queriesTried, pickError: reason };
}

/**
 * Search Collectr: card number first, then card name.
 */
async function searchCollectrFromParsed(parsed) {
  let cards = [];
  let searchMethod = null;
  const queriesTried = [];

  const tryQuery = async (q, method) => {
    if (!q || q.length < 2) return false;
    queriesTried.push(q);
    console.log(`[ImageSearch] Collectr query (${method}): "${q}"`);
    const results = await searchCards(q);
    if (results.length > 0) {
      cards = narrowResults(results, parsed);
      if (cards.length === 0) cards = results;
      searchMethod = method;
      return true;
    }
    return false;
  };

  const num = parsed.cardNumber?.replace(/^#/, '').trim();
  const name = parsed.name?.trim();
  const set = parsed.setName?.trim();

  if (num) {
    if (name && set) {
      if (await tryQuery(`${name} ${num}`, 'card_number')) {
        return { cards, searchMethod, parsed, queriesTried };
      }
    }
    if (set && (await tryQuery(`${num} ${set}`, 'card_number'))) {
      return { cards, searchMethod, parsed, queriesTried };
    }
    if (await tryQuery(num, 'card_number')) {
      return { cards, searchMethod, parsed, queriesTried };
    }
  }

  if (name) {
    if (set && (await tryQuery(`${name} ${set}`, 'card_name'))) {
      return { cards, searchMethod, parsed, queriesTried };
    }
    if (await tryQuery(name, 'card_name')) {
      return { cards, searchMethod, parsed, queriesTried };
    }
  }

  return { cards: [], searchMethod: null, parsed, queriesTried };
}

async function searchByCardImage(imageBase64, mimeType = 'image/jpeg') {
  const parsed = await parseCardImage(imageBase64, mimeType);
  console.log('[ImageSearch] Parsed:', parsed);
  const result = await searchCollectrFromParsed(parsed);
  console.log(
    `[ImageSearch] ${result.cards.length} results via ${result.searchMethod || 'none'}`
  );
  return result;
}

module.exports = {
  hasOpenAiKey,
  parseCardImage,
  searchCollectrFromParsed,
  searchByCardImage,
  pickAutoCollectrCard,
  pickCardForBulkImport,
  resolveCardFromImage,
};
