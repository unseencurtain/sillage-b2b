# Change the wholesale shop / dashboard domains

This shop has **two** public hostnames: WooCommerce and the ops dashboard. Product photos
are wholesale-perfumes catalog **`flask_front` URLs** (hotlinks). There is no `images.*`
CDN and no `wholesale-media` container.

The JPEG folder `~/ecom_sites/data/media` and `https://images.prinscosmetic.eu` belong to
**Sillage retail**. BTS has no vendor photos, so those files live on the VPS for the retail
shop. Do not point this wholesale stack at that directory.

**Current live names**

| Role | Hostname | What it is |
|---|---|---|
| Shop | `wholesale.mirainikki.xyz` | Customer WooCommerce store |
| Dashboard | `sillage-wholesale.mirainikki.xyz` | Ops login (Sync, Orders, Settings) |

---

## Why it feels confusing

| You changed… | Still broken because… |
|---|---|
| `.env` only | Caddy still issues certs for the old names; WordPress still thinks it is the old shop |
| Caddy only | Plugin “Open dashboard” still reads `wp-config.php` |
| Settings → Shop URL | New syncs use it; existing product links in WordPress may still be the old host |

Do the list below **in order**. Skip none.

```
1. DNS               A records → this VPS
2. ~/sillage-wholesale/.env    SHOP_DOMAIN + DASH_DOMAIN + WP_BASE_URL
3. Caddy             TLS + which host goes to shop / dash
4. WordPress         siteurl + home  AND  wp-config.php SILLAGE_DASHBOARD_URL
5. Settings          Shop URL
6. Recreate          wholesale-core + wholesale-cron
```

If the plugin still opens the old dashboard, you skipped **4**.
If `https://sillage-wholesale.new` will not load, you skipped **1** or **3**.

---

## Step-by-step (on the live VPS `ovhe`)

SSH as `ubuntu`. Wholesale currently lives in the combined `~/sillage` compose until cut over
to `~/sillage-wholesale`.

### 1. DNS

Create **A** records for shop and dashboard → this VPS. There is no `images.*` record for
this shop.

### 2. Env

```bash
# edit these (no trailing slash)
SHOP_DOMAIN=wholesale.mirainikki.xyz
DASH_DOMAIN=sillage-wholesale.mirainikki.xyz
WP_BASE_URL=https://wholesale.mirainikki.xyz
```

Do **not** add `IMAGES_DOMAIN` or `LPS_MEDIA_BASE_URL` pointing at `images.prinscosmetic.eu`.
Do **not** change database passwords or `SILLAGE_SHARED_SECRET` here.

### 3. Caddy (`/etc/caddy/Caddyfile`)

Needs **two** site blocks (shop, dashboard). Shop block must include the AI-crawler 403 —
[`CRAWLER-SHIELD.md`](CRAWLER-SHIELD.md). Do **not** add an `images.*` site or `/lps-media`
proxy for this shop.

### 4. WordPress

Update `siteurl` / `home` and `SILLAGE_DASHBOARD_URL` in `wp-config.php` (see
`scripts/vps-bootstrap.sh`).

### 5. Settings → Shop URL

Save on the dashboard. Recreate `wholesale-core` + `wholesale-cron` so runtime URLs pick up.

---

## What not to do

- Do not mount `~/ecom_sites/data/media` into a wholesale nginx container.
- Do not invent `wholesale-media`.
- Do not rewrite wholesale product thumbs onto `https://images.prinscosmetic.eu`. Those JPEGs
  are Sillage’s (BTS has no vendor photos; some retail bottles are hosted there).
