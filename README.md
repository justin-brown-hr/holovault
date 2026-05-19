# Holo Vault — Price Sync Tool

Automatically syncs Pokémon card prices from Collectr to your Shopify store.

Deployed on **Railway** from this repo (`justin-brown-hr/holovault`). See `.env.example` for env vars.

---

## Setup (One Time)

### 1. Get Your Shopify Admin API Token

1. Go to https://admin.shopify.com/store/holo-vault-3/settings/apps
2. Click **Develop apps** → **Create an app**
3. Name it `Price Sync`
4. Click **Configure Admin API scopes** and enable:
   - `write_products`
   - `read_products`
5. Click **Install app** → copy the **Admin API access token**
6. Copy `app/.env.example` to `app/.env` and set `SHOPIFY_TOKEN=shpat_…`

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

### Add a Card
1. Type a card name in the search box (e.g. "Charizard ex")
2. Results load from Collectr with live prices
3. Set a multiplier (e.g. `0.8` = sell at 80% of market price, `1.0` = exact market price)
4. Click **+ Add to Shopify** — the card is created as a product automatically

### Daily Price Sync
- Prices update automatically every day at **6:00 AM**
- You can also click **⟳ Sync Prices Now** in the admin UI to sync immediately

### Change a Card's Multiplier
- In the **Managed Products** list, change the multiplier and click **Save**
- The new price applies on the next sync

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
