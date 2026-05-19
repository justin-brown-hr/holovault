/**
 * collectr.js
 * Fetches card data from app.getcollectr.com
 *
 * Collectr uses Next.js SSR. The search results are embedded as escaped JSON
 * inside self.__next_f.push([1,"..."]) script tags in the HTML.
 *
 * Confirmed format from curl:
 *   {\"data\":[{\"product_id\":\"684462\",\"catalog_category\":\"3\",...}]
 *
 * Search URL: https://app.getcollectr.com/?query=charizard
 */

const axios = require('axios');

const COLLECTR_BASE = 'https://app.getcollectr.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Search for cards on Collectr by name.
 */
async function searchCards(query) {
  const url = `${COLLECTR_BASE}/?query=${encodeURIComponent(query)}`;
  console.log(`[Collectr] Fetching: ${url}`);

  const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return extractCardsFromHtml(res.data);
}

/**
 * Get fresh price for a card by searching its name.
 */
async function getCardDetails(collectrUrl) {
  const slug = collectrUrl.split('/').pop() || '';
  const query = slug.replace(/-/g, ' ');
  const cards = await searchCards(query);
  return cards.length > 0 ? cards[0] : null;
}

/**
 * Extract cards from the Next.js SSR HTML.
 *
 * The HTML contains script tags like:
 *   self.__next_f.push([1,"...escaped json..."])
 *
 * Inside those, the product array looks like:
 *   {\"data\":[{\"product_id\":\"123\",\"catalog_category\":\"3\",...}]
 */
function extractCardsFromHtml(html) {
  try {
    // Confirmed format from curl:
    // \\"pages\\":[{\\"data\\":[{\\"product_id\\":\\"684462\\",...
    // We find the marker, grab everything from [ to the matching ]
    // then unescape \\" → " to get valid JSON

    const MARKER = '\\"data\\":[{\\"product_id\\"';
    const markerIdx = html.indexOf(MARKER);

    if (markerIdx === -1) {
      console.warn('[Collectr] Product data marker not found in HTML');
      return [];
    }

    // The [ is right at the end of \\"data\\":
    // marker is: \"data\":[{\"product_id\"
    // so arrayStart = markerIdx + length of \"data\":
    const arrayStart = markerIdx + '\\"data\\":'.length;

    // Walk forward counting [ and ] but treating \" as a string toggle
    let depth = 0;
    let inString = false;
    let i = arrayStart;

    while (i < html.length) {
      // \" = escaped quote → toggle string mode
      if (html[i] === '\\' && html[i+1] === '"') {
        inString = !inString;
        i += 2;
        continue;
      }
      // \\ = escaped backslash → skip
      if (html[i] === '\\' && html[i+1] === '\\') {
        i += 2;
        continue;
      }

      if (!inString) {
        if (html[i] === '[') depth++;
        if (html[i] === ']') {
          depth--;
          if (depth === 0) { i++; break; }
        }
      }
      i++;
    }

    const rawEscaped = html.substring(arrayStart, i);

    // Unescape: \" → " (each backslash+quote becomes just a quote)
    const unescaped = rawEscaped
      .replace(/\\"/g, '"')
      .replace(/\\u0026/g, '&')
      .replace(/\\u003c/g, '<')
      .replace(/\\u003e/g, '>');

    const products = JSON.parse(unescaped);

    if (!Array.isArray(products) || products.length === 0) {
      console.warn('[Collectr] Parsed empty product array');
      return [];
    }

    console.log(`[Collectr] Found ${products.length} products`);
    return products.map(normalizeProduct);

  } catch (err) {
    console.error('[Collectr] Parse error:', err.message);
    const debugIdx = html.indexOf('\\"data\\":[{\\"product_id\\"');
    if (debugIdx !== -1) {
      console.error('[Collectr] Raw sample:', html.substring(debugIdx, debugIdx + 100));
    }
    return [];
  }
}

/**
 * Normalize a raw Collectr product into our standard format.
 */
function normalizeProduct(item) {
  const price = parseFloat(item.latest_price || 0);
  const priceChange = parseFloat(item.market_price_diff || 0);
  const priceChangePct = parseFloat(item.market_price_percentage_diff || 0);

  const collectrUrl = item.web_slug_group && item.web_slug_category
    ? `${COLLECTR_BASE}/sets/category/${item.web_slug_category}/${item.web_slug_group}?productId=${item.product_id}`
    : '';

  return {
    collectrId: item.product_id || null,
    name: (item.product_name || '').trim(),
    setName: (item.catalog_group || '').trim(),
    cardNumber: (item.card_number || '').trim(),
    rarity: (item.rarity || '').trim(),
    subType: (item.product_sub_type || '').trim(),
    isCard: item.is_card !== false,
    price,
    priceChange,
    priceChangePct,
    imageUrl: item.image_url || '',
    collectrUrl,
  };
}

async function closeBrowser() {
  // No-op: no browser used
}

module.exports = { searchCards, getCardDetails, closeBrowser };
