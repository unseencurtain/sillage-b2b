# Client feature backlog

Source: client chat (`chat-with-client.md`, Aug 2026) + vendor feed handoff (Aug 2026).

| Priority | Item | Notes |
|---|---|---|
| P0 | Missing product photos (`no_image` / placeholders) | **Done (stage 3):** cross-vendor EAN fill on full+fast sync; `hide_products_without_image` (default on) excludes unresolved placeholders. Overrides still via `image_overrides.json` / the python-analysis enricher. |
| P0 | Theme compatibility (Astra / Blocksy / Elementor) | Bridge attachment filters (see `sillage-bridge`). |
| P1 | Rename shop sections to **LPS01** (BTS) / **LPS02** (BeautyFort) | **Done (stage 3):** `sil_vendors.storefront_label`; root `product_cat` renamed in place. SKU prefix / slug formula unchanged. |
| P1 | Vendor **wholesale-perfumes.eu** (full catalogue + orders) | **Parked / decoupled:** connector stays in sillage-core but inactive + excluded from `--vendor=all` on this shop. Future own site under [`b2b-wholesale/`](../b2b-wholesale/README.md). Cart `code` confirmed for that project. |
| P1 | Brasty **Playwright image scrape** | Image source only (EAN → `image_overrides.json`). Tool: `tools/images/brasty/`. See `docs/specs/S3-images.md`. |
| P2 | ~~Vendor **wholesale.brasty.com** (full catalogue + orders)~~ | **Dropped.** Brasty is photos-only; no catalogue/order connector. |
| P2 | ~~Brasty shipping rules (26 kg/box, pallet >120 kg)~~ | **Dropped.** Kept as reference in [`vendors-and-image-sources.md`](vendors/vendors-and-image-sources.md); not wired. |
| P2 | Tiered retail markup | **Done (stage 3):** `sil_settings.price_tiers` JSON; dashboard editor; empty `[]` keeps single multiplier. |
| P2 | Cart minimum / small-order surcharge | **Done:** global `cart_min_*` = optional Foodpanda-style fee; per-vendor `min_order_value_eur` = hard block + storefront-label shortfall on cart/checkout (independent of fee toggle). |
| P3 | ~~B2B portal on this shop~~ | **Superseded.** B2B gets its own website later (`b2b-wholesale/`). This shop is BF/BTS retail only. Never reintroduce LPS* as `product_cat`. |

## Deploy notes (Aug 2026)

| Fact | Value |
|---|---|
| Live SSH | `ovhe` (`139.99.61.71`) — retail shop + dashboard. `ovh` (`51.79.255.226`) unused |
| Wholesaler / B2B site | Separate future project — scaffold in `b2b-wholesale/` (not on this WP) |
| Storefront labels | LPS01 = BTS, LPS02 = BeautyFort (LPS03 parked; `_sillage_vendor` + `storefront_label` for ops/MOQ; never `product_cat` or visible `pa_vendor`) |
| Image CDN | `sil_settings.image_cdn_base_url` / `LPS_MEDIA_BASE_URL` → `https://images.<domain>/…` via `lps-media` |
| Unified deploy | `production-environment/compose.yaml` + `scripts/deploy-vps.sh` (build/push Hub tags, rsync plugin + overrides, remote `compose pull && up`) — see `docs/VPS-DEPLOY.md` |

## Image pipeline (operator)

```bash
cd production-environment/python-analysis
cp .env.example .env   # set WHOLESALE_PERFUMES_USER + WHOLESALE_PERFUMES_TOKEN (API token from their portal)
python3 beautyfort-enriched/enrich.py --fetch-wholesale-perfumes --install-core
# Then on the shop: fast sync / rewrite so product meta picks up new URLs
```

## Out of scope until scheduled

Brasty catalogue/order connectors and shipping rules are dropped (image source only).
Brasty Playwright bulk download remains P1 above. wholesale-perfumes is parked off this
storefront (`b2b-wholesale/`). Exact MOQ euros / countries / VAT remain for the future B2B site.
