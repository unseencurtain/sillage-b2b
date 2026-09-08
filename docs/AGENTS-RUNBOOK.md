# Agent runbook — whole retail project

Read this when you pick up the repo cold (new agent, new VPS, or a long gap). Then open
only the one deep doc you need. Do not wander the tree.

| If you need | Read |
|---|---|
| **Client / human how-to** | [`CLIENT-GUIDE.md`](CLIENT-GUIDE.md) — update with UI/shopper changes |
| Resume / live host / current health | [`HANDOFF.md`](HANDOFF.md) |
| **Wholesale shop** (`wholesale.mirainikki.xyz`) | [`WHOLESALE-SITE.md`](WHOLESALE-SITE.md) |
| Schema, containers, what PHP may write | [`CONTEXT.md`](CONTEXT.md) |
| Dashboard knobs (engineers) | [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md) |
| Fresh VPS from zero | [`VPS-DEPLOY.md`](VPS-DEPLOY.md) |
| **AI crawler / ecom 150% CPU** | [`CRAWLER-SHIELD.md`](CRAWLER-SHIELD.md) — Caddy `@heavybot` 403, copy onto every client VPS |
| **Google / sitemaps / SEO** | [`SEO.md`](SEO.md) — Bun writes static sitemaps; Caddy serves them; PHP does not |
| Move shop + photos to a **new** VPS | [`VPS-MIGRATE.md`](VPS-MIGRATE.md) |
| Change shop / dash / image hosts | [`DOMAIN-MIGRATION.md`](DOMAIN-MIGRATION.md) |
| What lives where (repo + VPS) | [`FOLDER-STRUCTURE.md`](FOLDER-STRUCTURE.md) |
| Photos, Brasty, overrides | [`specs/S3-images.md`](specs/S3-images.md) |
| Missing photos by **EAN** | [`EAN-IMAGE-SCRAPE.md`](EAN-IMAGE-SCRAPE.md) |
| Photo pack (zip + one-shot download server) | [`../production-environment/python-analysis/photo-pack/README.md`](../production-environment/python-analysis/photo-pack/README.md) |
| BTS v2.1 orders + tracking | [`BTS-ORDERS.md`](BTS-ORDERS.md) |
| Hard rules (no PHP product SQL, dry-run) | [`../AGENTS.md`](../AGENTS.md) |

GitHub: [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage) (`main`).
Live SSH: `ovhe` (`ubuntu@139.99.61.71`). App `~/sillage/`, data `~/ecom_sites/data/`.

**Hub images:** build and push **on ovhe** (`docker login` as `unseencurtain` lives there).
Copy `sillage-core` to `~/sillage/sillage-core` (do not overwrite `data/` or `logs/`), then
`~/sillage/scripts/build-push-images.sh --core-only`. Do not install Docker in an agent VM
and do not copy Hub credentials off the VPS. Canonical wording: [`HANDOFF.md`](HANDOFF.md)
Memory.

---

## What this system is

BeautyFort + BTS catalogues → WooCommerce shop `https://prinscosmetic.eu`,
ops dashboard `https://sillage.prinscosmetic.eu`, image CDN `https://images.prinscosmetic.eu`.

Bun (`sillage-core`) writes products into MariaDB. The WordPress plugin is a thin bridge
(REST, cart rules, tracking notes). **PHP must not grow product-write paths.**

wholesale-perfumes is the **wholesale** shop only (`wholesale.mirainikki.xyz`). On retail it stays
parked. Ocean = `oceanfragrances.csv` images only.
Brasty = optional Playwright tool in git (`tools/images/brasty/`). The VPS dump
`~/brasty/` was deleted 2026-09-03; needed hits live in `~/ecom_sites/data/media/`.
Not a vendor.

---

## Do not reverse these

- Hide-without-image stays **on**. Do not unhide the shop because one SKU lacks a photo.
- Orders stay **dry-run** (`orders_dry_run=1`) and **manual dispatch** unless someone is
  intentionally spending money. Neither vendor has a sandbox.
- BTS incremental stays at whatever **Minutes between syncs** is on the dashboard
  (`fast_sync_minutes`). Daily full catalogue rebuild stays on (hour 23, `Asia/Dhaka`).
  The 25%/7-day BTS stale recovery is emergency only.
- Never commit `.env`, `secrets.overlay.env`, `*.pem`, WordPress/MariaDB datadirs, or the
  Brasty JPEG dump.

---

## Git vs what lives only on the VPS

| In git | Not in git (restore separately) |
|---|---|
| App, plugin, compose, docs | `~/sillage/.env`, `secrets.overlay.env` |
| `sillage-core/data/image_overrides.json` (~11k EAN → URL) | `~/ecom_sites/data/media/` (CDN JPEGs) |
| `found-images-manifest.json` (CDN filenames) | Unreviewed scrape `~/sillage/ean-image-scrape/scraped/` (not shop until inspected) |
| Matcher + `restore_found_images.py` | MariaDB (`earth` + `sillage`) |

Shopify / BTS / oceanfragrances URLs in the override map are **hotlinks**. Only
`images.prinscosmetic.eu/<file>` bytes must sit in `ecom_sites/data/media/`.

---

## Day-2 loop (catalogue)

1. Dashboard **Sync** → **Update prices & stock** (fast, live) or wait for the 30-min cron.
2. **Rebuild catalogue** for new SKUs / taxonomy (or let the nightly full run).
3. After changing `image_overrides.json`: copy onto the VPS bind-mount, **recreate**
   `sillage-core` and `sillage-cron` (in-process cache), then

   ```bash
   docker exec sillage-core bun run sync -- --mode=full --source=cache --rewrite-only
   ```

   Fast rewrite-only only selects `needs_price_write` and will skip image-only dirty rows.

4. Deploy a code change: build `unseencurtain/sillage-core:<git-sha>` from `sillage-core/`
   (exclude `node_modules`, `web/dist`, `.env`, logs), set `SILLAGE_CORE_IMAGE` in
   `~/sillage/.env`, `docker compose up -d sillage-core sillage-cron`. Recipe:
   [`VPS-DEPLOY.md`](VPS-DEPLOY.md).

---

## Photos (EAN match)

Matcher: `production-environment/python-analysis/beautyfort-enriched/fill_missing_shop_images.py`.

Priority: existing overrides → Brasty EAN file (skip camera placeholders) → ocean CSV →
Shopify CSV. Multi-EAN: try every barcode; Woo still gets one thumbnail.

Brasty camera graphic (grey camera + “BRASTY”) is **not** a product photo. MD5s in
`brasty_placeholders.py`. Example of a purged URL: `8809598454323.jpg`.

Victoria’s Secret EAN `0197575132998` (`BF-F558351` / `BTS-419906`) still needs a **manual**
photo. ~12k leftover SKUs have EANs that are simply not in the 36k Brasty dump.

Restore onto a new VPS: [`VPS-MIGRATE.md`](VPS-MIGRATE.md).

---

## Orders

Cron ticks always run ingest + dispatch + **tracking poll**, even when catalogue sync skips.

BTS: `getOrder` for status, `getTrackings` for carrier codes. `order_not_found` on
`getTrackings` means **no tracking yet**, not a missing order. Cancelled must move the
Sillage row out of `submitted` — see [`BTS-ORDERS.md`](BTS-ORDERS.md).

BeautyFort test refs that the vendor no longer has are parked `needs_attention` (permanent
“no OrderReference”). That is expected for old sandbox-ish numbers.

---

## Quick health (on `ovhe`)

```bash
ssh ovhe
grep ^SILLAGE_CORE_IMAGE= ~/sillage/.env
cd ~/sillage && docker compose --env-file .env ps
# settings + last runs + open vendor orders
docker exec -e MYSQL_PWD="$(grep ^MYSQL_ROOT_PWD= ~/sillage/.env | cut -d= -f2-)" ecom-db \
  mariadb -uroot -e '
    SELECT setting_key, setting_value FROM sillage.sil_settings
     WHERE setting_key IN ("hide_products_without_image","full_sync_enabled","orders_dry_run","sync_enabled");
    SELECT id, mode, source, status, started_at FROM sillage.sil_sync_runs ORDER BY id DESC LIMIT 5;
    SELECT id, status, dry_run, our_reference, vendor_order_number, last_error
      FROM sillage.sil_vendor_orders;
  '
curl -sI https://prinscosmetic.eu/ | head -5
curl -sI https://sillage.prinscosmetic.eu/login | head -5
curl -sI https://images.prinscosmetic.eu/0000030160668.jpg | head -5
```

Shop writes on the Sync table should read `New n · Updated n · Prices n`, not `+ ~ $`.

---

## Recommendations (do not do unless asked)

1. Fill Settings **company billing** before the first live BeautyFort dispatch.
2. Treat overlapping live-gate skips (`bts live fetch blocked: only 0 min…`) as a skip, not
   a red `sil_sync_runs` error.
3. Index extra EANs is now in `loadOfferImageIndex` — run a **full** rewrite-only if you
   want the handful of BF←BTS extra-EAN fills written to Woo.
4. 71 published products may still lack `product_brand` term links (fast sync never writes
   brands). A full content rewrite of those SKUs attaches them.
5. Hunt real photos for leftover no-image SKUs. Do not turn hide-without-image off.
   Do not dump the unreviewed EAN scrape onto the shop.
