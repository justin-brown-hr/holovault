# Bulk adding many cards

## In the Card Manager UI

1. Search Collectr (e.g. set name or card name).
2. Use the **bulk bar** under the search box:
   - **Add all new (N)** — only cards not already on the store (recommended).
   - **Add all results** — every row; existing listings get +1 stock.
3. Set **Default ×** multiplier for the batch (per-card multipliers still apply if you edited them).
4. Wait for the progress modal — do not close the tab.

Large imports run in **batches of 50** automatically to avoid Railway timeouts.

## Rough timing

Shopify allows ~**2 API calls per second**. Each new card uses ~4–6 calls → about **3 seconds per card**.

| Cards | Approx. time |
|-------|----------------|
| 10    | ~30 sec        |
| 30    | ~1.5 min       |
| 100   | ~5 min (2 batches) |

## Server env (optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SHOPIFY_API_GAP_MS` | `550` | Ms between Shopify requests |
| `BULK_MAX_CARDS` | `100` | Max cards per API batch |
| `MANAGED_PRODUCTS_CACHE_MS` | `45000` | Product list cache |

## Tips

- Run **one search per set** (e.g. "surging sparks") then **Add all new**.
- Use **Sync Prices** after bulk import, not during.
- If you hit rate limits, wait 30s and run the next batch — the app retries 429s automatically.
