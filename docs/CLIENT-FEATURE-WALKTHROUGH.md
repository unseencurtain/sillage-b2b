# Sillage — Feature Delivery Walkthrough

**How to use the shop and dashboard day to day:** [`CLIENT-GUIDE.md`](CLIENT-GUIDE.md)
(written for humans). This page is a **demo script** for a live review, not the user manual.

**Project:** Multi-vendor perfume/cosmetics dropshipping sync (BeautyFort + BTS → WooCommerce)  
**Ops dashboard:** https://sillage.prinscosmetic.eu  
**Storefront:** https://prinscosmetic.eu  

This document lists what was delivered and how to navigate each capability. Use it in client reviews and handovers.

---

## 1. Catalogue sync engine (core)

**What it does**  
Imports and maintains tens of thousands of products from BeautyFort and BTS into WooCommerce via bulk SQL (not slow REST product-by-product writes). Handles create, price/stock updates, vanish (out of catalogue), brands, categories, and attributes.

**How to navigate**
1. Open **https://sillage.prinscosmetic.eu** → log in.
2. Go to **Sync**.
3. Review the run table: mode (`fast` / `full`), Fetched (`BF n · BTS m`), writes, duration.
4. Use **Rebuild catalogue** for the first import or a full structure refresh (queues when Sync enabled is on). Leave **Sync enabled** on for scheduled price/stock. **Update prices & stock** is a one-off only when the schedule is off.

**Value to the client**  
A full catalogue that would be impractical to maintain by hand stays aligned with wholesaler stock and pricing on a schedule.

---

## 2. Call interval (no daily download cap)

**What it does**  
Each wholesaler is called on a single interval (Settings → **Minutes between syncs**). That number is **how often we may call**, not “minutes a day”:
- BeautyFort and BTS are gated independently — one cooling down does not block the other
- There is **no daily download cap**
- When a vendor is inside its interval, that vendor is skipped (no silent reuse of a stale on-disk feed)
- Cron ticks every 5 minutes and starts a run when the interval has elapsed

**How often prices/stock actually move** (Vendors → How often this vendor updates):
- **BeautyFort:** every check (~30 min) — they have no change-only feed
- **BTS:** **about once a day** on the shop. We still check every 30 min; empty checks are normal until BTS publishes their daily change batch. A full ~45k rebuild is *not* the daily update (use Sync → Rebuild, or auto-recovery after a week of missed data)

**How to navigate**
1. **Vendors** → How often this vendor updates (BeautyFort vs BTS cadences + last live fetch).
2. **Sync** → BF / BTS ready vs wait-N-min.
3. **Settings → Schedule → Minutes between syncs** (one number for both the schedule and the API gate).

**Value to the client**  
Keeps wholesaler APIs on a predictable cadence without an extra “downloads per day” knob that no longer does anything. BTS looking “once a day” is their feed, not a hidden daily cap.

---

## 3. Stop all sync (kill switch)

**What it does**  
Immediately requests abort of the running sync (between batches) and turns **Sync enabled** off so nothing restarts until you allow it.

**How to navigate**
1. **Sync** → **Stop**.
2. To resume the schedule: turn **Sync enabled** on in **Settings**. A manual Update does **not** turn the schedule back on.

**Value to the client**  
Operator control during incidents, pricing experiments, or before a careful live import.

---

## 4. Pricing: cost × multiplier (no fake RRP)

**What it does**  
Storefront price = **vendor cost × multiplier** (e.g. multiplier `5` → €1 cost sells at €5). Vendor “recommended retail” is **not** used (BTS RRPs are often zero or absurd).

**How to navigate**
1. **Settings** → **Price multiplier**.
2. Save. A **rewrite-only** sync starts automatically (updates WooCommerce **without** a new live vendor download).
3. Confirm on the storefront product page.

**Value to the client**  
Clear margin control that actually shows up on the shop, without misleading “was/now” strike-throughs from bad RRP data.

---

## 5. Product descriptions & titles

**What it does**  
Vendor feeds ship empty descriptions. Products get the **title copied into description and short description** so pages are never blank.

**How to navigate**
1. Open any product on the storefront.
2. Description area shows the product name (or richer template if Description mode is set to `template` in Settings).

---

## 6. Image enrichment (BeautyFort) and hide-without-image

**What it does**  
Many BeautyFort images are tiny `/pic/` thumbs; BTS often ships `no_image.webp`. The sync resolves a storefront image by EAN from:
- Curated overrides (`data/image_overrides.json`)
- Matching BTS / other vendor images when that URL is actually usable  

If Settings **Hide products without image** is on (default) and the resolved URL is still empty, a placeholder, BTS `no_image`, or a BeautyFort `/pic/` thumb, the product is **excluded from the shop catalogue and search**. It stays in WooCommerce and on the dashboard Products table (Shop = **Hidden · no image**). Stock can still be 1. This is the same `exclude-from-catalog` + `exclude-from-search` terms as the stock-threshold rule.

**How to navigate**
1. **Settings → Pricing & catalogue → Hide products without image** — the long help text is the spec.
2. **Products** — search SKU/EAN; **Shop** column shows why a listing is missing from the store.
3. Browse BeautyFort products on the storefront; prefer ones that previously showed placeholders — many now show full CDN images after fill.

**Value to the client**  
Higher conversion from usable product photography, without listing thousands of cards that only have a broken thumb.

---

## 7. Vendor identity (ops only)

**What it does**  
Each product carries `_sillage_vendor` postmeta (`bts` / `beautyfort`) for cart rules, MOQ, and dispatch. Storefront labels (LPS01/LPS02) live in `sil_vendors.storefront_label` for operator/MOQ copy — they are **not** product categories and **not** shown on the product page Additional information table.

**How to navigate**
1. Ops: Vendors page in the dashboard (labels, MOQ, multipliers).
2. Storefront browse uses feed categories and brands only — no LPS vendor lane in the category tree.

**Value to the client**  
Wholesaler lanes stay invisible to shoppers and marketplace category maps; ops still know which supplier owns each SKU.

---

## 8. Volume filter (ranges)

**What it does**  
Instead of hundreds of individual ml terms, volumes bucket into ranges (e.g. Up to 30 ml, 51–100 ml). Toggleable via Settings (`ranges` / `exact` / `off`).

**How to navigate**
1. **Settings** → **Volume filter**.
2. Storefront shop filters → **Volume**.

---

## 9. Single-vendor cart

**What it does**  
A cart cannot mix BeautyFort and BTS. Add-to-cart warns and blocks; checkout is blocked if mixed.

**How to navigate**
1. Add a BTS product to cart.
2. Try adding a BeautyFort product → error notice explaining separate checkouts.

**Value to the client**  
Matches how dispatch works (one vendor shipment per order) and prevents undeliverable mixed carts.

---

## 10. Checkout countries limited by vendor

**What it does**  
At checkout, country dropdowns only list countries that **the cart’s vendor can ship to** (BeautyFort: smaller EU set; BTS: broader EU+).

**How to navigate**
1. Add products from one vendor.
2. Checkout → shipping/billing country list is restricted accordingly.

---

## 11. EAN on product page + search

**What it does**  
Primary EAN is shown beside SKU on the product page. Barcode-shaped searches resolve via `sil_ean_index` for fast lookup.

**How to navigate**
1. Product page → look for **EAN:** under product meta.
2. Store search → paste a barcode/EAN.

---

## 12. Order ingest & multi-vendor split

**What it does**  
When a WooCommerce order becomes paid (`processing` / `completed`), Sillage creates **one vendor order row per wholesaler** involved, with cost, reference, and line mapping (HPOS-aware).

**How to navigate**
1. Place a test order on the storefront.
2. Dashboard → **Orders** → see `SIL-…-BF` / `SIL-…-BTS` rows.

---

## 13. Dispatch with safety rails (dry-run / live)

**What it does**
- **Dry-run** (default): builds the real payload, does not spend money.
- **Live**: submits to the vendor (real money; no vendor sandbox).
- Rails: country coverage, max order value, daily spend cap, manual approve when auto-dispatch is off.
- After a dry-run, **Live** can reopen that row (no silent “already submitted” dead end).
- BeautyFort may land in **Payment Hold** — order exists at BF; pay in their portal if automatic payment is off.

**How to navigate**
1. **Orders** → select a vendor order.
2. Edit **ship-to** address if needed → Save.
3. **Approve** → **Dry-run dispatch** to verify.
4. **Live** → inline confirm (no browser alert) → toast shows status + vendor order number.
5. **Settings** → Orders dry-run / auto-dispatch / caps.

**Value to the client**  
Safe ops workflow that avoids accidental double-spend while still supporting real dropship dispatch.

---

## 14. Tracking (ops + customer)

**What it does**
- Polls vendors for tracking after submit.
- Shows parcels on the **Orders** detail panel.
- Pushes tracking into WooCommerce (order notes / meta); can email the customer when enabled.
- Customer page: **https://prinscosmetic.eu/track-order/** (order number + checkout email).

**How to navigate**
1. Ops: **Orders** → open row → **Tracking** section (fills after the vendor ships).
2. Customer: open `/track-order/`, enter order number + email.
3. **Settings** → Notify customer on tracking.

---

## 15. Ops dashboard UX

**What it does**
- Toggle switches for booleans (not `0`/`1` text).
- Toasts instead of `alert` / `confirm`.
- Sync running banner + polling.
- Inline live-dispatch confirmation.
- KPI overview of catalogue + recent syncs + order status mix.

**How to navigate**
1. **Overview** — health at a glance.  
2. **Sync** — runs + live API gates + Stop.  
3. **Orders** — dispatch console.  
4. **Settings** — single source of truth (not scattered in wp-admin).  
5. **Products** — search SKU / name / EAN.

---

## 16. WooCommerce bridge plugin (`sillage-bridge`)

**What it does** (thin by design — Bun owns writes):
- External vendor images (theme-agnostic)
- EAN search
- Finalize / cache invalidation after bulk import
- Order webhook → Sillage
- Tracking push + customer notify
- Single-vendor cart + ship countries
- Customer track shortcode `[sillage_track]`
- wp-admin **WooCommerce → Sillage Sync** status checks (currency EUR, HPOS, WP-Cron off, etc.)

**How to navigate**
1. wp-admin → **WooCommerce → Sillage Sync** (green/red health).  
2. Storefront behaviours above require no extra theme plugins for core sync.

---

## 17. Production deploy (OVH + Caddy)

**What it does**
- Storefront domain → WordPress  
- Dashboard domain → Sillage API/UI with HTTPS  
- MariaDB tuned for 4 GB VPS  
- One-script redeploy path for future VPS  

**How to navigate**
- Shop: https://prinscosmetic.eu  
- Dashboard: https://sillage.prinscosmetic.eu  
- Redeploy helper: `production-environment/scripts/deploy-vps.sh`  
- Dashboard password after deploy: `.deploy/vps-dashboard.txt` on the operator machine (not in git)

---

## Suggested demo script (10–12 minutes)

| Step | Show |
|---|---|
| 1 | Storefront category **BeautyFort** vs **BTS Wholesaler** |
| 2 | Product with image + EAN + price reflecting multiplier |
| 3 | Try mixed cart → blocked |
| 4 | Checkout country list limited for that vendor |
| 5 | Dashboard **Overview** + **Sync** live-gate cards |
| 6 | Change multiplier → save → note rewrite sync (no live API burn) |
| 7 | **Orders**: dry-run → live confirm → vendor number toast |
| 8 | `/track-order/` page |
| 9 | **Stop all sync**, then re-enable |

---

## Technical posture (one slide)

- **Bun/TypeScript** sync engine + React ops dashboard  
- **Thin PHP bridge** only where WordPress must be in the loop  
- **HPOS** order tables (WooCommerce 11)  
- **Dry-run default** for vendor spend  
- **Cached feeds + hard rate limits** to protect wholesaler APIs  
- **EUR** storefront currency aligned with vendor quotes  

---

## Login reminder (ops)

| Surface | URL | Notes |
|---|---|---|
| Dashboard | https://sillage.prinscosmetic.eu | User `admin`; password from operator `.deploy/vps-dashboard.txt` |
| Storefront | https://prinscosmetic.eu | Customer-facing shop |
| Track order | https://prinscosmetic.eu/track-order/ | Order number + email |

---

*Prepared for client presentation of the Sillage delivery. Feature set reflects the production branch deployed to the OVH VPS with Caddy for both domains.*
