# Operator dashboard — wholesale-perfumes

**Clients / humans:** [`CLIENT-GUIDE.md`](CLIENT-GUIDE.md).
This file is the **engineering** map of every control.

Retail BeautyFort + BTS lives in [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).
This shop is always wholesale-perfumes. Live UI: `https://sillage-wholesale.mirainikki.xyz`.

Source of truth: `sillage_wpf.sil_settings` / `sil_vendors`. Auth: `DASHBOARD_USER` /
`DASHBOARD_PASSWORD` (env).

**Code map**

| Layer | Path |
|---|---|
| Pages | `production-environment/sillage-core/web/src/pages/*` |
| Nav | `web/src/components/Layout.tsx` |
| Client API | `web/src/lib/api.ts` |
| Server routes | `src/server/routes/api.ts` |
| Settings load | `src/db/settings.ts` |
| Secrets overlay | `src/config/secrets.ts` |
| Scheduler | `src/sync/schedule.ts` |
| Orders | `src/orders/{dispatch,rails,tracking,ingest,addresses}.ts` |
| Shop MOQ | `sillage-bridge` → `class-sillage-cart-fee.php` |

---

## Money safety

| Fact | Detail |
|---|---|
| Sandbox locked | `resolveDispatchDryRun()` always `true`. Dashboard Live is disabled. |
| No vendor sandbox | wholesale-perfumes has none. Dry-run must not `DELETE /cart` or `POST /cart/submit`. |
| Fail-closed | `orders_dry_run=1`, `orders_auto_dispatch=0` — API rejects turning those off. |

---

## Navigation

Overview · Sync · Products · Vendors · Orders · Secrets · Settings · Logs.

Layout subtitle: **wholesale · sandbox**.

---

## Sync / live cooldown

`GET /api/sync/live-status` exposes the **wholesale-perfumes store gate** (`wholesalePerfumes`),
not fake BeautyFort/BTS objects. Fast sync uses hourly store XML; daily rebuild uses catalog XML.

---

## Settings

Save → `PUT /api/settings`. Price/visibility keys kick a rewrite-only sync. `description_mode` /
`volume_filter_mode` kick a full/cache rewrite.

UI sections: **Shop URLs** → **Pricing & catalogue** → **Cart minimum** → **Schedule** →
**Order safety** → **Advanced**.

**Advanced is required** (volume facets + product blurbs + dry-run invoice payload):

| UI | Key |
|---|---|
| Volume filter | `volume_filter_mode` (`ranges` \| `exact` \| `off`) |
| Description mode | `description_mode` (`none` \| `template`) |
| Company billing | `company_billing_wholesale_perfumes` |

Hide-without-image: empty / placeholder URLs get `exclude-from-catalog` + `exclude-from-search`.

---

## Secrets

Only `WHOLESALE_PERFUMES_USER` / `WHOLESALE_PERFUMES_TOKEN`. Overlay file, hot-reload. GET never
returns values.

---

## Vendors

wholesale-perfumes only. Leftover slugs are `isParkedVendor` and cannot be activated.

---

## Orders

Per-vendor dispatch rows. Dry-run always. Company billing from Settings → Advanced.

---

## Env-only knobs

`DASHBOARD_*`, `SILLAGE_SHARED_SECRET`, `WHOLESALE_PERFUMES_*`, `WP_BASE_URL`,
`WORDPRESS_INTERNAL_URL`, `DB_*`, `SILLAGE_SECRETS_FILE`. No `BEAUTYFORT_*` / `BTS_*`.
