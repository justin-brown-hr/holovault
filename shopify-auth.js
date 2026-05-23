/**
 * Shopify access token — auto-refresh via Dev Dashboard client credentials.
 * Falls back to static SHOPIFY_TOKEN if set without client id/secret.
 */

require('dotenv').config();

const axios = require('axios');

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
  scope: null,
};

function shopDomain() {
  const store = (process.env.SHOPIFY_STORE || '').trim();
  if (!store) return '';
  if (store.includes('.myshopify.com')) return store;
  return `${store.replace(/\.myshopify\.com$/i, '')}.myshopify.com`;
}

function hasShopifyCredentials() {
  const store = shopDomain();
  const clientId = process.env.SHOPIFY_CLIENT_ID || '';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_SECRET || '';
  if (store && clientId && clientSecret) return true;
  return !!(store && process.env.SHOPIFY_TOKEN);
}

function getAuthMode() {
  const clientId = process.env.SHOPIFY_CLIENT_ID || '';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_SECRET || '';
  if (clientId && clientSecret) return 'client_credentials';
  if (process.env.SHOPIFY_TOKEN) return 'static_token';
  return 'none';
}

function getAuthStatus() {
  const mode = getAuthMode();
  if (mode === 'client_credentials' && tokenCache.accessToken) {
    const msLeft = tokenCache.expiresAt - Date.now();
    return {
      mode,
      scopes: tokenCache.scope,
      expiresInHours: msLeft > 0 ? Math.round(msLeft / 3600000) : 0,
      expiresAt: new Date(tokenCache.expiresAt).toISOString(),
    };
  }
  return { mode, scopes: null, expiresInHours: null, expiresAt: null };
}

async function fetchClientCredentialsToken() {
  const domain = shopDomain();
  const clientId = process.env.SHOPIFY_CLIENT_ID || '';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_SECRET || '';

  if (!domain || !clientId || !clientSecret) {
    throw new Error('SHOPIFY_STORE, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET are required for auto-refresh.');
  }

  const res = await axios.post(
    `https://${domain}/admin/oauth/access_token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    }
  );

  const { access_token, expires_in, scope } = res.data;
  if (!access_token) {
    throw new Error('Shopify token response missing access_token');
  }

  const ttlMs = (expires_in || 86399) * 1000;
  tokenCache = {
    accessToken: access_token,
    expiresAt: Date.now() + ttlMs - 120000,
    scope: scope || '',
  };

  console.log(
    `[Shopify] Token refreshed (client credentials), scopes: ${tokenCache.scope}, ~${Math.round((expires_in || 86400) / 3600)}h validity`
  );

  return access_token;
}

/**
 * Return a valid Admin API access token (cached; refreshes before expiry).
 */
async function getAccessToken() {
  const clientId = process.env.SHOPIFY_CLIENT_ID || '';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_SECRET || '';

  if (clientId && clientSecret) {
    if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
      return tokenCache.accessToken;
    }
    return fetchClientCredentialsToken();
  }

  const staticToken = process.env.SHOPIFY_TOKEN || '';
  if (staticToken) return staticToken;

  throw new Error(
    'No Shopify credentials. Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard), or SHOPIFY_TOKEN.'
  );
}

async function ensureAccessToken() {
  return getAccessToken();
}

function clearTokenCache() {
  tokenCache = { accessToken: null, expiresAt: 0, scope: null };
}

module.exports = {
  getAccessToken,
  ensureAccessToken,
  hasShopifyCredentials,
  getAuthMode,
  getAuthStatus,
  clearTokenCache,
  shopDomain,
};
