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

/** In-process cache so immediate re-adds find the listing before Shopify search indexes metafields. */
const collectrIdCache = new Map();

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

async function getUsdToNzdRate() {
  try {
    const res = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 5000 });
    const rate = res.data?.rates?.NZD;
    if (rate) {
      console.log(`[Currency] Live USD→NZD rate: ${rate}`);
      return rate;
    }
  } catch (err) {
    console.warn('[Currency] Could not fetch live rate, using fallback:', err.message);
  }
  return 1.65;
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

async function getInventoryQuantity(inventoryItemId) {
  const itemId = normalizeInventoryItemId(inventoryItemId);
  if (!itemId) return 0;
  const { client } = await getClient();
  const locationId = await getPrimaryLocationId();
  if (!locationId) return 0;
  const res = await client.get('/inventory_levels.json', {
    params: { inventory_item_ids: itemId, location_ids: locationId },
  });
  const level = res.data.inventory_levels?.[0];
  return level ? level.available : 0;
}

async function setInventoryQuantity(inventoryItemId, quantity) {
  const itemId = normalizeInventoryItemId(inventoryItemId);
  if (!itemId) return null;
  const locationId = await getPrimaryLocationId();
  if (!locationId) return null;
  const { client } = await getClient();
  await client.post('/inventory_levels/set.json', {
    location_id: locationId,
    inventory_item_id: itemId,
    available: Math.max(0, quantity),
  });
  return Math.max(0, quantity);
}

/** After product create, Shopify may not return inventory_item_id until tracking is enabled. */
async function resolveInventoryItemId(client, productId, variantId) {
  const fetchVariant = async () => {
    const res = await client.get(`/products/${productId}.json`);
    return res.data.product?.variants?.[0];
  };

  let variant = await fetchVariant();
  let itemId = normalizeInventoryItemId(variant?.inventory_item_id);
  if (itemId) return itemId;

  if (variantId) {
    await enableInventoryTracking(variantId);
    variant = await fetchVariant();
    itemId = normalizeInventoryItemId(variant?.inventory_item_id);
  }
  return itemId;
}

async function getStockMetafield(productId) {
  const { client } = await getClient();
  const res = await client.get(`/products/${productId}/metafields.json`).catch(() => ({ data: { metafields: [] } }));
  const mf = res.data.metafields?.find((m) => m.namespace === 'custom' && m.key === 'stock_qty');
  return mf ? parseInt(mf.value, 10) || 0 : 0;
}

async function setStockMetafield(productId, quantity) {
  const { client } = await getClient();
  await client.post(`/products/${productId}/metafields.json`, {
    metafield: {
      namespace: 'custom',
      key: 'stock_qty',
      value: String(Math.max(0, quantity)),
      type: 'number_integer',
    },
  }).catch(() => {});
  return Math.max(0, quantity);
}

async function enableInventoryTracking(variantId) {
  const { client } = await getClient();
  await client.put(`/variants/${variantId}.json`, {
    variant: {
      id: variantId,
      inventory_management: 'shopify',
      inventory_policy: 'deny',
    },
  });
}

/**
 * Create smart collection for a TCG set (subcategory) if missing.
 */
async function ensureSetSmartCollection(setName) {
  if (!setName || !setName.trim()) return null;
  const tag = slugifyTag(setName);
  const handle = tag;
  if (CORE_COLLECTION_HANDLES.has(handle)) return null;

  const { client } = await getClient();
  const existingRes = await client.get('/smart_collections.json', {
    params: { handle, limit: 1 },
  });
  const existing = existingRes.data.smart_collections?.[0];

  const payload = {
    smart_collection: {
      title: setName.trim(),
      handle,
      body_html: `<p>Pokémon TCG singles from ${setName.trim()}.</p>`,
      published: true,
      disjunctive: false,
      rules: [{ column: 'tag', relation: 'equals', condition: tag }],
    },
  };

  if (existing) {
    await client.put(`/smart_collections/${existing.id}.json`, payload);
    console.log(`[Shopify] Set collection updated: ${setName} (/collections/${handle})`);
    return existing.id;
  }

  const res = await client.post('/smart_collections.json', payload);
  console.log(`[Shopify] Set collection created: ${setName} (/collections/${handle})`);
  return res.data.smart_collection.id;
}

async function setProductMetafields(productId, card, multiplier) {
  const { client } = await getClient();

  const metafields = [
    { namespace: 'custom', key: 'market_price', value: String(card.price || 0), type: 'number_decimal' },
    { namespace: 'custom', key: 'market_price_nzd', value: String((card.price || 0) * multiplier), type: 'number_decimal' },
    { namespace: 'custom', key: 'price_change', value: String(card.priceChange || 0), type: 'number_decimal' },
    { namespace: 'custom', key: 'price_change_pct', value: String(card.priceChangePct || 0), type: 'number_decimal' },
    { namespace: 'custom', key: 'multiplier', value: multiplier.toString(), type: 'number_decimal' },
    { namespace: 'custom', key: 'collectr_id', value: card.collectrId ? card.collectrId.toString() : '', type: 'single_line_text_field' },
    { namespace: 'custom', key: 'collectr_url', value: card.collectrUrl || '', type: 'single_line_text_field' },
    { namespace: 'custom', key: 'card_sub_type', value: card.subType || '', type: 'single_line_text_field' },
    { namespace: 'custom', key: 'set_name', value: card.setName || '', type: 'single_line_text_field' },
    { namespace: 'custom', key: 'last_synced', value: new Date().toISOString(), type: 'single_line_text_field' },
  ];

  for (const mf of metafields) {
    await client.post(`/products/${productId}/metafields.json`, { metafield: mf }).catch(() => {});
  }
}

async function createProduct(card, multiplier = 1.0) {
  const { client } = await getClient();
  const rate = await getUsdToNzdRate();
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

  cacheCollectrListing(card.collectrId, {
    productId: product.id,
    variantId: variant.id,
    inventoryItemId,
    inventoryManagement: useInventory ? 'shopify' : null,
    inventoryQuantity: quantity,
    title: product.title,
    collectrId: String(card.collectrId),
    collectrUrl: card.collectrUrl || null,
    subType: card.subType || null,
    multiplier,
  });

  try {
    await ensureSetSmartCollection(card.setName);
  } catch (err) {
    console.warn('[Shopify] Set collection skipped:', formatShopifyError(err));
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

function cacheCollectrListing(collectrId, listing) {
  if (collectrId && listing) collectrIdCache.set(String(collectrId), listing);
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

/** REST scan by collectr_id metafield (immediate; does not wait for Shopify search index). */
async function findProductByCollectrIdRest(collectrId) {
  const { client, BASE } = await getClient();
  const target = String(collectrId);
  let url = '/products.json?limit=250&fields=id,title,variants,tags';

  while (url) {
    const res = await client.get(url.startsWith('/') ? url : url.replace(BASE, ''));
    for (const product of res.data.products) {
      if (!product.tags?.includes('collectr-managed')) continue;
      const mfRes = await client
        .get(`/products/${product.id}/metafields.json`)
        .catch(() => ({ data: { metafields: [] } }));
      const mf = mfRes.data.metafields?.find(
        (m) => m.namespace === 'custom' && m.key === 'collectr_id' && String(m.value) === target
      );
      if (mf) return buildExistingListing(product, mfRes.data.metafields);
    }

    const linkHeader = res.headers.link;
    if (linkHeader?.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = match ? match[1].replace(BASE, '') : null;
    } else {
      url = null;
    }
  }
  return null;
}

/**
 * Find existing listing by Collectr product_id (cache → GraphQL → REST metafield scan).
 */
async function findProductByCollectrId(collectrId) {
  if (!collectrId) return null;
  const key = String(collectrId);

  if (collectrIdCache.has(key)) {
    return collectrIdCache.get(key);
  }

  let found = null;
  try {
    found = await findProductByCollectrIdFast(collectrId);
  } catch (err) {
    console.warn('[Shopify] GraphQL collectr_id lookup failed:', formatShopifyError(err));
  }

  if (!found) {
    found = await findProductByCollectrIdRest(collectrId);
  }

  if (found) cacheCollectrListing(key, found);
  return found;
}

async function findProductByCollectrIdFast(collectrId) {
  const { client } = await getClient();
  const query = `
    query FindCollectrProduct($query: String!) {
      products(first: 1, query: $query) {
        edges {
          node {
            legacyResourceId
            title
            variants(first: 1) {
              edges {
                node {
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
  const searchQuery = `tag:collectr-managed metafields.custom.collectr_id:${collectrId}`;
  const data = await shopifyGraphql(client, query, { query: searchQuery });
  const node = data?.products?.edges?.[0]?.node;
  if (!node) return null;

  const variant = node.variants?.edges?.[0]?.node;
  const mfId = node.collectrId?.value;
  if (!mfId || String(mfId) !== String(collectrId)) return null;

  return {
    productId: node.legacyResourceId,
    variantId: variant?.legacyResourceId,
    inventoryItemId: legacyId(variant?.inventoryItem?.id),
    inventoryManagement: variant?.inventoryItem ? 'shopify' : null,
    inventoryQuantity: variant?.inventoryQuantity ?? null,
    title: node.title,
    collectrId: mfId || String(collectrId),
    collectrUrl: node.collectrUrl?.value || null,
    subType: node.subType?.value || null,
    multiplier: node.multiplier?.value ? parseFloat(node.multiplier.value) : 1.0,
  };
}

/**
 * Add stock to an existing listing (same Collectr product_id).
 */
async function incrementProductStock(existing, card, multiplier = 1.0) {
  const { client } = await getClient();
  const useInventory = await checkInventoryApiAccess();
  let newQty;
  let warning = null;

  if (useInventory) {
    let inventoryItemId = existing.inventoryItemId;

    inventoryItemId = normalizeInventoryItemId(inventoryItemId);
    if (!inventoryItemId) {
      inventoryItemId = await resolveInventoryItemId(client, existing.productId, existing.variantId);
    } else if (existing.inventoryManagement !== 'shopify' && existing.variantId) {
      await enableInventoryTracking(existing.variantId);
      inventoryItemId = await resolveInventoryItemId(client, existing.productId, existing.variantId);
    }

    if (inventoryItemId) {
      try {
        const currentQty = await getInventoryQuantity(inventoryItemId);
        newQty = currentQty + 1;
        await setInventoryQuantity(inventoryItemId, newQty);
      } catch (err) {
        console.warn('[Shopify] Inventory bump failed, using stock metafield:', formatShopifyError(err));
        const currentQty = await getStockMetafield(existing.productId);
        newQty = currentQty + 1;
        await setStockMetafield(existing.productId, newQty);
        warning = STOCK_SCOPE_HINT;
      }
    } else {
      const currentQty = await getStockMetafield(existing.productId);
      newQty = currentQty + 1;
      await setStockMetafield(existing.productId, newQty);
      warning = STOCK_SCOPE_HINT;
    }
  } else {
    const currentQty = await getStockMetafield(existing.productId);
    newQty = currentQty + 1;
    await setStockMetafield(existing.productId, newQty);
    warning = STOCK_SCOPE_HINT;
  }

  const finalPrice = await updateProductPrice(
    existing.productId,
    existing.variantId,
    card,
    multiplier
  );

  try {
    await ensureSetSmartCollection(card.setName);
  } catch (err) {
    console.warn('[Shopify] Set collection skipped:', formatShopifyError(err));
  }

  const res = await client.get(`/products/${existing.productId}.json`);
  const updated = res.data.product;
  const variant = updated.variants?.[0];
  cacheCollectrListing(card.collectrId, {
    ...existing,
    productId: updated.id,
    variantId: variant?.id,
    inventoryItemId:
      normalizeInventoryItemId(variant?.inventory_item_id) || existing.inventoryItemId,
    inventoryQuantity: newQty,
    title: updated.title,
  });

  return {
    product: updated,
    quantity: newQty,
    incremented: true,
    price: finalPrice,
    warning,
  };
}

/**
 * Add new listing or bump quantity if same Collectr card already exists.
 */
async function addOrUpdateProduct(card, multiplier = 1.0) {
  if (!card.collectrId) {
    throw new Error('Collectr product id missing — cannot deduplicate listings');
  }

  const existing = await findProductByCollectrId(card.collectrId);
  if (existing) {
    console.log(`[Shopify] Duplicate collectr_id ${card.collectrId} → qty +1 on ${existing.title}`);
    const result = await incrementProductStock(existing, card, multiplier);
    return result;
  }

  return createProduct(card, multiplier);
}

async function updateProductPrice(productId, variantId, card, multiplier = 1.0) {
  const { client } = await getClient();
  const rate = await getUsdToNzdRate();
  const finalPrice = (card.price * multiplier * rate).toFixed(2);

  await client.put(`/variants/${variantId}.json`, {
    variant: {
      id: variantId,
      price: finalPrice,
    },
  });

  await setProductMetafields(productId, card, multiplier);

  return finalPrice;
}

async function getManagedProducts() {
  const { client, BASE } = await getClient();
  const products = [];
  let url = '/products.json?limit=250&fields=id,title,variants,tags';

  while (url) {
    const res = await client.get(url.startsWith('/') ? url : url.replace(BASE, ''));
    products.push(...res.data.products);

    const linkHeader = res.headers['link'];
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = match ? match[1].replace(BASE, '') : null;
    } else {
      url = null;
    }
  }

  const managed = products.filter((p) => p.tags && p.tags.includes('collectr-managed'));

  const result = [];
  for (const product of managed) {
    const mfRes = await client
      .get(`/products/${product.id}/metafields.json`)
      .catch(() => ({ data: { metafields: [] } }));
    const metafields = mfRes.data.metafields;

    const collectrId = metafields.find((m) => m.key === 'collectr_id');
    const collectrUrl = metafields.find((m) => m.key === 'collectr_url');
    const multiplier = metafields.find((m) => m.key === 'multiplier');
    const subType = metafields.find((m) => m.key === 'card_sub_type');
    const variant = product.variants[0];

    let inventoryQuantity = variant?.inventory_quantity ?? null;
    if (variant?.inventory_item_id && variant.inventory_management === 'shopify' && inventoryApiAvailable !== false) {
      try {
        if (await checkInventoryApiAccess()) {
          inventoryQuantity = await getInventoryQuantity(variant.inventory_item_id);
        }
      } catch {
        inventoryQuantity = variant.inventory_quantity;
      }
    }
    if (inventoryQuantity == null || (inventoryApiAvailable === false && variant?.inventory_management !== 'shopify')) {
      const metaQty = await getStockMetafield(product.id);
      if (metaQty > 0) inventoryQuantity = metaQty;
    }

    result.push({
      productId: product.id,
      variantId: variant?.id,
      inventoryItemId: variant?.inventory_item_id,
      inventoryManagement: variant?.inventory_management,
      inventoryQuantity,
      title: product.title,
      collectrId: collectrId?.value || null,
      collectrUrl: collectrUrl?.value || null,
      subType: subType?.value || null,
      multiplier: multiplier ? parseFloat(multiplier.value) : 1.0,
    });
  }

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
  const sub = (card.subType || '').trim();
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
  await client.delete(`/products/${productId}.json`);
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
  updateProductPrice,
  getManagedProducts,
  findProductByCollectrId,
  setMultiplier,
  deleteProduct,
  deleteAllManagedProducts,
  ensureSetSmartCollection,
  slugifyTag,
  formatShopifyError,
  checkInventoryApiAccess,
  STOCK_SCOPE_HINT,
  hasShopifyCredentials,
  getAuthMode,
  getAuthStatus,
  ensureAccessToken: getAccessToken,
};
