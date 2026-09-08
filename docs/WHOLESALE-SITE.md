# Wholesale storefront — `wholesale.mirainikki.xyz`

Second WooCommerce + sillage-core instance on the **same VPS** as the LPS retail shop.
Copied from this retail tree (`SILLAGE_PROFILE=wholesale`). Do **not** implement on the old
`sillage-business` / [sillage-b2b](https://github.com/unseencurtain/sillage-b2b) branch.

**Live since 2026-09-08** on ovhe. Shop and dashboard already have TLS.

## What it is

| | Retail (`prinscosmetic.eu`) | Wholesale (`wholesale.mirainikki.xyz`) |
|---|---|---|
| WordPress datadir | `~/ecom_sites/data/wp` | `~/ecom_sites/data/wp-wholesale` |
| MariaDB | `ecom-db` (`wp-db`) | **`wholesale-db`** (`wholesale-db`) |
| Woo DB | `earth` | `earth_wpf` on wholesale-db |
| Engine DB | `sillage` | `sillage_wpf` on wholesale-db |
| Containers | `ecom`, `sillage-core`, `sillage-cron` | `wholesale-ecom`, `wholesale-core`, `wholesale-cron`, `wholesale-db` |
| Loopback | `:104` shop, `:4000` dash, `:3307` db | `:106` shop, `:4001` dash, `:3308` db |
| Valkey | prefix default / db 0 | **shared on ovhe** prefix `wholesale:` / db **1** |
| Sync lock | `sillage:sync` | `sillage-wholesale:sync` |
| Vendors | BeautyFort + BTS | **wholesale-perfumes only** |
| Min order | none (BF/BTS have no MOQ) | **€300** (`order_config.min_order_value_eur`) |
| Dispatch | dry-run default, Live still exists | **sandbox-locked** — Live disabled in UI and in `dispatchVendorOrder` |
| Engine image | `SILLAGE_CORE_IMAGE` | **same tag** (`SILLAGE_PROFILE=wholesale`) |

Valkey is **shared on ovhe only**. MariaDB is **not** shared. HMAC secrets and schemas are not.

If `wholesale-core` is healthy and https://sillage-wholesale.mirainikki.xyz/health returns
`"profile":"wholesale"`, **do not re-run a destructive install**. Remaining work:

1. Wholesale dashboard → Secrets: `WHOLESALE_PERFUMES_USER` / `WHOLESALE_PERFUMES_TOKEN`.
2. Settings Shop URL is `https://wholesale.mirainikki.xyz`. Leave Orders dry-run **on** (locked).
3. Sync → Run sync now (source live). First full catalogue is large; RAM on this box is tight.
4. Logins: `DASHBOARD_*` (both dashboards) and `WHOLESALE_WP_ADMIN_PASS` (wholesale wp-admin;
   old key `WPF_WP_ADMIN_PASS` is a fallback) in `~/sillage/.env` — never git.

## First bring-up (only if the site is gone)

1. DNS: `wholesale.mirainikki.xyz` and `sillage-wholesale.mirainikki.xyz` A → `139.99.61.71`.
2. Hub image must include wholesale profile code (`isWholesaleProfile` re-exported from
   `src/storefront/profile.ts`). Then:

```bash
cd ~/sillage
bash scripts/bootstrap-wholesale.sh
```

That creates DBs, starts the `wholesale` compose profile, installs WordPress + WooCommerce + HPOS + redis-cache + sillage-bridge, patches wp-config via `WORDPRESS_CONFIG_EXTRA`, migrates `sillage_wpf`, pins WPF MOQ €300, writes `.htaccess` so `/shop/` and `/product/…` pretty permalinks work, sets the WooCommerce Shop page as the homepage, turns off WooCommerce **Coming soon**, and appends Caddy sites (crawler shield on the shop host). Re-runs skip missing HPOS tables instead of aborting grants.

## Sandbox

`resolveDispatchDryRun()` returns `true` whenever `SILLAGE_PROFILE=wholesale`. The wholesale-perfumes adapter **does not** `DELETE /cart` or `POST /cart/submit` in dry-run. There is no vendor sandbox; this is how we still exercise ingest → approve → dry-run dispatch without spending.

Do not remove that lock without an explicit operator decision to go live.

## Plugin

Same `sillage-bridge` copy. wp-config must define:

- `SILLAGE_CORE_URL` = `http://wholesale-core:4000`
- `SILLAGE_SHARED_SECRET` = `WHOLESALE_SILLAGE_SHARED_SECRET` (not the retail secret)
- `SILLAGE_DB` = `sillage_wpf`
- `SILLAGE_STOREFRONT_PROFILE` = `wholesale` (MOQ copy on cart/checkout)
- Redis: host `valkey`, prefix `wholesale:`, database `1`

The official WordPress image **evals** `WORDPRESS_CONFIG_EXTRA` from compose. Do not also paste the same `define()`s before “That's all” — that duplicates constants.

## Hub vs bind-mount

Day-2 updates are **Hub pull** of `unseencurtain/sillage-core:<sha>` (retail and wholesale). Do not
bind-mount `sillage-core/src` over `/app/src` on the live box unless the Hub tag is behind git.

## Retail isolation

Retail sync still calls `parkWholesalePerfumesFromMainStorefront()`. Wholesale sync parks BeautyFort + BTS. `GET_LOCK('sillage:sync')` and `GET_LOCK('sillage-wholesale:sync')` do not block each other.
