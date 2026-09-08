# Operator dashboard — BeautyFort + BTS

**Clients / humans:** use [`CLIENT-GUIDE.md`](CLIENT-GUIDE.md) (how to use the shop and dashboard).
This file is the **engineering** map of every control (API routes, setting keys). When you rename
a button or change shopper behaviour, update **both** this file and `CLIENT-GUIDE.md`.

Live UI: `https://sillage.prinscosmetic.eu` (VPS `ovhe`). This retail shop syncs **BeautyFort**
and **BTS** only. wholesale-perfumes is parked here and sold on
[`wholesale.mirainikki.xyz`](WHOLESALE-SITE.md) (`SILLAGE_PROFILE=wholesale`, dashboard
`https://sillage-wholesale.mirainikki.xyz`).

Source of truth for ops knobs: `sillage.sil_settings` / `sillage.sil_vendors`, edited through this
dashboard (or SQL). Auth is HTTP session cookies against `DASHBOARD_USER` / `DASHBOARD_PASSWORD`
(env, not `sil_settings`).

**Code map**

| Layer | Path |
|---|---|
| Pages | `production-environment/sillage-core/web/src/pages/*` |
| Nav | `web/src/components/Layout.tsx` |
| Client API | `web/src/lib/api.ts` |
| Server routes | `src/server/routes/api.ts` |
| Settings load | `src/db/settings.ts` → `loadSettings()` / `loadVendors()` |
| Secrets overlay | `src/config/secrets.ts` → `loadSecretsOverlay()` / `setSecret` / `clearSecret` |
| Scheduler | `src/sync/schedule.ts` + container `crontab` (`*/5`) |
| Orders | `src/orders/{dispatch,rails,tracking,ingest,addresses}.ts` |
| Shop cart fee / MOQ | `sillage-bridge` → `class-sillage-cart-fee.php` |

---

## Money safety (read first)

| Fact | Detail |
|---|---|
| **`orders_dry_run` does not drive the Dry-run / Live buttons** | Dashboard `POST /api/orders/:id/dispatch` always sets `dryRun: !live` and `force: true`. The setting only affects **auto-dispatch** and CLI defaults. Turning dry-run **off** + auto-dispatch **on** spends money without a click. |
| Fail-closed defaults | Seed: `orders_dry_run=1`, `orders_auto_dispatch=0`. Keep them that way unless you intend live spend. |
| No sandbox | BeautyFort and BTS have no vendor sandbox. Live dispatch spends real money. |

```
WC order → HMAC webhook → ingest splits sil_vendor_orders (status=received)
        → cron tick:
             auto_dispatch OFF → promote to approved (rails permitting); wait for human
             auto_dispatch ON  → dispatchVendorOrder(force) with orders_dry_run
        → dashboard:
             Approve = force rails check only
             Dry-run / Live = force + explicit dryRun flag (ignores orders_dry_run)
```

---

## Navigation

| Nav label | Route | Page |
|---|---|---|
| Overview | `/` | Health snapshot + **Run sync now** |
| Sync | `/sync` | **Run sync now** + manual runs + BF/BTS live gates |
| Products | `/products` | Catalogue search; Shop dropdown can pin **Keep hidden** |
| Vendors | `/vendors` | BeautyFort + BTS editors; WPF parked notice |
| Orders | `/orders` | Per-vendor order dispatch |
| Secrets | `/secrets` | Vendor API credentials (set / clear; never echoed) |
| Settings | `/settings` | Schedule, pricing, cart fee, order rails, billing |
| Logs | `/logs` | Event log |
| Sign out | — | `POST /api/auth/logout` |
| (unlisted) Login | `/login` | Cookie session |

---

## Login

| Control | API | Effect |
|---|---|---|
| User / Password / Sign in | `POST /api/auth/login` | Cookie session; creds from env |
| Session check | `GET /api/auth/me` | Guards authenticated routes |

---

## Overview

Polls `GET /api/overview` every 15s.

| UI | Meaning |
|---|---|
| **Update prices & stock** | Same as Sync: one-off fast live sync. Shows **Scheduled (Nm)** and is disabled while Sync enabled is on |
| Visible in shop | WP publish ∩ not `exclude-from-catalog`. Smaller than Published when hide-without-image / OOS |
| Published in WP | Includes catalog-hidden products |
| Sillage products | `COUNT(sil_products)` |
| Sync on/off · orders dry-run/LIVE | Snapshot of rails (edit on Settings) |
| Catalogue visibility stats | Exclusive hide reasons that **add** to Hidden: no/weak image, out of stock (has image), operator pin. Out of stock card is the Woo `outofstock` term (can include no-image SKUs). Visible + Hidden = Published |
| Last sync | Latest `sil_sync_runs` (+ link to Sync). Fetched is WPF SKUs on wholesale, not BF/BTS |
| Vendor orders by status | Counts only |
| Syncs · last 7 days | Activity chart |

Catalogue sync only — never places vendor orders. Order spend still requires Orders → Live.

---

## Why shop prices are stored (not display-only)

WooCommerce cart, sorting, filters, and HPOS need `_regular_price` / `_price` on the product.
Sync **writes** retail = `f(cost, fx, vat, tiers, multiplier)` into those metas. Wholesale **cost**
stays in `sil_offers` (and vendor meta). Changing a multiplier does nothing until a **price rewrite**
runs — Save on Settings/Vendors starts that automatically (rewrite-only from DB offers; no live
vendor download). Fully dynamic display-only pricing would be a larger redesign; storing retail is
intentional.

---

## Sync / Runs

Operator model (two actions only):

1. **Rebuild catalogue** — empty shop / full structure (`mode:full`, live). Creates products, taxonomy, vanish, park WPF.
2. **Update prices & stock** — ongoing (`mode:fast`, live). Touches changed offers only.

| Control | API | Effect |
|---|---|---|
| **Update prices & stock** | `POST /api/sync/run` `{mode:"fast", source:"live"}` (API fills this storefront’s vendors: BF+BTS or `wholesale-perfumes`) | One-off only when **Sync enabled is off**. Disabled while a run is active, the schedule is on, or a vendor is inside its call interval |
| **Rebuild catalogue** | same, `mode:"full"` | Empty shop / sync off → runs now. With Sync enabled and a catalogue already imported → **queues** for the next scheduled call |
| **Stop** | `POST /api/sync/stop` | Only while a run is active; sets `sync_enabled=0`. A later Update does **not** turn the schedule back on |
| Call-interval status | `GET /api/sync/live-status` | Per-vendor `retryInMinutes`. Daily remaining is unused (always `null`) |
| Runs table | `GET /api/sync/runs` | History; Fetched is `BF n · BTS m` on retail (Δ = BTS changes API) or `WPF n` catalogue SKUs on wholesale. **Shop writes** is `New n · Updated n · Prices n`. Wholesale hourly store XML lines are collapsed per product id and only matched SKUs count as Fetched |

**Call interval:** Settings **Minutes between syncs** writes both `live_feed_min_minutes` and
`fast_sync_minutes`. Retail: BeautyFort and BTS are gated independently. Wholesale: the hourly
store XML has its own gate. There is **no daily download cap**. If the gate blocks, the API
returns `started:false` / `cooldown:true` — it does **not** silently reuse a stale on-disk feed.

**“Cache” is not an operator mode.** Disk feed files are internal. Pricing Save still uses
invisible `rewriteOnly` + `source=cache` from `sil_offers` (no vendor API; ignores the interval).

**Schedule:** cron every 5 minutes; when Sync enabled is on, a due tick runs fast price/stock
(or a queued rebuild). **Daily full catalogue rebuild** is a first-class Settings control (keep
on for this shop). Incremental checks still run at **Minutes between syncs**. BTS 25%/7-day stale recovery stays
emergency-only. Order housekeeping runs every tick.

`--vendor=all` never includes parked slugs for this profile (WPF on retail, BF/BTS on wholesale).

---

## Products

| Control | API | Effect |
|---|---|---|
| Search box | `GET /api/products?q=&page=` | Filters SKU / name / EAN |
| Photo | same (`photo_url`) | Opens the displayed shop image in a new tab |
| Shop dropdown | `PUT /api/products/:id/visibility` `{ hidden }` | `hidden: true` sets `sil_products.operator_hidden=1`, hides in Woo immediately, marks `needs_price_write`, kicks a fast rewrite. `hidden: false` clears the pin; rewrite applies image/stock rules again |
| Pagination | same | 50 per page |

Retail price still changes only via Settings/Vendors. Do not delete the WooCommerce post — the next full write recreates it.

**Shop badges:** `Visible` / `Hidden · no image` / `Hidden · stock` / `Hidden · pinned`. Stock of `1` does **not** mean the listing is on the storefront. Hide-without-image (default on) excludes products whose **displayed Woo thumb** is still empty, a placeholder (`no_image`, Woo placeholder), or a weak BeautyFort `/pic/` thumb. The writer ORs image hide, stock hide, and `operator_hidden` onto `exclude-from-catalog` + `exclude-from-search`. Products stay in WooCommerce (and on this table) with their WP id.

**Image resolve order** (same as sync): curated `data/image_overrides.json` → another vendor’s usable photo for the same EAN → else no image. Cross-vendor fill never uses `/pic/` thumbs or `no_image.webp` as donors. Example: Victoria’s Secret Temptation Body Lotion (EAN `0197575132998`) can show stock 1 / WP 70276 and still be **Hidden · no image** because BeautyFort’s `/pic/` URL and BTS’s `no_image.webp` are both unusable.

To show that SKU on the shop: add a real photo in `image_overrides.json` for the EAN and run a rewrite, or turn **Hide products without image** off (shop-wide — weak thumbs would appear). Do not treat it as a stock bug.

---

## Orders

Rows are **per-vendor** (`sil_vendor_orders`), not WooCommerce orders. Refresh every 10s.

| UI label | API | Effect |
|---|---|---|
| Select row `#id` | `GET /api/orders/:id` | Detail pane |
| Approve | `POST .../approve` | Coverage + ceiling rails; `received`→`approved` (force) |
| Dry-run | `POST .../dispatch` `{live:false}` | Full path **without** spending money |
| Live (+ confirm) | `{live:true}` | **Spends real money.** Confirm required |
| Open in WooCommerce | link | HPOS edit URL |
| Tracking stage chips | `POST .../status` | Manual stage. After live submit, 409 until `confirm:true` |
| Save delivery | `PUT .../address` `{delivery}` | Vendor ship-to; WC unchanged |
| Reset from WooCommerce | `{resetDeliveryFromWoo:true}` | Re-reads HPOS address |
| Save billing | `{billing}` | Invoice address for BeautyFort |
| Use saved company billing | `{useCompanyBilling:true}` | Fills from Settings BF/BTS profiles |
| Tracking / Event log | detail payload | Read-only |

**Editable window:** `received` \| `approved` \| `needs_attention` \| `submitted` (submitted only if
still dry-run). Live submitted addresses are locked.

**Auto path:** every cron tick, if `orders_auto_dispatch=1`, due rows dispatch using
**`orders_dry_run`**. If auto is off, tick still promotes `received`→`approved` when rails allow.

---

## Vendors (BeautyFort + BTS)

Editable cards for `beautyfort` and `bts` only. Save → `PUT /api/vendors/:slug`. Changing
**price multiplier, FX, VAT, or min visible stock** marks all products dirty and kicks the same
**rewrite-only** price recalc as Settings (active retail catalogue; no live vendor API). Toast:
“Recalculating prices…” or “Sync already running — …will apply when it finishes”. Confirmation
required when changing **Active** or **Serviceable countries**.

| UI label | Storage | Effect |
|---|---|---|
| Storefront label | `storefront_label` | Customer-facing lane (e.g. LPS01 / LPS02) |
| Price multiplier | `price_multiplier` (null = empty) | Per-vendor override **disables** global price tiers for that vendor. **Save → price rewrite** |
| Min visible stock | `min_visible_stock` | Stock ≤ threshold → hidden + outofstock. **Save → price rewrite** |
| FX rate | `fx_rate` | Cost = vendor × FX × (1+VAT). **Save → price rewrite** |
| VAT rate (fraction) | `vat_rate` | Use `0.21` for 21%. **Save → price rewrite** |
| Min order value (EUR) | `order_config.min_order_value_eur` | Bridge hard-blocks checkout under MOQ |
| Serviceable countries | `serviceable_countries` JSON | ISO list; blocks approve/dispatch outside list |
| Active | `active` | Inactive = skipped by sync / cannot dispatch |

Not editable here: `slug`, `sku_prefix`, `currency`. API credentials → **Secrets**.

### How often each vendor updates

The **Minutes between syncs** field stays on Settings (one number; BeautyFort and BTS cool down independently). It is a **check interval** — the value you type (30, 40, …), not a hardcoded 30 and not “30 minutes a day”.

| Vendor | Prices and stock on the shop | Full catalogue rebuild |
|---|---|---|
| BeautyFort | Every check at that interval. They have no change-only feed, so each call re-downloads the ~9k stock file | Settings → Daily full catalogue rebuild (routine). Manual: Sync → Rebuild catalogue |
| BTS | **About once a day.** We still check on that interval; BTS only publishes a daily change batch, so most checks are empty until that batch appears | Same daily rebuild (creates WP categories for referenced BTS nodes). Emergency: auto-recovery if >25% of BTS offers unseen for 7 days — not the normal path |

The 48-hour lookback on BTS change checks is an implementation detail (so yesterday’s batch is not missed). It is **not** “BTS updates every 48 hours”. Last live fetch is shown on the card. Do **not** put a daily download cap on Vendors (retired).

### Parked: wholesale-perfumes (retail dashboard)

Shown as a **read-only** dashed card: lives on the wholesale shop, not this retail one. No
Active toggle, no Save. Sync forces `active=0` every run. Do not activate on retail.

On the **wholesale** dashboard the inverse is true: BeautyFort + BTS are parked; WPF is the only
editable vendor; Orders Live is hidden (sandbox lock).

---

## Secrets

Vendor API credentials for BeautyFort + BTS. Stored in a **gitignored overlay file** bind-mounted
into `sillage-core` / `sillage-cron` (not `sil_settings` — secrets must not land in MariaDB).

| Path | Role |
|---|---|
| Host | `~/sillage/sillage-core/data/secrets.overlay.env` (VPS) or `production-environment/sillage-core/data/secrets.overlay.env` |
| Container | `/app/data/secrets.overlay.env` (`SILLAGE_SECRETS_FILE`) |
| Compose `.env` | Still injects base `BEAUTYFORT_*` / `BTS_*` at container start; **overlay wins** when set |

| Control | API | Effect |
|---|---|---|
| Status rows (masked `••••••••` / empty) | `GET /api/secrets` | Which keys are set + source (`overlay` \| `env` \| `unset`). **Never returns values.** |
| Set | `PUT /api/secrets` `{key,value}` | Writes overlay, updates `process.env` + in-memory `env` immediately |
| Clear | `DELETE /api/secrets/:key` | Removes from overlay + runtime |

Allow-listed keys only: `BEAUTYFORT_USER`, `BEAUTYFORT_SECRET`, `BTS_JWT_TOKEN`.

**Hot-reload:** no container recreate needed for BF/BTS credentials. Overlay is applied on API
boot and again at the start of every `runSync` (so cron picks up dashboard changes). Touch an
empty overlay file before first `compose up` so Docker mounts a file, not a directory.

---

## Settings

Save → `PUT /api/settings` (allow-listed keys only). The dashboard posts the **whole form**; the API
**persists and kicks rewrites only for keys whose value actually changed** (avoids spurious
full/cache jobs). Unchanged cart/schedule/order fields are no-ops on that Save.

Price/visibility keys (`global_price_multiplier`, `price_tiers`, `global_stock_threshold`,
`hide_products_without_image`) mark products dirty and start a **rewrite-only** sync from
`sil_offers` (no live download). UI toasts **Recalculating prices…** and polls Sync until done.
If a sync is already running, Save **queues** a follow-up (`pending_price_rewrite`) — toast
explains the wait; no need to mash Run fast sync. `description_mode` / `volume_filter_mode` mark
products dirty and start a **full/cache** sync (same queue behaviour).

**Other sections do not rewrite the catalogue:** cart fee, schedule, order rails, company billing,
shop URLs — they save into `sil_settings` (or billing JSON) and take effect on the next read
(cart fee: bridge, ~60s object-cache TTL; schedule: next cron tick; URLs: hot-applied in Bun).

UI sections (each control has one-line help): **Shop URLs** → **Pricing & catalogue** → **Cart
minimum** → **Schedule** → **Order safety** → **Advanced** (volume/description, company billing).

If prices stay stale after a multiplier Save: check `IS_USED_LOCK('sillage:sync')` and
[`HANDOFF.md`](HANDOFF.md) “If shop prices ≠ Settings multiplier”. Do not start a live vendor
sync just to reprice — Save already queues a rewrite-only run.

### Shop URLs (post-login)

| UI label | Key | Effect |
|---|---|---|
| Shop URL | `wp_base_url` | Public WooCommerce origin. Env `WP_BASE_URL` is bootstrap; Settings overrides runtime (admin links, tracking push). In-Docker finalize still uses `WORDPRESS_INTERNAL_URL` (`http://ecom`) |
| Image CDN base URL | `image_cdn_base_url` | Documented public image origin; hot-applied into Bun runtime env. Does **not** rewrite existing product image URLs by itself (overrides + rewrite still required) |

### Schedule & sync source

| UI label | Key | Effect |
|---|---|---|
| Sync enabled | `sync_enabled` | On → schedule owns price/stock. Stop turns it off. Manual Update does not turn it back on |
| Operator timezone | `schedule_timezone` | IANA zone for dashboard clocks + optional nightly hour. MariaDB stays UTC |
| Minutes between syncs | `live_feed_min_minutes` **and** `fast_sync_minutes` | One field; Save keeps both equal. Incremental check interval |
| Daily full catalogue rebuild | `full_sync_enabled` | Routine once-per-day full import (new products + WP categories). Keep on. Incremental 30-min checks still run |
| Daily rebuild hour | `full_sync_hour` | **0–23 only** in `schedule_timezone` (not the minutes interval). One attempt after this hour |
| Sync source | `sync_source` | Hidden from main UI; keep `live` in production (`local` = fixtures) |

### Pricing & catalogue visibility

| UI label | Key | Effect |
|---|---|---|
| Price multiplier | `global_price_multiplier` | Fallback when no tier matches / tiers empty / no vendor override |
| Price tiers (section) | `price_tiers` JSON | Cost bands; last row unbounded (`maxCost: null`) |
| Stock threshold | `global_stock_threshold` | Global floor when vendor min stock is null |
| Hide products without image | `hide_products_without_image` | Default on. After image resolve (override → other vendor EAN → else none), if the URL is still empty / placeholder / BTS `no_image` / BeautyFort `/pic/` thumb, the product gets `exclude-from-catalog` + `exclude-from-search` (OR’d with the stock-threshold hide). Product remains in WP and on the Products table. Save marks dirty and starts a rewrite-only sync. Products → Shop column shows **Hidden · no image** when this rule is why the listing is missing from the store |
| Volume filter | `volume_filter_mode` | Advanced: `ranges` \| `exact` \| `off` |
| Description mode | `description_mode` | Advanced: `none` = title in `<p>`; `template` = brand/type/size blurb |

### Cart minimum (storefront fee)

Read by PHP bridge from `sil_settings` (fail-open). Independent of per-vendor MOQ.

| UI label | Key | Effect |
|---|---|---|
| Small-order fee | `cart_min_enabled` | Off by default |
| Cart minimum (EUR) | `cart_min_subtotal_eur` | Global subtotal floor for the fee |
| Small-order fee (EUR) | `cart_min_fee_eur` | Charged once when under floor |
| Small-order fee label | `cart_min_fee_label` | Line item label |
| Small-order fee message | `cart_min_message` | Must include `{remaining}` |

### Orders rails

| UI label | Key | Effect |
|---|---|---|
| Orders dry-run | `orders_dry_run` | Auto-dispatch + CLI default — **not** the dashboard Dry-run/Live buttons |
| Auto-dispatch | `orders_auto_dispatch` | Off = human Approve/Dry-run/Live; on = cron submits (respecting dry-run) |
| Max order value EUR | `orders_max_value_eur` | Blocks approve/dispatch over ceiling |
| Daily spend cap EUR | `orders_daily_cap_eur` | Rolling 24h live spend |
| Tracking poll minutes | `orders_poll_minutes` | How often live vendor orders are polled (min 5) |
| Notify customer on tracking | `orders_notify_customer` | Email flag into bridge REST |

### Company billing profiles

| UI | Key | Used by |
|---|---|---|
| BeautyFort form | `company_billing_beautyfort` | BeautyFort InvoiceAddress |
| BTS form | `company_billing_bts` | Ops / dry-run payload (BTS invoice is portal-side) |

---

## Logs

| Control | API | Effect |
|---|---|---|
| Level filter | `GET /api/logs?level=&page=` | Filters `sil_events.level` |
| Table | same | When / level / scope / message |

---

## Not on the Settings UI (by design)

| Key / control | Status |
|---|---|
| `max_rrp_ratio` | **Unused** in pricing (`void` in `computePricing`). Not shown. |
| WPF store-feed caps / live-status card | Parked with B2B — not on Sync or Settings |
| `dedupe_by_ean`, `primary_offer_strategy`, `write_batch_size`, `max_statement_bytes` | Used in code; change via SQL if needed |
| Legacy `beautyfort_live_max_per_day` / `bts_live_max_per_day` | Fallback if vendor row caps null (prefer `sil_vendors.live_max_per_day`) |

---

## Env-only knobs (not on dashboard)

| Env | Role |
|---|---|
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` / `SESSION_SECRET` | Dashboard auth |
| `SILLAGE_SHARED_SECRET` | HMAC between Bun ↔ bridge |
| `BEAUTYFORT_*` / `BTS_*` | Vendor API credentials — also editable via **Secrets** overlay |
| `WHOLESALE_PERFUMES_*` | Retail: unused while WPF parked. Wholesale dashboard Secrets: required |
| `WP_BASE_URL` | Bootstrap shop URL; Settings `wp_base_url` overrides at runtime |
| `WORDPRESS_INTERNAL_URL` | In-Docker WordPress (`http://ecom`) for finalize — not public |
| `LPS_MEDIA_BASE_URL` / `PUBLIC_URL_BASE` / `IMAGE_HOST_BASE_URL` | Image tooling bootstrap; Settings Image CDN can document/override |
| `DB_*` / `SILLAGE_DB_*` / `REDIS_URL` | Infrastructure |
| `FIXTURES_DIR` | Local/fixture sync root |
| `BEAUTYFORT_TEST_MODE` | BeautyFort SOAP test flag |
| `SILLAGE_SECRETS_FILE` | Host path to secrets overlay (compose bind-mount) |

Internal runtime keys (not operator UI): `sync_abort`, `last_live_fetch_*`, `live_fetch_count_*_*`.

---

## Quick operator recipes

1. **Demo sync to a client** — Secrets → confirm BF/BTS show set → Sync → **Run sync now** → watch **Syncing…** + runs table + success toast. Catalogue only; orders stay dry-run.
2. **Set vendor API keys** — Secrets empty-state prompts on first login → paste → Set (hot-reload).
3. **Pause catalogue sync** — Settings → Sync enabled off, or Sync → **Stop sync** (only while a run is active).
4. **Resume** — Sync enabled on, or press Run sync now / fast/full (re-enables).
5. **Change retail markup** — Settings tiers/multiplier and/or Vendors multiplier → wait for auto rewrite toast, or Sync → fast.
6. **Safe order test** — keep dry-run on; Orders → Dry-run; inspect payload/events. Orders page shows a big warning if Settings dry-run is OFF.
7. **First live order** — prefer auto **off**, then Live with confirm on one row. Never flip dry-run off while auto-dispatch is on unless you mean it.
8. **Shop / CDN hosts** — Settings → Shop URL / Image CDN (env is bootstrap). Regenerating product image URLs still needs `image_overrides.json` + rewrite sync.
9. **Fresh compose** — `cp .env.example .env`, `touch sillage-core/data/secrets.overlay.env`, create networks, `docker compose up -d`, then configure Secrets + Settings in the UI.
