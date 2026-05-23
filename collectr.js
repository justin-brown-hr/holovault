/**
 * collectr.js
 * Fetches card data from app.getcollectr.com
 *
 * Collectr uses Next.js SSR. The search results are embedded as escaped JSON
 * inside self.__next_f.push([1,"..."]) script tags in the HTML.
 */

const axios = require('axios');

const COLLECTR_BASE = 'https://app.getcollectr.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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
 * Parse productId (and optional set slug) from a Collectr product URL.
 */
function parseCollectrUrl(collectrUrl) {
  if (!collectrUrl) return { productId: null, groupSlug: null };
  const productId = collectrUrl.match(/[?&]productId=([^&]+)/i)?.[1] || null;
  const slugMatch = collectrUrl.match(/\/([^/?]+)\?productId=/i);
  const groupSlug = slugMatch ? slugMatch[1] : null;
  return { productId, groupSlug };
}

/**
 * Find one card in search results by Collectr product_id.
 */
function findCardById(cards, productId, subType = null) {
  if (!productId || !cards?.length) return null;
  const matches = cards.filter((c) => String(c.collectrId) === String(productId));
  if (matches.length === 0) return null;
  if (subType) {
    const norm = (s) =>
      (s || '')
        .trim()
        .toLowerCase()
        .replace(/_/g, ' ');
    const subMatch = matches.find((c) => norm(c.subType) === norm(subType));
    if (subMatch) return subMatch;
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Resolve the correct Collectr listing (variant) for sync.
 * Never returns searchResults[0] unless it matches the stored product id.
 */
async function resolveCardForSync({ collectrId, collectrUrl, title, subType }) {
  const { productId: urlProductId, groupSlug } = parseCollectrUrl(collectrUrl);
  const targetId = collectrId || urlProductId;

  const queries = [];
  if (title) queries.push(title);
  if (groupSlug) queries.push(groupSlug.replace(/-/g, ' '));

  // Strip trailing " — Holofoil" style suffix for broader search
  const baseTitle = title?.replace(/\s*—\s*[^—]+$/, '').trim();
  if (baseTitle && baseTitle !== title) queries.push(baseTitle);

  const seen = new Set();
  for (const q of queries) {
    if (!q || seen.has(q)) continue;
    seen.add(q);
    const cards = await searchCards(q);
    if (targetId) {
      const match = findCardById(cards, targetId, subType);
      if (match) {
        console.log(`[Collectr] Matched id ${targetId} (${subType || 'any'}) via query "${q}"`);
        return match;
      }
    }
    // Single unambiguous result
    if (cards.length === 1) {
      console.log(`[Collectr] Single result for "${q}"`);
      return cards[0];
    }
    // Multiple results: match finish/subtype if we have it stored
    if (subType && cards.length > 1) {
      const subMatch = cards.find(
        (c) => c.subType && c.subType.toLowerCase() === subType.toLowerCase()
      );
      if (subMatch) {
        console.log(`[Collectr] Matched subType "${subType}" via query "${q}"`);
        return subMatch;
      }
    }
  }

  return null;
}

/**
 * @deprecated Use resolveCardForSync — kept for compatibility.
 */
async function getCardDetails(collectrUrl, hintTitle) {
  const { productId } = parseCollectrUrl(collectrUrl);
  return resolveCardForSync({
    collectrId: productId,
    collectrUrl,
    title: hintTitle,
  });
}

/**
 * Extract cards from the Next.js SSR HTML.
 */
function extractCardsFromHtml(html) {
  try {
    const MARKER = '\\"data\\":[{\\"product_id\\"';
    const markerIdx = html.indexOf(MARKER);

    if (markerIdx === -1) {
      console.warn('[Collectr] Product data marker not found in HTML');
      return [];
    }

    const arrayStart = markerIdx + '\\"data\\":'.length;

    let depth = 0;
    let inString = false;
    let i = arrayStart;

    while (i < html.length) {
      if (html[i] === '\\' && html[i + 1] === '"') {
        inString = !inString;
        i += 2;
        continue;
      }
      if (html[i] === '\\' && html[i + 1] === '\\') {
        i += 2;
        continue;
      }

      if (!inString) {
        if (html[i] === '[') depth++;
        if (html[i] === ']') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      i++;
    }

    const rawEscaped = html.substring(arrayStart, i);

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

  const collectrUrl =
    item.web_slug_group && item.web_slug_category
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

function formatSubTypeLabel(subType) {
  if (!subType) return '';
  return subType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function closeBrowser() {
  // No-op
}

module.exports = {
  searchCards,
  getCardDetails,
  resolveCardForSync,
  parseCollectrUrl,
  formatSubTypeLabel,
  closeBrowser,
};
