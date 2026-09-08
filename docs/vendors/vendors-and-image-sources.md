# Vendors and image sources — wholesale-perfumes shop

No credentials in this file. Secrets live in `production-environment/.env` (never commit).

Retail BeautyFort + BTS: [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).

This shop has **one vendor**: `wholesale-perfumes` (sku prefix `WPF`). Image overrides are EAN →
URL maps — not a second vendor.

| Feed | Cadence |
|---|---|
| Catalog XML (`/xml/catalog/LovelyXml/en`) | Daily — `live_max_per_day` default 1 |
| Store XML (`/xml/store/LovelyXml/EUR`) | Hourly — separate store gate |
| Order API `/api/v1` | Sandbox-locked in this repo |

Connector: `sillage-core/src/vendors/wholesale-perfumes/`.
Order adapter: `src/orders/adapters/wholesale-perfumes.ts`.
API notes: [`wholesale-perfumes-api.md`](wholesale-perfumes-api.md).

- Catalog + store joined on vendor `id`. Store feed alone powers `fetchPriceStock`.
- Offline: `--source=local` reads `wholesale_perfumes_catalog.xml` +
  `wholesale_perfumes_store.xml` from `FIXTURES_DIR`.
- Cart line `code` = catalog product `id`. Dry-run performs **no** remote mutation.
- Company billing: Settings → Advanced → `company_billing_wholesale_perfumes`.

Leftover `beautyfort` / `bts` rows in `sil_vendors` (copied retail DB) are parked. There are no
BeautyFort or BTS connectors in this repo.
