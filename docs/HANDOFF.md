# HANDOFF — pick up after a month

Canonical resume doc for operators and agents. Read this first, then [`CONTEXT.md`](CONTEXT.md) for
schema facts and [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md) for UI controls.

---

## Memory — do not invent a different procedure

These are operator rules. If a later message seems to contradict them, **this section wins**.
Read this checklist and execute it in order. Do not skip an item because a later doc looks older.

1. **Docker Hub builds always happen on ovhe.** That box is already `docker login` as
   `unseencurtain`. Copy `sillage-core` (and `wordpress-image` only if you were asked to rebuild
   WordPress) to `~/sillage/`, then on **that VPS** run `~/sillage/scripts/build-push-images.sh`
   (or `docker build` + `docker push` there). Then point `SILLAGE_CORE_IMAGE` at the new tag and
   `docker compose --env-file .env --profile wholesale up -d`.
   - Do **not** install Docker in a cloud-agent pod.
   - Do **not** copy `~/.docker/config.json` off the VPS.
   - Do **not** build Hub images on a laptop or agent “because the VPS has only 4 GB”.
   - Do **not** skip the push because free RAM looks tight — that is how `2269d11`, `51ecd77`,
     and later tags were pushed from ovhe.
   - Do **not** rebuild `sillage-wordpress` from `wordpress:latest` unless an operator asked;
     a WP version bump on the live shop is a real risk. Core-only is the default.
2. **Wholesale is a second shop, not a suffix on retail.** Containers and folders are
   `wholesale-*` / `wp-wholesale` / `sitemaps-wholesale`. Never name them `wpf-*` (`WPF` is only
   the wholesale-perfumes **SKU prefix** in product code). `docker ps` must show two shops, not
   four containers that all look like “core”.
3. **Wholesale has its own MariaDB** (`wholesale-db`, datadir `~/ecom_sites/data/wholesale-db`,
   loopback `:3308`). Do **not** put `earth_wpf` / `sillage_wpf` on retail `ecom-db`. The shop
   must be movable to another VPS without dragging retail’s database.
4. **Valkey is the only shared process** while both shops sit on ovhe (retail db 0, wholesale
   prefix `wholesale:` / db 1). When wholesale moves, it takes its own Valkey. Do not share
   MariaDB “until then.”
5. **GitHub** is [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage). Cursor origin
   copies can have different SHAs; replay onto GitHub `main`, do not merge the remotes.

---

## Where things are

| Item | Location |
|---|---|
| **Live VPS** | SSH `ovhe` — `ubuntu@139.99.61.71`, hostname `ovh-experi`. App dir `~/sillage/`; data `~/ecom_sites/data/`. |
| **Unused VPS** | SSH `ovh` — `51.79.255.226`. Empty; do not deploy here unless deliberately repurposed. |
| **Public URLs** | Shop `https://prinscosmetic.eu` · Dashboard `https://sillage.prinscosmetic.eu` · Images `https://images.prinscosmetic.eu` · **Wholesale shop** `https://wholesale.mirainikki.xyz` · **Wholesale dashboard** `https://sillage-wholesale.mirainikki.xyz` |
| **Domain change** | [`DOMAIN-MIGRATION.md`](DOMAIN-MIGRATION.md) · trees: [`FOLDER-STRUCTURE.md`](FOLDER-STRUCTURE.md) |
| **Single env** | Laptop `production-environment/.env` → VPS `~/sillage/.env` (same shape; gitignored) |
| **Compose** | `production-environment/compose.yaml` only |
| **Hub images** | `unseencurtain/sillage-core:<tag>`, `unseencurtain/sillage-wordpress:<tag>` |
| **GitHub** | [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage) (`main`) — canonical public tree. Cursor cloud copies can have **parallel SHAs**; do not merge remotes. Replay with `production-environment/scripts/replay-to-github.sh`. [sillage-b2b](https://github.com/unseencurtain/sillage-b2b) is an archive pointer, not a second engine. |
| **Git (pricing lock fix)** | `8628eee` on `main` — dedicated `GET_LOCK` connection + Save-only-on-change. Redeploy if VPS image tag lags. |
| **Tag baseline** | `pre-scratch-20260808` — restore marker before catalogue wipe + B2B split ([`SCRATCH-RESET.md`](SCRATCH-RESET.md)) |
| **B2B (this VPS)** | [`WHOLESALE-SITE.md`](WHOLESALE-SITE.md) — second WP + `sillage_wpf`, compose profile `wholesale`. Old pointer: [unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b) |
| **Client how-to (humans)** | [`CLIENT-GUIDE.md`](CLIENT-GUIDE.md) — keep in sync with UI |
| **Operator UI guide** | [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md) |
| **Agent runbook** | [`AGENTS-RUNBOOK.md`](AGENTS-RUNBOOK.md) — sync, photos, orders, new VPS |
| **New VPS / photos** | [`VPS-MIGRATE.md`](VPS-MIGRATE.md) · [`specs/S3-images.md`](specs/S3-images.md) |
| **Missing photos by EAN** | [`EAN-IMAGE-SCRAPE.md`](EAN-IMAGE-SCRAPE.md) · VPS `~/sillage/ean-image-scrape/` |
| **BTS tracking** | [`BTS-ORDERS.md`](BTS-ORDERS.md) |
| **Health / recs** | [`RECOMMENDATIONS.md`](RECOMMENDATIONS.md) |
| **Deploy recipe** | [`VPS-DEPLOY.md`](VPS-DEPLOY.md) |
| **Crawler shield** | [`CRAWLER-SHIELD.md`](CRAWLER-SHIELD.md) — copy the Caddy `@heavybot` 403 onto every client VPS |
| **Google / sitemaps** | [`SEO.md`](SEO.md) — static XML, Caddy, not Minutes between syncs |

---

## Right now (2026-09-08) — wholesale is live on ovhe

Second WordPress on the **same** VPS as retail. Not a replacement of `prinscosmetic.eu`.
Implementation is this repo (`SILLAGE_PROFILE=wholesale`). Spec: [`WHOLESALE-SITE.md`](WHOLESALE-SITE.md).

| Item | Value |
|---|---|
| Shop | https://wholesale.mirainikki.xyz → Caddy → `127.0.0.1:106` (`wholesale-ecom`) |
| Dashboard | https://sillage-wholesale.mirainikki.xyz → `127.0.0.1:4001` (`wholesale-core`) |
| WP datadir | `~/ecom_sites/data/wp-wholesale` |
| MariaDB | **`wholesale-db`** datadir `~/ecom_sites/data/wholesale-db` port `3308` — not `ecom-db` |
| Woo / engine schemas | `earth_wpf` / `sillage_wpf` **on wholesale-db** |
| Containers | `wholesale-db`, `wholesale-ecom`, `wholesale-core`, `wholesale-cron` |
| Valkey | **shared** on ovhe: prefix `wholesale:`, database **1** (retail db 0). Own Valkey when the shop moves. |
| Vendor | wholesale-perfumes only (BeautyFort + BTS parked) |
| Plugin | `SILLAGE_CORE_URL=http://wholesale-core:4000` |
| Hub image | `unseencurtain/sillage-core:a5b94ee` — **built and pushed on ovhe** 2026-09-08. Dashboard Fetched is unique WPF SKUs (not store XML lines). Overview hide reasons are exclusive and add to Hidden. |
| WordPress | Retail already **7.1**. Wholesale was **7.0.2**; `wp-content` must be `www-data` (uid 33) or Updates fail (`wp-content/upgrade`). |

**Wholesale catalogue (2026-09-08):** 19,083 published = 6,151 visible in shop + 12,932 hidden (6,363 no/weak image + 6,569 out of stock with a photo). Woo `outofstock` term is 8,020 (overlaps no-image). Prices & stock Fetched is unique SKUs, not the ~140k store XML lines. Run #2 was backfilled to 19,083.

**Logins (gitignored).** Do not commit these. On ovhe `~/sillage/.env`:

| Surface | User | Env key |
|---|---|---|
| Both dashboards (`/login`) | `DASHBOARD_USER` (usually `admin`) | `DASHBOARD_PASSWORD` |
| Wholesale wp-admin | `admin` | `WHOLESALE_WP_ADMIN_PASS` (fallback `WPF_WP_ADMIN_PASS`) |
| Retail wp-admin | `sugar` | existing WP user; not in `.env` |

**Not done yet (next agent):**

1. Do **not** enable live vendor dispatch.

Rename + own MariaDB is **done** (2026-09-08): `docker ps` shows `wholesale-*` not `wpf-*`; `earth_wpf` / `sillage_wpf` live only on `wholesale-db`. Bring-up script (idempotent, skip if containers already healthy): `~/sillage/scripts/bootstrap-wholesale.sh`.
Leftover cutover script (already applied): `~/sillage/scripts/migrate-wholesale-own-db.sh`.

Retail shop rules below are unchanged.

---

## Right now (2026-09-03 evening) — start here

This is the live box `ovhe` (`ovh-experi`). Do not invent a second copy of the shop.

### What customers see

| Thing | State |
|---|---|
| Shop / dashboard / CDN | `prinscosmetic.eu` / `sillage.prinscosmetic.eu` / `images.prinscosmetic.eu` |
| Hide products without image | **On** |
| Orders | **Dry-run on**, auto-dispatch **off** |
| Fast sync | Every **30** minutes (Settings → Minutes between syncs) — **price and stock only** |
| Product photos | **Not** bulk-replaced. Catalogue still hides SKUs with no/weak Woo thumb |
| Google sitemap | **Live.** Caddy serves `~/ecom_sites/data/sitemaps/` (no PHP). Plugin **1.1.2** turns off WP core sitemaps and `noindex`s hidden product HTML |

### The “9,621 already have a file” line (easy to misread)

That number is **not** “9,621 good bottle photos ready to publish.” It means: for the Overview **in-stock + no/weak image** card, a *file or URL exists somewhere on disk*. Breakdown from the live lists (`~/photo-inventory/`):

| What | Count | Quality | On the shop? |
|---|---|---|---|
| **EAN scrape** (`~/sillage/ean-image-scrape/scraped/`) | **9,594** | Unreviewed Bing / Open Facts hits. **~1,943 files are under 8 KB** (icons / empty / generic likely). Applied once before and **reverted**. Treat as junk until inspected | **No** |
| **Brasty real shots** (not the grey camera graphic) | **~31** | Real product photos by EAN filename; camera placeholders skipped | **Yes — copied to CDN and rewritten 2026-09-03** (shop visible **26,005**, hidden-no-image **9,747**) |
| **Nothing anywhere** | **~153** | No CDN, override, scrape, or real Brasty file | Hidden |

**The directory that is allowed to serve shop photos** is `~/ecom_sites/data/media/` (`https://images.prinscosmetic.eu/<file>`). Shopify / BTS / ocean URLs in `image_overrides.json` are hotlinks; they do not need a file on disk.

Do **not** attach the 9,594 scrape files until a human has looked at them. Generic marks / logos / camera icons are not shop photos.

### SEO vs Docker Hub

Static sitemap **is already on the website** (Caddy + files on disk + nightly host cron `0 19 * * *` UTC → `write-sitemaps.py`).

Running Hub image is **`unseencurtain/sillage-core:<tag in ~/sillage/.env>`**.
Rebuild **on ovhe** with `~/sillage/scripts/build-push-images.sh` (or the copy under
`production-environment/scripts/`). That host is `docker login` as `unseencurtain`.
Do not build Hub images anywhere else.

Minutes between syncs does **not** rebuild the sitemap.

### Deleted on ovhe (do not restore)

- `~/ovhe-backup/` (Aug 23 zip)
- `~/sillage/backups/` (Aug 7 pre-scratch SQL)
- Unused Docker tags (`sillage-core` SHAs other than `a0f03e1`, leftover `cailiin/sillage-core`)
- Docker build cache, unused Zed (~430 MB)
- Agent `/tmp` dumps
- **`~/brasty/`** — 3.7 GB dump. Only ~31 EANs matched missing shop photos; those JPEGs now live in `~/ecom_sites/data/media/`. The rest did not match the hidden-no-image catalogue
- Duplicate zips: `sillage-photo-pack.zip`, `photo-inventory.zip`, `ean-image-scrape/scraped-ean-images.zip` (folders kept where needed)

### Keep (source of truth)

| Keep | Why |
|---|---|
| `~/sillage/` + `~/sillage/.env` | Running app |
| `~/ecom_sites/data/{wp,wp-db,media,sitemaps}` | Shop, DB, **CDN photos**, Google XML |
| `~/sillage/sillage-core/data/image_overrides.json` | EAN → URL |
| `~/sillage/ean-image-scrape/scraped/` | Unreviewed scrape (not shop) until inspected or deleted on purpose |
| `~/photo-inventory/` | Live CAN/CANNOT CSVs from 2026-09-03 |
| `~/caddy/Caddyfile` | Symlink to `/etc/caddy/Caddyfile` |

Rebuild lists: `bash ~/sillage/python-analysis/photo-pack/run_on_vps.sh`

---

## What changed (2026-08-31) — ClaudeBot melted the shop

`ecom` at 150%+ CPU was **not** leftover scrape. Anthropic **ClaudeBot**
(`216.73.217.16`, UA `ClaudeBot/1.0`) was walking every public `/product` and
`/?p=` page through Apache prefork. Caddy on the shop host now 403s that class
of crawler. Copy the same block onto every client VPS:
[`CRAWLER-SHIELD.md`](CRAWLER-SHIELD.md). Do not kill MariaDB to “fix CPU”.

---

## What changed (2026-08) — read before touching prices

### Architecture (unchanged on purpose)

- **Bun writes retail into WooCommerce** (`_price` / `_regular_price`). The plugin does **not**
  multiply at display time. Cost stays in `sil_offers`; customer pays WC; vendor dispatch uses cost.
- **No sale/RRP strike-through** — `pricing.ts` ignores vendor RRP; shop shows regular only.
- Dynamic “plugin ×N with no DB rewrite” was discussed and **not** built (WC sort/cart/feeds need
  stored `_price`). Still the rewrite-on-Save model.

### Bug that bit us

Multiplier Save updated `sil_settings` but the shop stayed on the old ×N because MariaDB
`GET_LOCK('sillage:sync')` is **connection-scoped**. Release on a different pool connection left
the lock held on an idle conn → every Save returned **queued** forever (`needs_price_write=1`,
no new `sil_sync_runs` row). Fix: hold lock on one dedicated connection for the whole run;
`destroy()` the conn if `RELEASE_LOCK` fails; Settings Save only kicks rewrites when values
**actually change** (whole-form POST was also queuing content rewrites). Commit **`8628eee`**.

### If shop prices ≠ Settings multiplier again

```bash
ssh ovhe
# lock stuck?
docker exec -e MYSQL_PWD="$(grep ^MYSQL_ROOT_PWD= ~/sillage/.env | cut -d= -f2-)" ecom-db \
  mariadb -uroot -N -e 'SELECT IS_USED_LOCK("sillage:sync");'
# if non-NULL and no sync running: restart to drop pool
cd ~/sillage && docker compose --env-file .env restart sillage-core sillage-cron
# then Save multiplier again, or:
docker exec sillage-core bun -e 'import { runSync } from "./src/sync/run.ts";
  console.log(await runSync({ mode:"fast", source:"cache", rewriteOnly:true }));'
```

Expect a new `sil_sync_runs` row `mode=fast` `source=cache` with `prices_updated≈53151`, then
`needs_price_write=0` and `_price ≈ vendor_price × multiplier` (FX/VAT/tiers apply when set).

---

## Live settings health (verified 2026-08-07)

Spot-checked on `ovhe` after the lock fix. Re-check with the SQL below if you change knobs.

| Area | Live state then | Verdict |
|---|---|---|
| **Price multiplier** | `1.5`; run **8** rewrite-only success; sample `_price` = cost×1.5; dirty=0; lock free | OK — Save → shop works |
| **Price tiers** | `[]` | OK — falls back to global multiplier |
| **Hide without image** | `1` | OK — rewrite path; ~14k hidden-no-image on last rewrite |
| **Stock threshold** | `0` global; vendor min stock NULL | OK |
| **Cart small-order fee** | `cart_min_enabled=0` (min 50 / fee 5 configured) | OK — bridge reads `sil_settings` (60s object-cache TTL). Enable in Settings to charge; does not block checkout |
| **Vendor MOQ** | BF/BTS `order_config` has **no** `min_order_value_eur`; WPF has 100 but parked | OK — no hard MOQ on retail lanes |
| **Orders dry-run / auto** | `orders_dry_run=1`, `orders_auto_dispatch=0` | OK — keep unless intentional live spend |
| **Order ceilings** | max/daily 10000 EUR; poll 15m; notify on | OK — rails only |
| **Schedule** | Sync page: **Rebuild catalogue** + **Update prices & stock**; Settings **Minutes between syncs** (check interval, not “minutes a day”). **Daily full catalogue rebuild** is first-class (live `full_sync_enabled=1`, hour 23, `Asia/Dhaka`). Per-vendor cadence is on **Vendors**. Rebuild queues when the schedule is on. BTS 25%/7-day unseen recovery is emergency only. | Update hidden while Sync enabled is on; no silent disk “cache” sync |
| **Live feed gate** | same minutes as schedule; **no daily download cap** | OK — do **not** start a live sync just to reprice (use Settings multiplier Save) |
| **Description / volume** | `none` / `ranges` | OK — Save of these kicks **full/cache** content rewrite (heavier) |
| **Shop / CDN URLs** | `wp_base_url` + `image_cdn_base_url` set | Shop URL hot-applies. **Image CDN does not rewrite existing product image URLs** — needs overrides + content rewrite |
| **Company billing** | BF + BTS profiles **empty** | Gap for **live** BeautyFort invoice address — fill before first live BF dispatch |
| **WPF** | `active=0`, excluded from `--vendor=all` | Parked — leave alone |
| **Sale prices in WP** | 0 rows with `_sale_price` | Expected |

```sql
-- quick parity check (replace 1.5 with current global_price_multiplier; ignores FX/VAT/tiers)
SELECT setting_value FROM sillage.sil_settings WHERE setting_key='global_price_multiplier';
SELECT IS_USED_LOCK('sillage:sync');
SELECT COUNT(*) dirty FROM sillage.sil_products WHERE needs_price_write=1;
SELECT id, mode, source, status, prices_updated, started_at
  FROM sillage.sil_sync_runs ORDER BY id DESC LIMIT 5;
```

---

## Product decisions (do not reverse casually)

- **Retail shop = BeautyFort + BTS only.** wholesale-perfumes (WPF/B2B) is parked — inactive,
  excluded from `--vendor=all`, no `/b2b-wholesale` on this WordPress install.
- **No LPS\*** as `product_cat` or visible product attributes. Internal `_sillage_vendor` postmeta
  only; storefront labels LPS01/LPS02 live in `sil_vendors.storefront_label`.
- **B2B is a separate project** — own compose / own repo when ready; not bolted onto this shop.
- **`orders_dry_run` stays `1`** unless you intentionally dispatch live vendor orders (no sandbox).
- **Images:** the only directory the shop CDN serves is `~/ecom_sites/data/media/`
  (`https://images.prinscosmetic.eu/<file>`). Git tracks `image_overrides.json` (EAN → URL),
  not JPEG bytes. The old `~/brasty/` dump was removed 2026-09-03 after copying the ~31
  missing-SKU hits into media. Remaining hidden-no-image SKUs are almost all the unreviewed
  EAN scrape (`~/sillage/ean-image-scrape/scraped/`) — **not** shop photos until inspected.
  Skip Brasty camera-placeholder MD5s in `brasty_placeholders.py`. After override edits:
  recreate `sillage-core` / `sillage-cron`, then
  `--mode=full --source=cache --rewrite-only`.
- **Theme target: Kadence.** Bridge must stay theme-agnostic; Blocksy-specific shims are legacy,
  not the long-term model. Lots of shop UI belongs in **sillage-bridge**, not the theme.

---

## Next work (priority)

1. **Photos still missing on the shop** — in-stock no/weak image ≈ **9,775**. Almost all
   “we have a file” rows are **unreviewed EAN scrape**, not proven product shots. Do not
   apply `scraped/` until inspected. ~153 have nothing. Details in **Right now** above.
   Google listing: [`SEO.md`](SEO.md). Hide-without-image and orders dry-run stay on.
2. **Polish retail UI for Kadence** — replace Blocksy-specific assumptions; guarded theme shims only.
3. **More shop UI through sillage-bridge** — filters, catalog helpers, cart/checkout polish.
4. **Fill company billing** before first live BeautyFort order.
5. **BTS tracking** — after deploy, poll `SIL-54253-BTS` so Cancelled leaves `submitted`
   ([`BTS-ORDERS.md`](BTS-ORDERS.md)).
6. **Optional later:** display-time multiplier (no 53k rewrite) — larger WC redesign; not started.
7. **Wholesale catalogue** — secrets + first sync on `wholesale.mirainikki.xyz` (sandbox dispatch
   stays locked). Old [sillage-b2b](https://github.com/unseencurtain/sillage-b2b) is not this shop.

Polish **this retail shop (BF+BTS) first.** Wholesale sync is a separate next step on the same VPS.

---

## Commands cheat sheet

### Deploy / update (from laptop)

```bash
# Hub images: ssh ovhe, copy sillage-core, run ~/sillage/scripts/build-push-images.sh --core-only
# (docker login as unseencurtain lives there — see Memory). Then:
./production-environment/scripts/deploy-vps.sh \
  --host ovhe \
  --shop prinscosmetic.eu \
  --dash sillage.prinscosmetic.eu \
  --images images.prinscosmetic.eu \
  --skip-build
```

Day-2 pull on VPS (retail + wholesale):

```bash
ssh ovhe 'cd ~/sillage && docker compose --env-file .env --profile wholesale pull && docker compose --env-file .env --profile wholesale up -d'
```

Full recipe: [`VPS-DEPLOY.md`](VPS-DEPLOY.md). Dashboard login file: `.deploy/vps-dashboard-ovhe.txt`.

### Sync (operator)

Dashboard **Sync**: **Rebuild catalogue** (full, first import) or **Update prices & stock** (fast).
Both respect **Minutes between syncs** cooldown. Overview’s button is Update prices & stock.
CLI offline: `cd production-environment/sillage-core && bun run sync -- --source=local --vendor=all`.

**Pricing Save:** Settings (global multiplier/tiers) or Vendors (per-vendor multiplier/FX/VAT/min
stock) → automatic **rewrite-only** price write from `sil_offers` (no live API). If a sync is
already running, a follow-up is queued — do not mash Run fast sync. Retail is stored in Woo
`_price` / `_regular_price` on purpose (cart/sort/filters); cost stays in offers. See
[`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md) “Why shop prices are stored”.

**Operator timezone:** Settings → `schedule_timezone` (IANA, default `UTC`). Full-sync hour is
local to that zone; Sync/Orders/Logs clocks follow it. MariaDB and vendor APIs stay UTC.
Changing TZ alone does not rewrite the catalogue.

### Secrets overlay (vendor API keys)

| Where | Path |
|---|---|
| VPS (retail) | `~/sillage/sillage-core/data/secrets.overlay.env` |
| VPS (wholesale) | `~/sillage/sillage-core/data/secrets.overlay.wholesale.env` |
| Laptop | `production-environment/sillage-core/data/secrets.overlay.env` (+ `.wpf.env` for wholesale) |
| Container | `/app/data/secrets.overlay.env` (`SILLAGE_SECRETS_FILE`) |

Set/clear via dashboard **Secrets** (overlay wins over compose `.env`). `touch` the file before
first `compose up` so Docker bind-mounts a file, not a directory.

### Migrate

```bash
# VPS
ssh ovhe 'docker exec sillage-core bun run migrate'

# Local dev
cd production-environment/sillage-core && bun run migrate
```

### Local dev stack

```bash
cd production-environment/sillage-core && bun install && bun run dev   # :4000
cd production-environment && docker compose --env-file .env up -d
```

See [`AGENTS.md`](../AGENTS.md) for hard rules (no PHP product writes, HPOS, dry-run safety).
