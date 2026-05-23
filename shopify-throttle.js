/**
 * Shopify Admin API leaky-bucket limit (~2 req/s on many stores).
 * Serializes requests and retries 429s with backoff.
 */

const MIN_GAP_MS = parseInt(process.env.SHOPIFY_API_GAP_MS || '550', 10);
const MAX_429_RETRIES = 5;

let chain = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleRequest(run) {
  const job = chain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, MIN_GAP_MS - (now - lastRequestAt));
    if (wait) await sleep(wait);
    lastRequestAt = Date.now();
    return run();
  });
  chain = job.catch(() => {});
  return job;
}

function attachShopifyThrottle(client) {
  const request = client.request.bind(client);

  client.request = (config) =>
    scheduleRequest(async () => {
      let lastErr;
      for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
        try {
          return await request(config);
        } catch (err) {
          lastErr = err;
          const status = err.response?.status;
          if (status !== 429 || attempt === MAX_429_RETRIES) throw err;

          const retryAfterHeader = err.response?.headers?.['retry-after'];
          const retrySec = retryAfterHeader ? parseFloat(retryAfterHeader) : 2;
          const backoffMs = Math.max(retrySec * 1000, 1000 * 2 ** attempt);
          console.warn(
            `[Shopify] Rate limited (429), retry ${attempt + 1}/${MAX_429_RETRIES} in ${backoffMs}ms`
          );
          await sleep(backoffMs);
          lastRequestAt = Date.now();
        }
      }
      throw lastErr;
    });

  return client;
}

module.exports = { attachShopifyThrottle, scheduleRequest, sleep };
