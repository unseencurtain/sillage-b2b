# Sillage — agent entry point

Multi-vendor dropshipping sync between two wholesale APIs and a WooCommerce storefront
(**BeautyFort + BTS** retail). A second WordPress on the same VPS,
[`wholesale.mirainikki.xyz`](docs/WHOLESALE-SITE.md) (`docs/WHOLESALE-SITE.md`), sells
**wholesale-perfumes only** (minimum order €300, sandbox dispatch). Do not implement that
site on the old [sillage-b2b](https://github.com/unseencurtain/sillage-b2b) tree.

**Read [`docs/HANDOFF.md`](docs/HANDOFF.md) first — including the Memory section.** Hub images are
built on ovhe (`docker login` lives there). Wholesale is a second shop with its own MariaDB and
`wholesale-*` names; Valkey is shared on this VPS only.

**Read [`docs/AGENTS-RUNBOOK.md`](docs/AGENTS-RUNBOOK.md)** for the whole-project loop (sync, photos,
new VPS, orders). **Read `docs/CONTEXT.md` before touching anything.** It is the canonical fact sheet:
container names, database credentials, WooCommerce schema quirks, and the complete list of tables we
write to. Then read only the one spec under `docs/specs/` that covers your task. Do not go exploring —
everything you need is in those files.

**Operator dashboard:** every Settings / Vendors / Sync / Orders control for this retail shop is
documented in [`docs/OPERATOR-DASHBOARD.md`](docs/OPERATOR-DASHBOARD.md) (engineers).

**Client / human how-to:** [`docs/CLIENT-GUIDE.md`](docs/CLIENT-GUIDE.md). If you change dashboard
copy, Settings sections, order buttons, or shopper rules (cart, checkout, tracking, hide-without-image),
**update `CLIENT-GUIDE.md` in the same commit** so clients and the owner stay in sync.

**Change shop / dashboard / image hostnames:** [`docs/DOMAIN-MIGRATION.md`](docs/DOMAIN-MIGRATION.md).
What lives where: [`docs/FOLDER-STRUCTURE.md`](docs/FOLDER-STRUCTURE.md).
**Shop CPU / AI crawlers:** [`docs/CRAWLER-SHIELD.md`](docs/CRAWLER-SHIELD.md) — required on every VPS.
**Google / product sitemaps:** [`docs/SEO.md`](docs/SEO.md) — Googlebot must stay allowed; bridge patches WP sitemap 404s.

## Layout

| Path | What it is |
|---|---|
| `production-environment/sillage-core/` | Bun/TypeScript sync engine, HTTP API, React dashboard |
| `production-environment/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/` | Thin WooCommerce plugin |
| `production-environment/compose.yaml` | Single Docker Compose stack (ecom, db, valkey, media, sillage) |
| `production-environment/ecom_sites/` | Host data mounts + WP/nginx/MariaDB config (`lps-media` media dir) |
| `.feedscratch/` | Real downloaded vendor feeds, used as offline test fixtures (gitignored) |
| `product-dropshipping/` | Original standalone vendor clients. Reference only — do not edit |
| `docs/` | Client how-to [`CLIENT-GUIDE.md`](docs/CLIENT-GUIDE.md); engineers start at `CONTEXT.md` |
| `b2b-wholesale/` | Pointer to live wholesale in this repo ([`docs/WHOLESALE-SITE.md`](docs/WHOLESALE-SITE.md)). Old extract: [sillage-b2b](https://github.com/unseencurtain/sillage-b2b) (archive, do not deploy) |
| `tools/images/` | Offline image tools (Brasty Playwright scrape, etc.) |

## Hard rules

1. **Never read or write `production-environment/ecom_sites/data/wp/` or `data/wp-db/`** apart from
   the `sillage-bridge` plugin directory. They hold WordPress core and raw MariaDB files.
2. **Never commit secrets.** All credentials live in gitignored `.env` files.
3. **Bun writes products via raw SQL; PHP never does.** The plugin's job list is closed and
   enumerated in `docs/CONTEXT.md`. Adding write logic to PHP is a design violation.
4. **Orders are HPOS.** WooCommerce 11 stores orders in `wp_wc_orders`, not `wp_posts`.
5. **Placing a vendor order spends real money.** There is no sandbox on either API. Respect the
   dry-run flag and the dispatch safety rails.
6. **Client-facing behaviour has a human doc.** Keep [`docs/CLIENT-GUIDE.md`](docs/CLIENT-GUIDE.md)
   matching the live UI and shop rules in the same change.
7. **Hub images are built and pushed on ovhe.** That host is `docker login` as `unseencurtain`.
   Do not build Hub images in a cloud-agent VM or copy Docker Hub credentials off the VPS.
   See [`docs/HANDOFF.md`](docs/HANDOFF.md) **Memory**. Wholesale containers are `wholesale-*`,
   never `wpf-*`; wholesale has its own MariaDB.

## Commands

```bash
cd production-environment/sillage-core
bun install
bun run migrate            # apply sillage DB migrations
bun run sync -- --source=local --vendor=all   # offline, uses .feedscratch fixtures
bun run sync -- --source=live --vendor=bts
bun run dev                # API + dashboard on :4000
bun test
```

## Production deploy (one compose + one `.env`)

Canonical env: `production-environment/.env.example` → laptop
`production-environment/.env` → VPS `~/sillage/.env`.
Compose: `production-environment/compose.yaml` only (legacy
`ecom_sites/compose.yaml` / `redis/compose.yaml` are thin includes).
Hub images: `unseencurtain/sillage-core:<sha>`, `unseencurtain/sillage-wordpress:<sha>`.

```bash
cp production-environment/.env.example production-environment/.env   # fill vendors
./production-environment/scripts/deploy-vps.sh \
  --host ovhe --shop … --dash … --images … --skip-build   # or omit --skip-build to push
```

Full recipe: `docs/VPS-DEPLOY.md`. Live shop: SSH `ovhe` (`139.99.61.71`). SSH `ovh`
(`51.79.255.226`) is empty/unused. Split `ecom_sites/.env` / `sillage-core/.env` are
local-dev / migration leftovers only.
