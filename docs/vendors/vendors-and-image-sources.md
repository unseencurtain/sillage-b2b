# Vendors and image sources — integration notes

No credentials in this file. Stack secrets live in `production-environment/.env`
(template: `production-environment/.env.example`). Offline tools may use their own
local `.env` (`python-analysis/`, `tools/images/brasty/`) — not for compose/deploy.

See also CONTEXT §6 “Vendors versus image sources”.

## wholesale-perfumes.eu (SoleLuna spol. s.r.o.) — vendor (parked B2B)

This is the **B2B wholesaler**, not a consumer shop and not oceanfragrances. **Not sold on the
main LPS retail storefront** — parked for a separate site under repo `b2b-wholesale/`. Auth is
HTTP Basic `WHOLESALE_PERFUMES_USER` (e-shop email) + `WHOLESALE_PERFUMES_TOKEN` (API token from
their portal user settings). There is no separate shop password for Sillage — the token is the
credential.

`oceanfragrances.csv` is an offline **image** index only (see below); prefer this catalog XML for
pictures when enriching.

| Feed | URL pattern | Cadence |
|---|---|---|
| Catalog (pictures) | `/xml/catalog/LovelyXml/en` | Daily ~05:00 — download ≤1×/day |
| Stock + price | `/xml/store/LovelyXml/EUR` | Hourly |
| CSV pricelist | `/export_pricelist/csv` | Semicolon, UTF-8 |
| Cart / order API | `/api/v1/...` | HTTP Basic `email:api_token` |

### Sillage connector (slug `wholesale-perfumes`, sku_prefix `WPF`, storefront `LPS03`)

Implemented in `sillage-core/src/vendors/wholesale-perfumes/` +
`src/orders/adapters/wholesale-perfumes.ts`. Seeded inactive by migration
`013_wholesale_perfumes_vendor.sql`; forced parked again by `016_park_wholesale_perfumes_b2b.sql`.
Excluded from `--vendor=all` via `PARKED_B2B_VENDOR_SLUGS`. Do **not** activate on the cosmetic
shop. Scaffold + API notes: `b2b-wholesale/`. `product_cat` = feed product **type**; brands map to
`product_brand`.

- Catalog + store joined on vendor `id`. Store feed alone powers `fetchPriceStock`.
- Live gates: catalog max 1/day and store hourly caps live on `sil_vendors`
  (`live_max_per_day` / `store_live_max_per_day` / `store_live_min_minutes`).
- Offline: `--source=local` reads `wholesale_perfumes_catalog.xml` +
  `wholesale_perfumes_store.xml` from `FIXTURES_DIR`, falling back to
  `tests/fixtures/wholesale_perfumes_*.xml`.
- Pricing: store publishes `price_no_vat`. `sil_vendors.vat_rate` defaults to **0** (operator must
  confirm the correct fraction before live retail prices are right). Cost =
  `vendorPrice × fxRate × (1 + vat_rate)` before markup tiers.
- Orders: cart is account-global — submit runs under `GET_LOCK('sillage:wholesale-perfumes-cart')`.
  Dry-run performs **no** remote mutation (not even `DELETE /cart`). No idempotency key → same
  needs_attention rails as BTS (decision 25). Submit sends optional `note` = our `SIL-*`
  reference. JSON bodies use application-level `error` codes (0 = OK) even on HTTP 200.
- Cart line `code` = catalog product `id` (not EAN), per the vendor B2B API doc
  (`b2b-wholesale/docs/wholesale-perfumes-api.md`). Isolated in `wholesalePerfumesCartCode()`.

### Operator-confirmable seed guesses (migration 013)

| Field | Seeded value | Status |
|---|---|---|
| `min_order_value_eur` | `100` | Guessed amount; product decision = MOQ on cart (hard block). Confirm euros with operator |
| `serviceable_countries` | see below | From [shipping-payment](https://www.wholesale-perfumes.eu/shipping-payment/) |
| `vat_rate` | `0` | Deliberately unset — do not invent a rate |

**Serviceable countries (shipping pricelist, valid from 2025-10-18):**
`AT BE BG CZ DE DK EE ES FI FR GB GR HR HU IT LT LV NL PL PT RO SE SI SK`

Package rules from that page: max **25 kg** / box, ~60 perfume bottles per box, EU delivery typically 3–5 working days; payment is proforma / advance (COD only CZ/SK/PL).

Docs: https://www.wholesale-perfumes.eu/api/docs/ · https://www.wholesale-perfumes.eu/xml-export/  
Sanitized cart/order notes (no secrets):
[`b2b-wholesale/docs/wholesale-perfumes-api.md`](../../b2b-wholesale/docs/wholesale-perfumes-api.md).

Env placeholders: `WHOLESALE_PERFUMES_USER`, `WHOLESALE_PERFUMES_TOKEN`,
`WHOLESALE_PERFUMES_CATALOG_URL`, `WHOLESALE_PERFUMES_STOCK_URL`,
`WHOLESALE_PERFUMES_API_BASE_URL` in `production-environment/.env.example`
(mirrored in `sillage-core/.env.example` for host-side `bun` only).

## oceanfragrances — image source only

A CSV of EAN→image-URL pairs (`python-analysis/.../products/oceanfragrances.csv`). **This — and
only this — is what “ocean” means.** Not a vendor: no stock, no prices, no orders, no
`sil_vendors` row.

## Brasty (wholesale.brasty.com) — image source only

Brasty is **not** a Sillage vendor. No catalogue sync, order API, or shipping rules.
It exists purely to obtain product photographs. Matching is by **EAN alone** (the
`image_overrides.json` map is vendor-agnostic), so a Brasty photo can illustrate a
BeautyFort or wholesale-perfumes product and vice versa.

| Feed | Notes |
|---|---|
| Product CSV | Full range; **no image URLs** — used as the scrape input list |
| Availability CSV | Not used (no vendor connector) |

Images are watermarked on the site; optional LPS logo overlay via the tool below.
Acquisition is a **Playwright** scrape (search by EAN on the product list — no PDP
pages). Spec: `beastly-image.md` (operator notes, not in repo).

### Brasty image tool (`tools/images/brasty/`)

Standalone Node/Playwright package (not a sillage-core dependency). Runs headless
on a VPS (no X server). Operator flow:

1. Set `BRASTY_EMAIL` / `BRASTY_PASSWORD` in the tool `.env` (never commit)
2. `npm run login` — headless credential login → gitignored `storageState.json`
   (`ensureSession` re-logins automatically if the session expires)
3. `npm run investigate` — evidence gate for how the large preview loads (DOM / data-* /
   hover inject / CSS bg / network / API / thumb→full URL). Writes `findings/`.
4. Operator pastes a concrete extraction strategy into `src/imageExtractor.ts` from findings
5. `npm run download` → `output/EAN.jpg` (resume via JSONL manifest; `CONCURRENCY=1` default)
6. Optional `npm run watermark` — LPS logo via sharp into `watermarked/`
7. `npm run build-overrides` — merge EAN→`PUBLIC_URL_BASE` URLs into
   `sillage-core/data/image_overrides.json` (never clobber existing keys)
8. Host files under `ecom_sites/data/media/` (host bind-mount into `lps-media` nginx;
   public path `/lps-media/` via edge proxy — keep media out of `data/wp/`)
9. Fast/rewrite sync so the storefront picks up the new override URLs

### Shipping rates (reference only — not used)

Kept for operator reference; **not wired into Sillage** (no Brasty order path).

- Pack weight: **one box per 26 kg** (42 kg → 2 boxes, 53 kg → 3 boxes).
- Orders **over 120 kg** → pallet, individual price.
- Per-country DHL / PPL / GLS rates: see operator `beastly-shipping.md`.

## Image experiments (`python-analysis/`)

Hard image work (bulk download, EAN matching, watermark trials) belongs under
`production-environment/python-analysis/`, not in the Bun sync hot path. Typical
loop: download wholesaler / Brasty images into a local `products/` or `output/`
dir → build `image_overrides.json` → `--install-core` into
`sillage-core/data/image_overrides.json` → shop rewrite sync. The
`beautyfort-enriched/` package is that sandbox; fixtures under `products/` stay
gitignored.

## Next steps

1. Done: wholesale-perfumes XML → BeautyFort `image_overrides.json`.
2. Done: wholesale-perfumes catalogue connector + cart order adapter (inactive until operator enable).
3. Countries seeded from shipping-payment page (in migration 013). Cart `code` confirmed as
   catalog id by the B2B API doc; still confirm MOQ / VAT / serviceable countries before enabling.
4. Brasty Playwright in `tools/images/brasty/` **or** bulk image download inside
   `python-analysis/` — whichever is faster for filling missing photos.
