# Photo inventory — 2026-09-03T20:39:10Z

Home folder on the VPS is **`brasty/`** (not `resty`). 36,044 files; **1,269** are the grey camera placeholder (not a product photo) and are excluded.

The wholesale `export.csv` has **11,013 EANs and no image URLs**. It does not add photos.

## One last list: can we put a photo on it?

| Verdict | All SKUs missing a shop photo | Of those, the Overview **no/weak image in-stock** card |
|---|---|---|
| **CAN fill** (we already have a real file or URL, not applied) | **13,191** | **9,621** |
| **CANNOT fill** (no CDN, override, scrape, or real Brasty file) | **169** | **153** |

Open these first:

- `lists/CAN-FILL.csv` — we can attach a photo (inspect scrape/Brasty first)
- `lists/CANNOT-FILL.csv` — no photo exists in any source we have
- `lists/CAN-FILL-in-stock-hidden-no-image.csv` — the Overview **9,775-style** card that we **can** fill
- `lists/CANNOT-FILL-in-stock-hidden-no-image.csv` — same card, nothing to attach

`fill_verdict` is `CAN` / `CANNOT` / `ALREADY_ON_SHOP`. `best_image_origin` says where the file would come from.

## Overview cards (same SQL as the dashboard)

| Card | Count |
|---|---|
| Visible in shop | 25,978 |
| Published in WP | 54,509 |
| **Hidden · no/weak image** (in stock) | **9,774** |
| Hidden · stock threshold | 18,756 |

Out of stock is a **separate** list (`02` / `04` / `05`). A SKU with no photo **and** stock 0 is on the stock card in Overview, not the image card.

## Other files

| File | What |
|---|---|
| `01-hidden-no-or-weak-image-IN-STOCK.csv` | Overview image card (in stock, catalog-hidden) |
| `02-missing-photo-OUT-OF-STOCK.csv` | No usable photo, out of stock |
| `03-missing-photo-ALL.csv` | Every published SKU with no usable shop photo |
| `04-out-of-stock-WITH-photo.csv` | Hidden for stock, already has a photo |
| `05-out-of-stock-NO-photo.csv` | Hidden for stock, no photo |
| `all-products.csv` | Every published product: name, EAN, stock, every image source |

Do **not** apply `scraped/` or Brasty to the shop until inspected. Hide-without-image stays on.
