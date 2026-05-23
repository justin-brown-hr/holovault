# Railway deploy — Holo Vault app

Repo: **https://github.com/justin-brown-hr/holovault**  
Branch: **`main`**  
Root directory: **leave empty** (app files are at repo root, not in an `app/` folder)

---

## Fix: "GitHub Repo not found"

Railway lost the link to GitHub. Redeploy alone will **not** update code until this is fixed.

### 1. Reconnect GitHub

1. Open [Railway Dashboard](https://railway.app) → your project → **holovault** service  
2. **Settings** → **Source** (or **Connect Repo**)  
3. **Disconnect** the broken repo if shown  
4. **Connect GitHub** → authorize Railway if prompted  
5. Select **`justin-brown-hr/holovault`** (not the old monorepo path)  
6. Branch: **`main`**

If the repo does not appear:

- GitHub → **Settings** → **Applications** → **Railway** → configure → grant access to **justin-brown-hr** org or your user  
- Repo must be visible to the GitHub account linked to Railway  

### 2. Root directory

**Settings** → **Build** → **Root Directory**:

- Must be **empty** or `/`  
- If it still says `app`, delete it — the monorepo was split; code is at repo root now  

### 3. Environment variables

**Variables** tab — ensure these exist:

| Variable | Example |
|----------|---------|
| `SHOPIFY_STORE` | `holo-vault-3.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Dev Dashboard app client id |
| `SHOPIFY_CLIENT_SECRET` | Dev Dashboard client secret (token auto-refreshes) |
| `SHOPIFY_API_VERSION` | `2024-04` |

**Add card works locally but fails on Railway?**

1. Open `https://YOUR-RAILWAY-URL/api/status` — `connected` must be `true` and `scopes` must include `read_products`, `write_products`.
2. `SHOPIFY_STORE` must be `holo-vault-3.myshopify.com` (not an old dev store).
3. Prefer **client id + secret** over an expired `SHOPIFY_TOKEN`.
4. After changing variables, **Redeploy** the service.
5. Check **Deployments → Logs** when Add card fails; the UI now shows the Shopify error detail.
| `DEFAULT_MULTIPLIER` | `1.0` |
| `CRON_SCHEDULE` | `0 6 * * *` |

### 4. Deploy

After reconnecting: **Deployments** → **Deploy** (or push any commit to `main`).

Check build logs — you should see `npm install` and `npm start` from repo root.

---

## Verify GitHub has latest code

```bash
cd app
git push origin main
```

Latest commit on GitHub should match:

```bash
git log -1 --oneline
```

---

## Deploy without GitHub (CLI fallback)

```bash
npm install -g @railway/cli
cd app
railway login
railway link    # pick your project
railway up
```

This uploads local files directly until GitHub is reconnected.
