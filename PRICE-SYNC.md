# Price sync — how it works & troubleshooting

## How the right price is pulled

1. Each product added from the **Card Manager** stores:
   - `custom.collectr_id` — exact Collectr listing (variant)
   - `custom.collectr_url` — link with `?productId=…`
   - `custom.card_sub_type` — e.g. Holofoil, Reverse Holofoil, Normal

2. **Sync** (button or daily cron) searches Collectr by product title and matches **`product_id`**, not “first search result”. That fixes wrong prices when many variants share a name.

3. **USD → NZD**: Collectr prices are USD; Shopify price = `USD × multiplier × live NZD rate`.

## Sync button / cron not updating?

Check in order:

| Check | Fix |
|-------|-----|
| App running? | Railway service **holovault** must be deployed and **Running** |
| `SHOPIFY_STORE` | Must be `holo-vault-3.myshopify.com` (not an old store from chat.md) |
| `SHOPIFY_TOKEN` | Valid Admin API token with `read_products`, `write_products` |
| Product tag | Only products tagged **`collectr-managed`** sync |
| `collectr_id` metafield | Old products added before fix may lack id — **re-add from search** or run sync after re-saving |
| Collectr HTML | If all syncs fail with “Could not fetch price”, Collectr may have changed their site — check Railway logs |
| Sync response | UI now shows `X updated, Y failed` — open browser console for error list |

## Run sync locally

```bash
cd app
npm install
node sync-prices.js
```

## Railway cron

Default: `0 6 * * *` (6:00 UTC daily). Set `CRON_SCHEDULE` in Railway Variables.

Cron only runs while the **Node server is running** (not a separate worker unless you add one).

## Wrong price on one card

1. Open **Card Manager** → search the exact variant on Collectr (note **Finish**: Normal / Holo / Reverse Holo).
2. If the Shopify product was added from the wrong search row, delete and re-add the correct listing.
3. Click **Sync Prices Now** — confirm `1 updated` for that product in the toast.

## Duplicate cards (same Collectr listing)

Adding the **same Collectr `product_id` again** in Card Manager:

- Does **not** create a second Shopify product
- **Increases stock** by 1 on the existing listing
- Refreshes price and metafields (including **% today** badge)

Match key: `custom.collectr_id` (set when the card is first added).

## Inventory & sold out

- New and restocked cards use **tracked inventory** (`deny` when out of stock)
- Storefront shows **1 in stock**, **2 in stock**, or **Sold out**
- When a customer buys the last copy, Shopify shows **Sold out** (listing stays; you do not need to delete)

Older products created before this update may need one **re-add +1** or a manual inventory enable in Admin.

## Set subcategories (Journey Together, Gem Pack, etc.)

When a card is added, the app creates a **smart collection** for that set (tag = set slug, e.g. `gem-pack`).

- URL: `/collections/gem-pack`
- Header **Sets** menu lists set collections automatically

Run **Sync Prices Now** once to refresh metafields on older listings.

## Finish / variant on storefront

- New products: finish saved to metafield + product description.
- **Existing products**: run sync once (writes `card_sub_type`) or re-add from Collectr search.
