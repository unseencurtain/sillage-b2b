# Client guide — wholesale-perfumes shop

Human how-to for the dashboard and shop. Engineers: keep this in sync with the UI.

Retail BeautyFort + BTS lives in [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).
This shop is **always wholesale-perfumes**. Minimum order **€300**. Dispatch is **sandbox** (dry-run
never spends).

Live: shop https://wholesale.mirainikki.xyz · dashboard https://sillage-wholesale.mirainikki.xyz

Dashboard username and password come from the operator creds file on the VPS. The username is never `admin`.

---

## 1. First login

1. **Secrets** — paste wholesale-perfumes user + token. Values are never shown again.
2. **Sync → Rebuild catalogue** — first full import. Catalogue only; never places vendor orders.
3. Check **Products**. Turn **Sync enabled** on in Settings so the schedule owns price/stock.

**Nothing imports before step 2.** A new shop keeps an empty catalogue on purpose so WordPress
can be finished first — pages, menus, theme, shipping. Until one import has succeeded the
schedule declines every check with *no sync has ever succeeded — start the first import from
the dashboard*. Pressing **Rebuild catalogue** is what starts it.

**A brand-new shop also arrives with its plugins switched off**, so you can style it before any
products exist. In WordPress → Plugins activate WooCommerce, Sillage Bridge and Redis Object
Cache, activate the theme under Appearance, then set up pages, menus and shipping. Tell your
engineer when you are done so they can run the readiness check, and only then press **Rebuild
catalogue**. WooCommerce must be active first: activating it is what creates the tables the
products go into.

**If a rebuild finishes and WooCommerce still shows no products**, the usual cause is that
**Sillage Bridge was switched off** during it. Nothing is lost and you do **not** need to rebuild
again — the products are already in the shop. The bridge is what tells WooCommerce to stop
showing its old, empty count, and it cannot do that while it is off. Activate **Sillage Bridge**,
then ask your engineer to run the readiness check: it clears the stale count in about fifteen
seconds and the whole catalogue appears.

---

## 2. Settings

**Pricing & catalogue.** Multiplier / tiers / stock threshold / hide-without-image. Save on those
fields recalculates shop prices from stored offers (no live vendor download).

**Hide products without image** (default on): empty or placeholder photos are excluded from the shop
catalogue and search. Stock can still be 1. Products → Shop column shows **Hidden · no image**.
Photos come from the wholesale-perfumes catalog (`flask_front` URLs). They are not files from
`~/sillage/data/media` — that folder is the Sillage retail CDN (BTS has no vendor images).

The Overview's **no photo** figure counts the thumbnail the shop would actually print, so it matches
what a buyer sees rather than how many vendor URLs exist. For the list itself, ask your engineer for
the missing-photo export: a spreadsheet of EAN, name, brand, price and stock for every product held
back purely for want of a picture, sorted by stock so the ones an image would publish today come
first. Send photos back keyed by **EAN**.

**Cart minimum** is an optional small-order fee. Independent of the **€300** wholesale MOQ (Vendors
→ Min order value), which hard-blocks checkout.

**Schedule.** Minutes between syncs = incremental store XML (price/stock). Daily full rebuild =
wholesale-perfumes catalogue + WordPress categories.

**Order safety.** Dry-run is locked on; auto-dispatch is locked off. Live vendor spend is disabled
in code, not only in this toggle.

**Advanced** (needed):

- **Volume filter** — ranges / exact ml / off (perfume facets)
- **Description mode** — none or template blurbs
- **Company billing** — one editor, `company_billing_wholesale_perfumes`, used on dry-run invoice payloads

---

## 3. Sync

**Rebuild catalogue** queues a full wholesale-perfumes import (or runs now if the shop is empty /
sync is off). **Update prices & stock** is a one-off — hide it while the schedule is on.

Fetched shows **WPF n** catalogue SKUs compared, not the raw hourly store XML line count.

---

## 4. Vendors

One card: wholesale-perfumes. Multiplier / FX / VAT / min stock / €300 min order / countries.
Credentials live on Secrets.

---

## 5. Orders

Each row is one wholesaler slice of a WooCommerce order. **Dry-run** records the payload and never
clears or submits the vendor cart. **Live** is disabled on this shop.

Fill company billing in Settings → Advanced before you care about the dry-run invoice payload.

Tracking fills in after a real vendor ship — not used while sandbox-locked.

---

## 6. Shopper rules

- €300 minimum order (checkout block). Optional small-order fee is separate.
- Products without a usable photo stay hidden while hide-without-image is on.
- No mixing of other suppliers — this catalogue is wholesale-perfumes only.
