/**
 * collectr.js
 * Fetches card data from app.getcollectr.com
 *
 * Collectr uses Next.js SSR. The search results are embedded as escaped JSON
 * inside self.__next_f.push([1,"..."]) script tags in the HTML.
 */

const axios = require('axios');
const { normalizeSubType, pickMatchingCard } = require('./collectr-match');

const COLLECTR_BASE = 'https://app.getcollectr.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function searchCardsViaBrowser(query) {
  // Collectr now renders client-side for some requests. Use Playwright to execute JS
  // and capture the JSON response that contains product_id / card_number fields.
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    throw new Error(
      'Collectr search requires Playwright. Run: npm install playwright && npx playwright install chromium'
    );
  }

  const url = `${COLLECTR_BASE}/?query=${encodeURIComponent(query)}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let products = null;
  const isProductPayload = (obj) => {
    if (!obj) return false;
    // Common shapes: { data: [...] } or { data: { data: [...] } }
    const arr =
      (Array.isArray(obj.data) && obj.data) ||
      (obj.data && Array.isArray(obj.data.data) && obj.data.data) ||
      null;
    if (!arr || arr.length === 0) return false;
    const first = arr[0];
    return first && (first.product_id || first.card_number || first.product_name);
  };

  page.on('response', async (res) => {
    if (products) return;
    const u = res.url();
    // Limit parsing to likely data endpoints; still handle mislabeled content-types.
    if (!/(api|graphql|search|products|catalog)/i.test(u)) return;
    try {
      const json = await res.json();
      if (isProductPayload(json)) {
        products =
          (Array.isArray(json.data) && json.data) ||
          (json.data && Array.isArray(json.data.data) && json.data.data) ||
          null;
      }
    } catch {
      try {
        const body = await res.text();
        if (!body || !body.includes('product_id')) return;
        // Try to locate a JSON array after "data":
        const idx = body.indexOf('"data":');
        if (idx === -1) return;
        const start = idx + '"data":'.length;
        // bracket match for array
        let depth = 0;
        let i = start;
        while (i < body.length) {
          if (body[i] === '[') depth++;
          if (body[i] === ']') {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
          i++;
        }
        if (depth !== 0) return;
        const raw = body.substring(start, i);
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length && (arr[0].product_id || arr[0].card_number)) {
          products = arr;
        }
      } catch {
        // ignore
      }
    }
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  // give XHR a moment after networkidle
  await page.waitForTimeout(1500);
  await browser.close();

  if (!products) {
    return [];
  }
  console.log(`[Collectr] Found ${products.length} products (browser)`); // keep same log style
  return products.map(normalizeProduct);
}

/**
 * Search for cards on Collectr by name.
 */
async function searchCards(query) {
  const url = `${COLLECTR_BASE}/?query=${encodeURIComponent(query)}`;
  console.log(`[Collectr] Fetching: ${url}`);

  const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const cards = extractCardsFromHtml(res.data);
  if (cards.length) return cards;
  // CSR fallback
  const viaBrowser = await searchCardsViaBrowser(query);
  if (viaBrowser.length) return viaBrowser;

  // Collectr often expects leading zeros for set-style numbers (e.g. 043/086).
  const m = String(query || '').trim().match(/^(\d{1,3})\s*\/\s*(\d{2,3})$/);
  if (m) {
    const left = m[1].padStart(3, '0');
    const right = m[2].padStart(3, '0');
    const padded = `${left}/${right}`;
    if (padded !== query) {
      const paddedUrl = `${COLLECTR_BASE}/?query=${encodeURIComponent(padded)}`;
      console.log(`[Collectr] Retrying with zeros: ${paddedUrl}`);
      const res2 = await axios.get(paddedUrl, { headers: HEADERS, timeout: 15000 });
      const cards2 = extractCardsFromHtml(res2.data);
      if (cards2.length) return cards2;
      const viaBrowser2 = await searchCardsViaBrowser(padded);
      if (viaBrowser2.length) return viaBrowser2;
    }
  }

  return [];
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
 * Resolve the correct Collectr listing for price sync.
 * Step 1: find by card number (e.g. 058/159)
 * Step 2: narrow by finish (e.g. Normal)
 * Never returns a loose / first search hit.
 */
async function resolveCardForSync({ collectrId, collectrUrl, title, subType, cardNumber }) {
  const { productId: urlProductId, groupSlug } = parseCollectrUrl(collectrUrl);
  const criteria = {
    collectrId: collectrId || urlProductId,
    subType,
    cardNumber,
  };

  const tryPool = (cards, source) => {
    const match = pickMatchingCard(cards, criteria);
    if (match) {
      console.log(
        `[Collectr] Matched #${match.cardNumber || '?'} / ${match.subType || '?'} ($${match.price}) via ${source}`
      );
      return match;
    }
    return null;
  };

  if (collectrUrl) {
    const fromUrl = await fetchCardsFromUrl(collectrUrl);
    const hit = tryPool(fromUrl, 'collectr_url');
    if (hit) return hit;
  }

  const baseTitle = title?.replace(/\s*—\s*[^—]+$/, '').trim() || '';
  const queries = [];
  if (cardNumber && baseTitle) queries.push(`${baseTitle} ${cardNumber}`);
  if (cardNumber) queries.push(String(cardNumber).replace(/^#/, ''));
  if (baseTitle) queries.push(baseTitle);
  if (title && title !== baseTitle) queries.push(title);
  if (groupSlug) queries.push(groupSlug.replace(/-/g, ' '));

  const seen = new Set();
  for (const q of queries) {
    if (!q || seen.has(q)) continue;
    seen.add(q);
    const cards = await searchCards(q);
    const hit = tryPool(cards, `search "${q}"`);
    if (hit) return hit;
  }

  console.warn(
    `[Collectr] No match for #${cardNumber || '?'} finish="${subType || '?'}" id=${criteria.collectrId || '?'}`
  );
  return null;
}

async function fetchCardsFromUrl(collectrUrl) {
  if (!collectrUrl || !collectrUrl.includes('getcollectr.com')) return [];
  try {
    console.log(`[Collectr] Fetching set page: ${collectrUrl}`);
    const res = await axios.get(collectrUrl, { headers: HEADERS, timeout: 15000 });
    return extractCardsFromHtml(res.data);
  } catch (err) {
    console.warn('[Collectr] Set page fetch failed:', err.message);
    return [];
  }
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
    // Collectr moved to Next.js App Router + React Flight streaming.
    // Product JSON is embedded inside self.__next_f.push([1,"..."]) payload strings.
    const payloads = [];
    const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
    let m;
    while ((m = re.exec(html))) {
      payloads.push(m[1]);
    }

    if (!payloads.length) {
      console.warn('[Collectr] Next.js flight payload not found in HTML');
      return [];
    }

    const flight = payloads
      .join('')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\u0026/g, '&')
      .replace(/\\u003c/g, '<')
      .replace(/\\u003e/g, '>')
      .replace(/\\\\/g, '\\');

    const MARKER = '"data":[{"product_id"';
    const markerIdx = flight.indexOf(MARKER);
    if (markerIdx === -1) {
      console.warn('[Collectr] Product data marker not found in HTML');
      return [];
    }

    const arrayStart = markerIdx + '"data":'.length;

    let depth = 0;
    let inString = false;
    let i = arrayStart;

    while (i < flight.length) {
      const ch = flight[i];
      if (ch === '"' && flight[i - 1] !== '\\') inString = !inString;
      if (!inString) {
        if (ch === '[') depth++;
        if (ch === ']') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      i++;
    }

    const raw = flight.substring(arrayStart, i);
    const products = JSON.parse(raw);

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
