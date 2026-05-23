# Holo Vault Card Manager — Usage Guide

Open the app: **http://localhost:3000** (local) or your **Railway URL** (production).

---

## Screen layout

| Area | Purpose |
|------|---------|
| **Left** — Managed Products | Everything already on Shopify from this tool |
| **Right** — Search & Add | Find cards on Collectr and import them |
| **Top** — Sync Prices Now | Updates all managed cards from Collectr (daily cron also runs) |

---

## Quick start: add many cards (recommended)

You do **not** need to click **Add to Shopify** on every card.

1. In the search box, type a **set name** or card name (e.g. `surging sparks`, `boltund`).
2. Click **Search**.
3. New cards are **checked automatically**. Use **Select all** / **New only** if you want to change selection.
4. Set **Default ×** (e.g. `1.0` = Collectr USD price converted to NZD; `0.9` = 90% of market).
5. Click the green button: **Import selected (N)**.
6. Wait for the progress window — **keep the tab open** until it finishes.

**Speed:** about **3 seconds per new card** (Shopify API limits).

---

## Import across multiple searches (queue)

Use this when one search doesn’t show every card (Collectr returns up to ~30 per search).

1. Search **Set A** → tick the cards you want → **Add selected to queue**.
2. Search **Set B** → tick more cards → **Add selected to queue** again.
3. A green bar appears at the **bottom**: **Import queue to Shopify**.
4. One import runs for **all queued cards**.

---

## Buttons under the search box

| Button | When to use |
|--------|-------------|
| **Import selected (N)** | Main action — imports all checked cards |
| **All new only (N)** | Skips cards already on the store |
| **Add selected to queue** | Save selection; search again and add more |
| **Select all** | Check every search result |
| **New only** | Check only cards not listed yet |
| **Clear** | Uncheck all |

---

## Add a single card

1. Search → find the card.
2. Set **×** on that row if you want a custom multiplier.
3. Click **+ Add to Shopify** on that card only.

---

## Foil vs Normal (same card name)

Collectr often uses the **same product ID** for Foil and Normal with different **finish** labels.

- They are stored as **separate Shopify products** (e.g. `Boltund — Foil` and `Boltund — Normal`).
- Importing Normal will **not** add stock to Foil.
- Always pick the correct row (check the purple **finish** tag on each result).

---

## After importing

| Task | How |
|------|-----|
| Update prices | **⟳ Sync Prices Now** — shows live progress (card X of Y, updated/failed counts) |
| Change markup on one card | Left panel → edit **×** → **Save** |
| Add another copy in stock | Search same card + finish → **Import selected** or **+ Add** (qty +1) |
| Remove one listing | Left panel → **Delete** on that product |
| Remove everything | **Delete all managed products** (requires typing confirm in API) |

---

## Multiplier examples

| × value | Meaning |
|---------|---------|
| `1.0` | Collectr USD × live NZD rate |
| `0.9` | 90% of that price |
| `1.1` | 110% of that price |

Price is set at **import time**; **Sync** refreshes from Collectr using the saved multiplier on each product.

---

## If something goes wrong

| Problem | What to do |
|---------|------------|
| **Rate limit / 429** | Wait 30 seconds; try again. App auto-retries. Avoid running Sync during a big import. |
| **“All new only (0)”** | Every result is already on the store, or finish doesn’t match — check left panel. |
| **Wrong finish on storefront** | Re-import with correct row, or run **Sync** after metafields exist. Theme shows finish from `card_sub_type` or title. |
| **Duplicate listings** | Same card + same finish added twice before duplicate fix — delete extra in Shopify Admin. |
| **Import stuck** | Don’t close the tab. Check Railway/local terminal logs. Large jobs split into batches of 50. |
| **Auth errors** | Check `.env` / Railway: `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_STORE`. Open `/api/status` for scopes. |

---

## Typical workflow for a new set

1. Search the set name on Collectr.
2. **Import selected** (or queue several searches, then import queue).
3. Repeat search with different keywords if the set is large.
4. When done, click **⟳ Sync Prices Now** once.
5. Check a few products on the live store (price, finish label, stock).

---

## Environment (admin)

See `.env.example`. Minimum:

```env
SHOPIFY_STORE=holo-vault-3.myshopify.com
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
```

Token refreshes automatically — no daily `shpat_` copy/paste.

More detail: [BULK-ADD.md](./BULK-ADD.md) · [PRICE-SYNC.md](./PRICE-SYNC.md) · [RAILWAY.md](./RAILWAY.md)
