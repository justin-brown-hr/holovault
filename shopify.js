/**
 * shopify.js
 * Reads config purely from environment variables.
 */

require('dotenv').config();

const axios = require('axios');
const {
  getAccessToken,
  hasShopifyCredentials,
  getAuthMode,
  getAuthStatus,
  clearTokenCache,
} = require('./shopify-auth');
const { attachShopifyThrottle } = require('./shopify-throttle');

const CORE_COLLECTION_HANDLES = new Set([
  'pokemon',
  'english',
  'japanese',
  'chinese',
  'singles',
  'frontpage',
  'all',
]);

let cachedLocationId = null;
let inventoryApiAvailable = null;

const STOCK_SCOPE_HINT =
  'Enable Shopify Admin API scopes: read_locations, read_inventory, write_inventory (Dev Dashboard → app → Versions → scopes), then reinstall on the store.';

const PRODUCTS_SCOPE_HINT =
  'Enable read_products (and write_products) on your Dev Dashboard app version, then reinstall on the store.';

function formatShopifyError(err) {
  const status = err.response?.status;
  const data = err.response?.data;
  if (status === 403) {
    const msg = typeof data?.errors === 'string' ? data.errors : JSON.stringify(data?.errors || '');
    if (/product|smart_collection|graphql/i.test(msg)) {
      return `Shopify permission denied (403). ${PRODUCTS_SCOPE_HINT}`;
    }
    return `Shopify permission denied (403). ${STOCK_SCOPE_HINT}`;
  }
  if (status === 401) {
    return 'Shopify unauthorized (401). Check SHOPIFY_CLIENT_ID/SECRET or SHOPIFY_TOKEN in .env / Railway.';
  }
  if (status === 429) {
    return 'Shopify rate limit — too many API calls. Wait a few seconds and try again.';
  }
  if (data?.errors) {
    return typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors);
  }
  return err.message || 'Shopify request failed';
}

async function checkInventoryApiAccess() {
  if (inventoryApiAvailable !== null) return inventoryApiAvailable;
  try {
    const { client } = await getClient();
    await client.get('/locations.json');
    inventoryApiAvailable = true;
  } catch (err) {
    inventoryApiAvailable = false;
    if (err.response?.status === 403) {
      console.warn(`[Shopify] Inventory API 403 — ${STOCK_SCOPE_HINT}`);
    }
  }
  return inventoryApiAvailable;
}

async function getClient() {
  const store = process.env.SHOPIFY_STORE || '';
  const accessToken = await getAccessToken();
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-04';
  const host = store.includes('.myshopify.com') ? store : `${store.replace(/\.myshopify\.com$/i, '')}.myshopify.com`;
  const BASE = `https://${host}/admin/api/${apiVersion}`;
  const client = axios.create({
    baseURL: BASE,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    timeout: 60000,
  });

  if (getAuthMode() === 'client_credentials') {
    client.interceptors.response.use(
      (r) => r,
      async (err) => {
        const config = err.config;
        if (!config || config._shopifyTokenRetry || err.response?.status !== 401) {
          throw err;
        }
        clearTokenCache();
        const freshToken = await getAccessToken();
        config._shopifyTokenRetry = true;
        config.headers['X-Shopify-Access-Token'] = freshToken;
        return client.request(config);
      }
    );
  }

  attachShopifyThrottle(client);
  return { client, BASE };
}

function slugifyTag(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function getPrimaryLocationId() {
  if (!(await checkInventoryApiAccess())) return null;
  if (cachedLocationId) return cachedLocationId;
  const { client } = await getClient();
  const res = await client.get('/locations.json');
  const location = res.data.locations?.find((l) => l.active) || res.data.locations?.[0];
  if (!location) throw new Error('No Shopify location found for inventory');
  cachedLocationId = location.id;
  return cachedLocationId;
}

let cachedUsdNzd = { at: 0, rate: 1.65 };

async function getUsdToNzdRate() {
  if (Date.now() - cachedUsdNzd.at < 300000) return cachedUsdNzd.rate;
  try {
    const res = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 5000 });
    const rate = res.data?.rates?.NZD;
    if (rate) {
      cachedUsdNzd = { at: Date.now(), rate };
      console.log(`[Currency] Live USD→NZD rate: ${rate}`);
      return rate;
    }
  } catch (err) {
    console.warn('[Currency] Could not fetch live rate, using fallback:', err.message);
  }
  return cachedUsdNzd.rate;
}

function buildListingIndex(products) {
  const index = new Map();
  for (const p of products) {
    if (p.collectrId) index.set(listingKey(p.collectrId, p.subType), p);
  }
  return index;
}

/** REST inventory APIs need a numeric inventory item id (not a GID). */
function normalizeInventoryItemId(id) {
  if (id == null || id === '') return null;
  const s = String(id).trim();
  const gid = s.match(/InventoryItem\/(\d+)/i);
  if (gid) return gid[1];
  if (/^\d+$/.test(s)) return s;
  return null;
}

/** REST product/variant ids must be numeric (not GID strings). */
function normalizeLegacyResourceId(id) {
  if (id == null || id === '') return null;
  const s = String(id).trim();
  const gid = s.match(/\/(\d+)$/);
  if (gid) return gid[1];
  if (/^\d+$/.test(s)) return s;
  return null;
}

async function getInventoryQuantity(inventoryItemId) {
  const itemId = normalizeInventoryItemId(inventoryItemId);
  if (!itemId) return 0;
  const { client } = await getClient();
  const locationId = await getPrimaryLocationId();
  if (!locationId) return 0;
  try {
    const res = await client.get('/inventory_levels.json', {
      params: { inventory_item_ids: itemId, location_ids: locationId },
    });
    const level = res.data.inventory_levels?.[0];
    return level ? level.available : 0;
  } catch (err) {
    if (err.response?.status === 404) return 0;
    throw err;
  }
}

async function setInventoryQuantity(inventoryItemId, quantity) {
  const itemId = normalizeInventoryItemId(inventoryItemId);
  if (!itemId) return null;
  const locationId = await getPrimaryLocationId();
  if (!locationId) return null;
  const { client } = await getClient();
  const payload = {
    location_id: locationId,
    inventory_item_id: itemId,
    available: Math.max(0, quantity),
  };

  try {
    await client.post('/inventory_levels/set.json', payload);
  } catch (err) {
    if (err.response?.status === 404) {
      await client.post('/inventory_levels/connect.json', {
        location_id: locationId,
        inventory_item_id: itemId,
      });
      await client.post('/inventory_levels/set.json', payload);
    } else {
      throw err;
    }
  }
  return Math.max(0, quantity);
}

/** After product create, Shopify may not return inventory_item_id until tracking is enabled. */
async function resolveInventoryItemId(client, productId, variantId) {
  const pid = normalizeLegacyResourceId(productId);
  const vid = normalizeLegacyResourceId(variantId);
  if (!pid) return null;

  const fetchVariant = async () => {
    const res = await client.get(`/products/${pid}.json`);
    return res.data.product?.variants?.[0];
  };

  let variant = await fetchVariant();
  let itemId = normalizeInventoryItemId(variant?.inventory_item_id);
  if (itemId) return itemId;

  if (vid) {
    await enableInventoryTracking(vid);
    variant = await fetchVariant();
    itemId = normalizeInventoryItemId(variant?.inventory_item_id);
  }
  return itemId;
}

async function getStockMetafield(productId) {
  const pid = normalizeLegacyResourceId(productId);
  if (!pid) return 0;
  const { client } = await getClient();
  const res = await client.get(`/products/${pid}/metafields.json`).catch(() => ({ data: { metafields: [] } }));
  const mf = res.data.metafields?.find((m) => m.namespace === 'custom' && m.key === 'stock_qty');
  return mf ? parseInt(mf.value, 10) || 0 : 0;
}

async function setStockMetafield(productId, quantity) {
  const productGid = toGid('Product', productId);
  if (!productGid) return Math.max(0, quantity);
  try {
    return await setStockMetafieldGraphql(productGid, quantity);
  } catch (err) {
    console.warn('[Shopify] stock_qty metafield failed:', formatShopifyError(err));
    return Math.max(0, quantity);
  }
}

async function enableInventoryTracking(variantId) {
  const vid = normalizeLegacyResourceId(variantId);
  if (!vid) return;
  const { client } = await getClient();
  await client.put(`/variants/${vid}.json`, {
    variant: {
      id: vid,
      inventory_management: 'shopify',
      inventory_policy: 'deny',
    },
  });
}

/**
 * Create smart collection for a TCG set (subcategory) if missing.
 */
async function upsertSmartCollection(def) {
  const { client } = await getClient();
  const existingRes = await client.get('/smart_collections.json', {
    params: { handle: def.handle, limit: 1 },
  });
  const existing = existingRes.data.smart_collections?.[0];

  const payload = {
    smart_collection: {
      title: def.title,
      handle: def.handle,
      body_html: def.body_html,
      published: true,
      disjunctive: false,
      rules: def.rules,
      sort_order: def.sort_order || 'created-desc',
    },
  };

  if (existing) {
    await client.put(`/smart_collections/${existing.id}.json`, payload);
    console.log(`[Shopify] Collection updated: ${def.title} (/collections/${def.handle})`);
    return existing.id;
  }

  const res = await client.post('/smart_collections.json', payload);
  console.log(`[Shopify] Collection created: ${def.title} (/collections/${def.handle})`);
  return res.data.smart_collection.id;
}

/** Homepage + nav collections — newest first so Recently Added shows latest cards. */
async function ensureHomepageCollections() {
  const defs = [
    {
      title: 'Recently Added Singles',
      handle: 'new-arrivals',
      body_html: '<p>Latest singles added to HoloVault.</p>',
      rules: [{ column: 'tag', relation: 'equals', condition: 'collectr-managed' }],
      sort_order: 'created-desc',
    },
    {
      title: 'Pokémon',
      handle: 'pokemon',
      body_html: '<p>All Pokémon TCG singles at HoloVault.</p>',
      rules: [{ column: 'tag', relation: 'equals', condition: 'pokemon' }],
      sort_order: 'created-desc',
    },
    {
      title: 'Singles',
      handle: 'singles',
      body_html: '<p>Individual Pokémon TCG singles.</p>',
      rules: [{ column: 'type', relation: 'equals', condition: 'Pokemon Card' }],
      sort_order: 'created-desc',
    },
  ];

  for (const def of defs) {
    try {
      await upsertSmartCollection(def);
    } catch (err) {
      console.warn(`[Shopify] Collection ${def.handle} skipped:`, formatShopifyError(err));
    }
  }
}

async function ensureSetSmartCollection(setName) {
  if (!setName || !setName.trim()) return null;
  const tag = slugifyTag(setName);
  const handle = tag;
  if (CORE_COLLECTION_HANDLES.has(handle)) return null;

  return upsertSmartCollection({
    title: setName.trim(),
    handle,
    body_html: `<p>Pokémon TCG singles from ${setName.trim()}.</p>`,
    rules: [{ column: 'tag', relation: 'equals', condition: tag }],
    sort_order: 'created-desc',
  });
}

function formatSubTypeForStore(subType) {
  if (!subType) return '';
  return subType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function setProductMetafields(productId, card, multiplier) {
  const { client } = await getClient();
  const ownerId = String(productId).startsWith('gid://')
    ? productId
    : `gid://shopify/Product/${normalizeLegacyResourceId(productId)}`;
  const finish = formatSubTypeForStore(card.subType);

  const metafields = [
    { namespace: 'custom', key: 'market_price', type: 'number_decimal', value: String(card.price || 0) },
    {
      namespace: 'custom',
      key: 'market_price_nzd',
      type: 'number_decimal',
      value: String((card.price || 0) * multiplier),
    },
    { namespace: 'custom', key: 'price_change', type: 'number_decimal', value: String(card.priceChange || 0) },
    {
      namespace: 'custom',
      key: 'price_change_pct',
      type: 'number_decimal',
      value: String(card.priceChangePct || 0),
    },
    { namespace: 'custom', key: 'multiplier', type: 'number_decimal', value: multiplier.toString() },
    {
      namespace: 'custom',
      key: 'collectr_id',
      type: 'single_line_text_field',
      value: card.collectrId ? card.collectrId.toString() : '',
    },
    { namespace: 'custom', key: 'collectr_url', type: 'single_line_text_field', value: card.collectrUrl || '' },
    { namespace: 'custom', key: 'card_sub_type', type: 'single_line_text_field', value: finish },
    { namespace: 'custom', key: 'card_number', type: 'single_line_text_field', value: card.cardNumber || '' },
    { namespace: 'custom', key: 'set_name', type: 'single_line_text_field', value: card.setName || '' },
    { namespace: 'custom', key: 'last_synced', type: 'single_line_text_field', value: new Date().toISOString() },
  ].map((mf) => ({ ...mf, ownerId }));

  const mutation = `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphql(client, mutation, { metafields });
  const errors = data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    console.warn('[Shopify] metafieldsSet:', errors.map((e) => e.message).join('; '));
  }
}

async function createProduct(card, multiplier = 1.0, options = {}) {
  const { skipCollection = false, usdRate = null } = options;
  const { client } = await getClient();
  const rate = usdRate ?? (await getUsdToNzdRate());
  const finalPrice = (card.price * multiplier * rate).toFixed(2);
  const useInventory = await checkInventoryApiAccess();
  let warning = null;

  const body = {
    product: {
      title: buildProductTitle(card),
      body_html: buildDescription(card),
      vendor: card.setName || 'Pokemon TCG',
      product_type: 'Pokemon Card',
      tags: 'collectr-managed, pokemon, ' + buildTags(card),
      variants: [
        {
          price: finalPrice,
          inventory_management: useInventory ? 'shopify' : null,
          fulfillment_service: 'manual',
          inventory_policy: useInventory ? 'deny' : 'continue',
        },
      ],
      images: card.imageUrl ? [{ src: card.imageUrl }] : [],
    },
  };

  const res = await client.post('/products.json', body);
  const product = res.data.product;
  const variant = product.variants[0];

  await setProductMetafields(product.id, card, multiplier);

  let quantity = 1;
  if (useInventory) {
    const inventoryItemId = await resolveInventoryItemId(client, product.id, variant.id);
    if (inventoryItemId) {
      try {
        await setInventoryQuantity(inventoryItemId, 1);
      } catch (err) {
        console.warn('[Shopify] Could not set inventory, using stock metafield:', formatShopifyError(err));
        warning = STOCK_SCOPE_HINT;
        await setStockMetafield(product.id, 1);
      }
    } else {
      warning = STOCK_SCOPE_HINT;
      await setStockMetafield(product.id, 1);
    }
  } else {
    await setStockMetafield(product.id, 1);
  }

  const inventoryItemId = normalizeInventoryItemId(variant?.inventory_item_id)
    || (await resolveInventoryItemId(client, product.id, variant.id));

  if (!skipCollection) {
    try {
      await ensureHomepageCollections();
    } catch (err) {
      console.warn('[Shopify] Homepage collections skipped:', formatShopifyError(err));
    }
    if (card.setName) {
      try {
        await ensureSetSmartCollection(card.setName);
      } catch (err) {
        console.warn('[Shopify] Set collection skipped:', formatShopifyError(err));
      }
    }
  }

  return { product, quantity, incremented: false, warning };
}

async function shopifyGraphql(client, query, variables = {}) {
  const res = await client.post('/graphql.json', { query, variables });
  if (res.data?.errors?.length) {
    const err = new Error(res.data.errors.map((e) => e.message).join('; '));
    err.response = { status: 403, data: { errors: res.data.errors } };
    throw err;
  }
  return res.data?.data;
}

function legacyId(gidOrId) {
  if (gidOrId == null) return null;
  const s = String(gidOrId);
  const m = s.match(/\/(\d+)$/);
  return m ? m[1] : s;
}

function toGid(resource, id) {
  if (id == null || id === '') return null;
  const s = String(id).trim();
  if (s.startsWith('gid://')) return s;
  const num = normalizeLegacyResourceId(s);
  return num ? `gid://shopify/${resource}/${num}` : null;
}

let cachedLocationGid = null;

async function getPrimaryLocationGid() {
  if (cachedLocationGid) return cachedLocationGid;
  const locationId = await getPrimaryLocationId();
  if (!locationId) return null;
  cachedLocationGid = `gid://shopify/Location/${locationId}`;
  return cachedLocationGid;
}

async function setInventoryQuantityGraphql(listing, quantity) {
  const inventoryItemGid =
    listing.inventoryItemGid || toGid('InventoryItem', listing.inventoryItemId);
  const locationGid = await getPrimaryLocationGid();
  if (!inventoryItemGid || !locationGid) {
    throw new Error('Missing inventory item or location for stock update');
  }

  const { client } = await getClient();
  const mutation = `
    mutation InvSet($input: InventorySetOnHandQuantitiesInput!) {
      inventorySetOnHandQuantities(input: $input) {
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphql(client, mutation, {
    input: {
      reason: 'correction',
      setQuantities: [
        {
          inventoryItemId: inventoryItemGid,
          locationId: locationGid,
          quantity: Math.max(0, quantity),
        },
      ],
    },
  });
  const errors = data?.inventorySetOnHandQuantities?.userErrors;
  if (errors?.length) {
    throw new Error(errors.map((e) => e.message).join('; '));
  }
  return Math.max(0, quantity);
}

async function setStockMetafieldGraphql(productGid, quantity) {
  const ownerId = productGid?.startsWith('gid://')
    ? productGid
    : toGid('Product', productGid);
  if (!ownerId) return Math.max(0, quantity);

  const qty = Math.max(0, quantity);
  const { client } = await getClient();
  const mutation = `
    mutation StockQtySet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphql(client, mutation, {
    metafields: [
      {
        ownerId,
        namespace: 'custom',
        key: 'stock_qty',
        type: 'number_integer',
        value: String(qty),
      },
    ],
  });
  const errors = data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    throw new Error(errors.map((e) => e.message).join('; '));
  }
  return qty;
}

async function updateProductPriceGraphql(listing, card, multiplier = 1.0, usdRate = null) {
  const productGid = listing.productGid || toGid('Product', listing.productId);
  const variantGid = listing.variantGid || toGid('ProductVariant', listing.variantId);
  if (!productGid || !variantGid) {
    throw new Error('Missing product/variant GID for price update');
  }

  const rate = usdRate ?? (await getUsdToNzdRate());
  const finalPrice = (card.price * multiplier * rate).toFixed(2);
  const { client } = await getClient();
  const mutation = `
    mutation VariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphql(client, mutation, {
    productId: productGid,
    variants: [{ id: variantGid, price: finalPrice }],
  });
  const errors = data?.productVariantsBulkUpdate?.userErrors;
  if (errors?.length) {
    throw new Error(errors.map((e) => e.message).join('; '));
  }

  await setProductMetafields(productGid, card, multiplier);
  return finalPrice;
}

function warnMissingShopifyScopes(scopes) {
  const required = [
    'write_products',
    'read_products',
    'write_inventory',
    'read_inventory',
    'read_locations',
  ];
  const have = new Set((scopes || '').split(/[,\s]+/).filter(Boolean));
  const missing = required.filter((s) => !have.has(s));
  if (!missing.length) return;
  console.warn(`⚠️  Missing Shopify API scopes: ${missing.join(', ')}`);
  console.warn(
    '   Shopify Dev Dashboard → App → Versions → Access scopes → add missing scopes → Release → redeploy Railway.'
  );
}

/** Collectr uses one product_id per finish; Foil and Normal share an id but differ by subType. */
function normalizeSubType(subType) {
  return (subType || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ');
}

function listingKey(collectrId, subType) {
  return `${String(collectrId)}::${normalizeSubType(subType)}`;
}

function subTypesMatch(a, b) {
  return normalizeSubType(a) === normalizeSubType(b);
}

function resolveListingFinish(listing) {
  return (
    listing?.subType ||
    parseFinishFromTitle(listing?.title) ||
    ''
  ).trim();
}

/** Pick one Shopify row for this Collectr card (same collectr_id; disambiguate by finish when needed). */
function pickBestExistingListing(candidates, card) {
  if (!candidates?.length || !card?.collectrId) return null;

  const collectrId = String(card.collectrId);
  const sameId = candidates.filter((l) => l && String(l.collectrId) === collectrId);
  if (!sameId.length) return null;

  for (const listing of sameId) {
    if (!listing.subType) {
      const finish = resolveListingFinish(listing);
      if (finish) listing.subType = finish;
    }
  }

  if (sameId.length === 1) return sameId[0];

  const want = normalizeSubType(card.subType);
  if (want) {
    const byFinish = sameId.filter((listing) => {
      const have = normalizeSubType(resolveListingFinish(listing));
      if (!have) return true;
      return want === have;
    });
    if (byFinish.length >= 1) return byFinish[0];
  }

  const finishes = [
    ...new Set(sameId.map((l) => normalizeSubType(resolveListingFinish(l))).filter(Boolean)),
  ];
  if (finishes.length === 1) return sameId[0];

  console.log(
    `[Shopify] ${sameId.length} store listings for collectr ${collectrId}; finish "${card.subType || 'none'}" — no unique match`
  );
  return null;
}

function isStaleListingError(err) {
  const msg = String(err?.message || formatShopifyError(err) || '').toLowerCase();
  return (
    msg.includes('owner does not exist') ||
    msg.includes('could not be found') ||
    msg.includes('does not exist') ||
    msg.includes('not found')
  );
}

function buildExistingListing(product, metafields) {
  const variant = product.variants?.[0];
  const collectrIdMf = metafields.find((m) => m.namespace === 'custom' && m.key === 'collectr_id');
  const collectrUrlMf = metafields.find((m) => m.namespace === 'custom' && m.key === 'collectr_url');
  const multiplierMf = metafields.find((m) => m.namespace === 'custom' && m.key === 'multiplier');
  const subTypeMf = metafields.find((m) => m.namespace === 'custom' && m.key === 'card_sub_type');

  return {
    productId: product.id,
    variantId: variant?.id,
    inventoryItemId: normalizeInventoryItemId(variant?.inventory_item_id),
    inventoryManagement: variant?.inventory_management,
    inventoryQuantity: variant?.inventory_quantity ?? null,
    title: product.title,
    collectrId: collectrIdMf?.value || null,
    collectrUrl: collectrUrlMf?.value || null,
    subType: subTypeMf?.value || null,
    multiplier: multiplierMf ? parseFloat(multiplierMf.value) : 1.0,
  };
}

function nodeToExistingListing(node, collectrId) {
  const variant = node.variants?.edges?.[0]?.node;
  const mfId = node.collectrId?.value;
  if (!mfId || String(mfId) !== String(collectrId)) return null;

  const subType =
    node.subType?.value?.trim() || parseFinishFromTitle(node.title) || null;

  return {
    productId: node.legacyResourceId,
    productGid: node.id,
    variantId: variant?.legacyResourceId,
    variantGid: variant?.id,
    inventoryItemId: legacyId(variant?.inventoryItem?.id),
    inventoryItemGid: variant?.inventoryItem?.id || null,
    inventoryManagement: variant?.inventoryItem ? 'shopify' : null,
    inventoryQuantity: variant?.inventoryQuantity ?? null,
    title: node.title,
    collectrId: mfId,
    collectrUrl: node.collectrUrl?.value || null,
    subType,
    multiplier: node.multiplier?.value ? parseFloat(node.multiplier.value) : 1.0,
  };
}

function managedProductToExistingListing(product) {
  if (!product?.collectrId) return null;
  return {
    productId: product.productId,
    productGid: product.productGid,
    variantId: product.variantId,
    variantGid: product.variantGid,
    inventoryItemId: product.inventoryItemId,
    inventoryItemGid: product.inventoryItemGid,
    inventoryManagement: product.inventoryManagement,
    inventoryQuantity: product.inventoryQuantity,
    title: product.title,
    collectrId: product.collectrId,
    collectrUrl: product.collectrUrl,
    subType: product.subType,
    multiplier: product.multiplier,
  };
}

/** Live catalog scan (same source as GET /api/products) — no in-memory product cache. */
async function findExistingListingFromStore(card) {
  const products = await getManagedProducts();
  const candidates = products
    .map(managedProductToExistingListing)
    .filter(Boolean);
  return pickBestExistingListing(candidates, card);
}

/**
 * Find existing listing on Shopify (live Admin API only — no in-memory product cache).
 */
async function findExistingListing(card) {
  if (!card?.collectrId) return null;
  try {
    let found = await findExistingListingGraphql(card);
    let via = 'search';
    if (!found) {
      found = await findExistingListingFromStore(card);
      via = 'catalog';
    }
    if (found) {
      console.log(
        `[Shopify] Store check (${via}): found ${found.title} (collectr ${card.collectrId}, ${card.subType || 'default'})`
      );
    }
    return found;
  } catch (err) {
    console.warn('[Shopify] Store listing lookup failed:', formatShopifyError(err));
    return null;
  }
}

async function findExistingListingGraphql(card) {
  const { client } = await getClient();
  const collectrId = String(card.collectrId).trim();
  const query = `
    query FindCollectrProduct($query: String!) {
      products(first: 25, query: $query) {
        edges {
          node {
            id
            legacyResourceId
            title
            variants(first: 1) {
              edges {
                node {
                  id
                  legacyResourceId
                  inventoryQuantity
                  inventoryItem { id }
                }
              }
            }
            collectrId: metafield(namespace: "custom", key: "collectr_id") { value }
            collectrUrl: metafield(namespace: "custom", key: "collectr_url") { value }
            multiplier: metafield(namespace: "custom", key: "multiplier") { value }
            subType: metafield(namespace: "custom", key: "card_sub_type") { value }
          }
        }
      }
    }
  `;

  const searchQueries = [
    `tag:collectr-managed metafields.custom.collectr_id:${collectrId}`,
    `tag:collectr-managed metafields.custom.collectr_id:"${collectrId}"`,
  ];

  const candidates = [];
  for (const searchQuery of searchQueries) {
    const data = await shopifyGraphql(client, query, { query: searchQuery });
    const edges = data?.products?.edges || [];
    for (const edge of edges) {
      const node = edge?.node;
      if (!node) continue;
      const listing = nodeToExistingListing(node, collectrId);
      if (listing) candidates.push(listing);
    }
    if (candidates.length) break;
  }

  return pickBestExistingListing(candidates, card);
}

/** @deprecated Use findExistingListing(card) — id alone is not unique across Foil/Normal. */
async function findProductByCollectrId(collectrId) {
  return findExistingListing({ collectrId, subType: '' });
}

/**
 * Add stock to an existing listing (same Collectr product_id).
 * Uses GraphQL first (works with write_products + write_inventory on Railway).
 */
async function incrementProductStock(existing, card, multiplier = 1.0, options = {}) {
  const { skipCollection = false, usdRate = null } = options;
  let warning = null;

  let listing = { ...existing };
  if (!listing.productGid || !listing.variantGid) {
    try {
      const fresh = await findExistingListing(card);
      if (fresh) listing = { ...listing, ...fresh };
    } catch (err) {
      console.warn('[Shopify] GraphQL listing refresh skipped:', formatShopifyError(err));
    }
  }

  listing.productId = normalizeLegacyResourceId(listing.productId);
  listing.variantId = normalizeLegacyResourceId(listing.variantId);
  listing.productGid = listing.productGid || toGid('Product', listing.productId);
  listing.variantGid = listing.variantGid || toGid('ProductVariant', listing.variantId);
  listing.inventoryItemGid =
    listing.inventoryItemGid || toGid('InventoryItem', listing.inventoryItemId);

  const currentQty =
    listing.inventoryQuantity != null
      ? Number(listing.inventoryQuantity)
      : await getStockMetafield(listing.productId);
  const newQty = (Number.isFinite(currentQty) ? currentQty : 0) + 1;

  let stockUpdated = false;
  if (listing.inventoryItemGid) {
    try {
      await setInventoryQuantityGraphql(listing, newQty);
      stockUpdated = true;
    } catch (err) {
      console.warn('[Shopify] GraphQL inventory bump failed:', formatShopifyError(err));
    }
  }

  if (!stockUpdated && listing.productGid) {
    try {
      await setStockMetafieldGraphql(listing.productGid, newQty);
      stockUpdated = true;
      warning = STOCK_SCOPE_HINT;
    } catch (err) {
      console.warn('[Shopify] GraphQL stock metafield failed:', formatShopifyError(err));
      throw new Error(formatShopifyError(err));
    }
  }

  if (!stockUpdated) {
    throw new Error('Could not update stock — product GID missing. Check Shopify app scopes.');
  }

  let finalPrice = null;
  try {
    finalPrice = await updateProductPriceGraphql(listing, card, multiplier, usdRate);
  } catch (err) {
    console.warn('[Shopify] Price update skipped on stock increment:', formatShopifyError(err));
    warning = warning || formatShopifyError(err);
  }

  if (!skipCollection) {
    try {
      await ensureHomepageCollections();
    } catch (err) {
      console.warn('[Shopify] Homepage collections skipped:', formatShopifyError(err));
    }
    if (card.setName) {
      try {
        await ensureSetSmartCollection(card.setName);
      } catch (err) {
        console.warn('[Shopify] Set collection skipped:', formatShopifyError(err));
      }
    }
  }

  const updated = {
    id: listing.productId,
    title: listing.title,
    variants: listing.variantId
      ? [{ id: listing.variantId, inventory_quantity: newQty }]
      : [],
  };

  return {
    product: updated,
    quantity: newQty,
    incremented: true,
    price: finalPrice,
    warning,
  };
}

/**
 * Add new listing or bump quantity if same Collectr card already exists on Shopify.
 * @param {object} options.bulk — defer collection + cache flush (use bulkAddCards)
 */
async function addOrUpdateProduct(card, multiplier = 1.0, options = {}) {
  if (!card.collectrId) {
    throw new Error('Collectr product id missing — cannot deduplicate listings');
  }

  const bulkOpts = options.bulk
    ? {
        skipCollection: true,
        usdRate: options.usdRate,
      }
    : {};

  const existing = await findExistingListing(card);
  if (existing) {
    console.log(
      `[Shopify] Duplicate ${card.collectrId} (${card.subType || 'default'}) → qty +1 on ${existing.title}`
    );
    try {
      return await incrementProductStock(existing, card, multiplier, bulkOpts);
    } catch (err) {
      if (isStaleListingError(err)) {
        console.warn(
          `[Shopify] Listing gone for ${card.collectrId} (${card.subType || 'default'}) — creating new product`
        );
        return createProduct(card, multiplier, bulkOpts);
      }
      throw err;
    }
  }

  return createProduct(card, multiplier, bulkOpts);
}

async function updateProductPrice(productId, variantId, card, multiplier = 1.0, usdRate = null) {
  const pid = normalizeLegacyResourceId(productId);
  let vid = normalizeLegacyResourceId(variantId);
  const { client } = await getClient();

  if (!vid && pid) {
    const res = await client.get(`/products/${pid}.json`);
    vid = res.data.product?.variants?.[0]?.id;
  }
  if (!vid) {
    throw new Error(`No variant found for product ${pid || productId}`);
  }

  const rate = usdRate ?? (await getUsdToNzdRate());
  const finalPrice = (card.price * multiplier * rate).toFixed(2);

  await client.put(`/variants/${vid}.json`, {
    variant: {
      id: vid,
      price: finalPrice,
    },
  });

  await setProductMetafields(pid, card, multiplier);

  return finalPrice;
}

/**
 * Add many cards sequentially (rate-limited). One Collectr search per card is NOT needed — pass card payloads from search.
 */
async function bulkAddCards(cards, defaultMultiplier = 1.0, options = {}) {
  const { onlyNew = false } = options;
  const maxCards = parseInt(process.env.BULK_MAX_CARDS || '100', 10);
  if (!cards?.length) {
    return { added: 0, incremented: 0, skipped: 0, failed: 0, total: 0, errors: [], durationMs: 0 };
  }
  if (cards.length > maxCards) {
    throw new Error(`Bulk add limited to ${maxCards} cards per batch. Split into smaller batches.`);
  }

  const started = Date.now();
  const results = { added: 0, incremented: 0, skipped: 0, failed: 0, total: cards.length, errors: [] };

  const usdRate = await getUsdToNzdRate();
  await checkInventoryApiAccess();

  let toProcess = cards;
  if (onlyNew) {
    toProcess = [];
    for (const card of cards) {
      if (!card.collectrId) continue;
      const exists = await findExistingListingGraphql(card);
      if (!exists) toProcess.push(card);
    }
    results.skipped = cards.length - toProcess.length;
  }

  const setsToEnsure = new Set();
  console.log(`[Bulk] Processing ${toProcess.length} cards (${results.skipped} skipped as already listed)...`);

  for (let i = 0; i < toProcess.length; i++) {
    const card = toProcess[i];
    const mult = parseFloat(card._multiplier) || defaultMultiplier;
    try {
      const result = await addOrUpdateProduct(card, mult, {
        bulk: true,
        usdRate,
      });
      if (card.setName) setsToEnsure.add(card.setName.trim());

      if (result.incremented) results.incremented++;
      else results.added++;
    } catch (err) {
      results.failed++;
      results.errors.push({
        name: card.name,
        subType: card.subType,
        error: formatShopifyError(err),
      });
      console.error(`[Bulk] ${i + 1}/${toProcess.length} failed:`, card.name, err.message);
    }
  }

  try {
    await ensureHomepageCollections();
  } catch (err) {
    console.warn('[Bulk] Homepage collections skipped:', formatShopifyError(err));
  }

  for (const setName of setsToEnsure) {
    try {
      await ensureSetSmartCollection(setName);
    } catch (err) {
      console.warn(`[Bulk] Collection skipped for ${setName}:`, formatShopifyError(err));
    }
  }

  results.durationMs = Date.now() - started;
  console.log(
    `[Bulk] Done in ${(results.durationMs / 1000).toFixed(1)}s — added ${results.added}, +qty ${results.incremented}, skipped ${results.skipped}, failed ${results.failed}`
  );
  return results;
}

/**
 * Parse card # and finish from product description (legacy listings before metafields).
 */
function parseCardFieldsFromDescription(descriptionHtml) {
  if (!descriptionHtml) return { cardNumber: null, subType: null };
  const strip = (s) => s.replace(/<[^>]+>/g, '').trim();

  const numMatch =
    descriptionHtml.match(/<strong>Number:<\/strong>\s*([^<]+)/i) ||
    descriptionHtml.match(/Number:\s*([0-9]+\s*\/\s*[0-9]+)/i);
  const finishMatch =
    descriptionHtml.match(/<strong>Finish:<\/strong>\s*([^<]+)/i) ||
    descriptionHtml.match(/Finish:\s*([^<\n]+)/i);

  return {
    cardNumber: numMatch ? strip(numMatch[1]) : null,
    subType: finishMatch ? strip(finishMatch[1]) : null,
  };
}

function parseFinishFromTitle(title) {
  if (!title) return null;
  const m = title.match(/\s+—\s+([^—]+)$/);
  return m ? m[1].trim() : null;
}

function enrichManagedProductFields({ title, descriptionHtml, cardNumberMeta, subTypeMeta }) {
  const fromDesc = parseCardFieldsFromDescription(descriptionHtml);
  const fromTitle = parseFinishFromTitle(title);
  const cardNumber = cardNumberMeta || fromDesc.cardNumber || null;
  const subType = subTypeMeta || fromDesc.subType || fromTitle || null;

  return {
    cardNumber,
    subType,
    cardNumberMetaMissing: !cardNumberMeta && !!cardNumber,
    subTypeMetaMissing: !subTypeMeta && !!subType,
    needsMetafieldBackfill:
      (!cardNumberMeta && !!cardNumber) || (!subTypeMeta && !!subType),
  };
}

async function backfillCardMetafields(product) {
  if (!product.needsMetafieldBackfill) return;

  const { client } = await getClient();
  const ownerId = `gid://shopify/Product/${product.productId}`;
  const metafields = [];

  if (product.cardNumberMetaMissing && product.cardNumber) {
    metafields.push({
      namespace: 'custom',
      key: 'card_number',
      type: 'single_line_text_field',
      value: product.cardNumber,
      ownerId,
    });
  }
  if (product.subTypeMetaMissing && product.subType) {
    metafields.push({
      namespace: 'custom',
      key: 'card_sub_type',
      type: 'single_line_text_field',
      value: formatSubTypeForStore(product.subType),
      ownerId,
    });
  }

  if (!metafields.length) return;

  const mutation = `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphql(client, mutation, { metafields });
  const errors = data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    console.warn(
      `[Shopify] card metafield backfill ${product.productId}:`,
      errors.map((e) => e.message).join('; ')
    );
  } else {
    console.log(`[Shopify] Backfilled card_number/finish metafields for product ${product.productId}`);
  }
}

/** Ensure card # and finish (from description/title if needed) and save metafields for legacy products. */
async function ensureProductCardFields(product) {
  if (product.needsMetafieldBackfill) {
    await backfillCardMetafields(product);
    product.needsMetafieldBackfill = false;
    product.cardNumberMetaMissing = false;
    product.subTypeMetaMissing = false;
  }
  return product;
}

async function getManagedProducts() {
  const { client } = await getClient();
  const query = `
    query ManagedProducts($cursor: String) {
      products(first: 50, query: "tag:collectr-managed", sortKey: CREATED_AT, reverse: true, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            legacyResourceId
            title
            createdAt
            descriptionHtml
            featuredImage { url }
            variants(first: 1) {
              edges {
                node {
                  id
                  legacyResourceId
                  price
                  inventoryQuantity
                  inventoryItem { id }
                }
              }
            }
            collectrId: metafield(namespace: "custom", key: "collectr_id") { value }
            collectrUrl: metafield(namespace: "custom", key: "collectr_url") { value }
            multiplier: metafield(namespace: "custom", key: "multiplier") { value }
            subType: metafield(namespace: "custom", key: "card_sub_type") { value }
            cardNumber: metafield(namespace: "custom", key: "card_number") { value }
            stockQty: metafield(namespace: "custom", key: "stock_qty") { value }
          }
        }
      }
    }
  `;

  const result = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const data = await shopifyGraphql(client, query, { cursor });
    const connection = data?.products;
    for (const edge of connection?.edges || []) {
      const node = edge?.node;
      if (!node) continue;
      const variant = node.variants?.edges?.[0]?.node;
      let inventoryQuantity = variant?.inventoryQuantity ?? null;
      const metaQty = node.stockQty?.value ? parseInt(node.stockQty.value, 10) : 0;
      if ((inventoryQuantity == null || inventoryQuantity === 0) && metaQty > 0) {
        inventoryQuantity = metaQty;
      }

      const cardNumberMeta = node.cardNumber?.value?.trim() || '';
      const subTypeMeta = node.subType?.value?.trim() || '';
      const enriched = enrichManagedProductFields({
        title: node.title,
        descriptionHtml: node.descriptionHtml,
        cardNumberMeta,
        subTypeMeta,
      });

      result.push({
        productId: node.legacyResourceId,
        productGid: node.id,
        variantId: variant?.legacyResourceId,
        variantGid: variant?.id,
        inventoryItemId: legacyId(variant?.inventoryItem?.id),
        inventoryItemGid: variant?.inventoryItem?.id || null,
        inventoryManagement: variant?.inventoryItem?.id ? 'shopify' : null,
        inventoryQuantity,
        title: node.title,
        createdAt: node.createdAt || null,
        imageUrl: node.featuredImage?.url || null,
        price: variant?.price || null,
        collectrId: node.collectrId?.value || null,
        collectrUrl: node.collectrUrl?.value || null,
        subType: enriched.subType,
        cardNumber: enriched.cardNumber,
        needsMetafieldBackfill: enriched.needsMetafieldBackfill,
        cardNumberMetaMissing: enriched.cardNumberMetaMissing,
        subTypeMetaMissing: enriched.subTypeMetaMissing,
        multiplier: node.multiplier?.value ? parseFloat(node.multiplier.value) : 1.0,
      });
    }
    hasNext = connection?.pageInfo?.hasNextPage;
    cursor = connection?.pageInfo?.endCursor || null;
  }

  result.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return result;
}

async function setMultiplier(productId, multiplier) {
  const { client } = await getClient();
  await client.post(`/products/${productId}/metafields.json`, {
    metafield: {
      namespace: 'custom',
      key: 'multiplier',
      value: multiplier.toString(),
      type: 'number_decimal',
    },
  });
}

function buildProductTitle(card) {
  const name = (card.name || '').trim();
  const sub = formatSubTypeForStore(card.subType).trim();
  if (!sub) return name;
  if (name.toLowerCase().includes(sub.toLowerCase())) return name;
  return `${name} — ${sub}`;
}

function buildDescription(card) {
  const parts = [];
  if (card.subType) parts.push(`<strong>Finish:</strong> ${card.subType}`);
  if (card.setName) parts.push(`<strong>Set:</strong> ${card.setName}`);
  if (card.cardNumber) parts.push(`<strong>Number:</strong> ${card.cardNumber}`);
  if (card.rarity) parts.push(`<strong>Rarity:</strong> ${card.rarity}`);
  parts.push(`<em>Price sourced from Collectr. Updated daily.</em>`);
  return parts.join('<br>');
}

function buildTags(card) {
  const tags = ['pokemon', 'tcg'];
  const name = (card.name || '').toLowerCase();
  const set = (card.setName || '').toLowerCase();

  if (name.includes('(cn)') || set.includes('chinese') || set.includes('gem pack')) {
    tags.push('chinese');
  } else if (name.includes('(jp)') || set.includes('japanese')) {
    tags.push('japanese');
  } else {
    tags.push('english');
  }

  if (card.setName) tags.push(slugifyTag(card.setName));
  if (card.rarity) tags.push(slugifyTag(card.rarity));
  return tags.join(', ');
}

async function deleteProduct(productId) {
  const { client } = await getClient();
  const pid = normalizeLegacyResourceId(productId);
  await client.delete(`/products/${pid}.json`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delete every product tagged collectr-managed (Card Manager listings).
 */
async function deleteAllManagedProducts() {
  const products = await getManagedProducts();
  const results = { deleted: 0, failed: 0, total: products.length, errors: [] };

  console.log(`[Shopify] Deleting ${products.length} managed products...`);

  for (const product of products) {
    try {
      await deleteProduct(product.productId);
      results.deleted++;
      console.log(`  ✓ Deleted: ${product.title}`);
      await sleep(400);
    } catch (err) {
      results.failed++;
      results.errors.push({ product: product.title, error: err.message });
      console.error(`  ✗ ${product.title}:`, err.message);
    }
  }

  return results;
}

module.exports = {
  createProduct,
  addOrUpdateProduct,
  bulkAddCards,
  buildListingIndex,
  updateProductPrice,
  ensureProductCardFields,
  parseCardFieldsFromDescription,
  enrichManagedProductFields,
  getManagedProducts,
  findExistingListing,
  findExistingListingGraphql,
  findProductByCollectrId,
  listingKey,
  normalizeSubType,
  setMultiplier,
  deleteProduct,
  deleteAllManagedProducts,
  ensureSetSmartCollection,
  ensureHomepageCollections,
  slugifyTag,
  formatShopifyError,
  checkInventoryApiAccess,
  warnMissingShopifyScopes,
  STOCK_SCOPE_HINT,
  hasShopifyCredentials,
  getAuthMode,
  getAuthStatus,
  ensureAccessToken: getAccessToken,
};
