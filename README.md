# Holo Vault — Price Sync Tool

Automatically syncs Pokémon card prices from Collectr to your Shopify store.

Deployed on **Railway** from this repo (`justin-brown-hr/holovault`). See `.env.example` for env vars.

**Railway shows "GitHub Repo not found"?** See [RAILWAY.md](./RAILWAY.md) — reconnect repo, clear root directory `app`, redeploy.

---

## Setup (One Time)

### 1. Shopify credentials (auto-refresh)

Use your **Dev Dashboard** app (e.g. Pricecheck) on `holo-vault-3`:

1. **Versions** → enable scopes: `read_products`, `write_products`, `read_locations`, `read_inventory`, `write_inventory`
2. Install the app on the store
3. Copy **Client ID** and **Client secret** from the app settings
4. Copy `.env.example` to `.env` and set:
   - `SHOPIFY_STORE=holo-vault-3.myshopify.com`
   - `SHOPIFY_CLIENT_ID=…`
   - `SHOPIFY_CLIENT_SECRET=…`

The server fetches a new access token automatically (~24h lifetime) — you do **not** need to paste a new `shpat_` daily.

Optional: set `SHOPIFY_TOKEN` instead if you prefer a static token (manual refresh when it expires).

### 2. Install Dependencies

```bash
cd app
npm install
npx playwright install chromium
```

### 3. Start the App

```bash
npm start
```

Open http://localhost:3000 in your browser.

---

## How to Use

**Full guide:** [USAGE.md](./USAGE.md)

### Add many cards (bulk — recommended)
1. Search Collectr (set name or card name)
2. Tick cards (new ones are auto-selected)
3. Click **Import selected (N)** — wait for the progress modal
4. For multiple searches: use **Add selected to queue**, then **Import queue to Shopify**

~3 seconds per card. Do **not** click each **+ Add to Shopify** unless you only need one card.

### Add one card
Search → set **×** → **+ Add to Shopify** on that row.

### Daily price sync
- Automatic cron (default **6:00 UTC**)
- Or click **⟳ Sync Prices Now** in the UI

### Change multiplier
Left panel → edit **×** → **Save** → run sync or wait for cron.

---

## Install the Price Badge on Your Shopify Theme

1. In Shopify Admin → **Online Store** → **Themes** → **Edit code**
2. Upload `shopify-theme/snippets/collectr-badge.liquid` to the `snippets/` folder
3. Open your product card template (usually `snippets/card-product.liquid`)
4. Find where the price is displayed and add:
   ```liquid
   {% render 'collectr-badge', product: product %}
   ```
5. Save — the badge will show on all cards managed by this tool

---

## File Structure

```
app/
├── server.js          # Express server + cron job
├── collectr.js        # Scrapes Collectr for card data & prices
├── shopify.js         # Shopify Admin API wrapper
├── sync-prices.js     # Daily price sync logic
├── .env               # Shopify credentials (local / Railway Variables)
├── public/
│   └── index.html     # Admin UI (search, add, manage)
└── package.json

shopify-theme/
└── snippets/
    └── collectr-badge.liquid   # Price badge for your theme
```

---

## Environment variables

See `.env.example`. On Railway, set the same keys in **Variables**.

- `DEFAULT_MULTIPLIER` — default for new cards (1.0 = 100% of market)
- `CRON_SCHEDULE` — daily sync (default `0 6 * * *`)
