# DATA-PROFILE

Measured against the complete live feeds downloaded 2026-08-07, not the samples. Raw files are in
`.feedscratch/`.

**Totals: 55,320 raw offers → ~52,674 storefront products after EAN dedupe.**

| | BeautyFort | BTS |
|---|---|---|
| Products | 9,209 | 46,111 |
| Feed size | 3.5 MB | 22.3 MB |
| Download time | 6.2 s | 63 s |
| Categories | 63 paths, depth 2 | 4,103 nodes, depth 4 |
| Brands | 1,247 | 1,089 |

---

## BeautyFort

Thirteen keys, all present on every record: `Barcode`, `Brand`, `Category`, `Collection`,
`Description`, `FullName`, `Price`, `Quantity`, `Size`, `StockCode`, `StockLevel`,
`ThumbnailImageUrl`, `Type`. No type inconsistencies.

| Field | Findings |
|---|---|
| `StockCode` | 9,209 unique, zero duplicates. One letter + 6–7 digits (`P407231`). Max 8 chars |
| `Barcode` | 24 empty. **16% multi-EAN, up to 26 in one row.** Always 13 digits. 2,854 tokens have leading zeros. 11,608 unique EAN tokens |
| `Category` | 63 distinct paths, max depth 2, German. 9,206 of 9,209 are depth 2 |
| `Brand` | 1,247 distinct. Top: Armaf 222, Revlon 214, Sunkissed 175, Lattafa 159, Paco Rabanne 137 |
| `Type` | 177 distinct. Eau de Parfum 3,074, Eau de Toilette 1,667, then a long tail |
| `Size` | 141 distinct, 10.7% empty, always numeric when present. Top: 100 ml (2,333), 50 ml (1,043) |
| `Collection` | 4,020 distinct, never empty |
| `Description` | **100% empty** |
| `Price` | String. €0.85–€554.25, median €15.77. Always ≤ 2 decimals, never ≤ 0 |
| `StockLevel` | Number. 1–200, median 46. **Never 0** — zero-stock rows are excluded from the feed |
| `ThumbnailImageUrl` | **10.2% empty** (942). Single host `www.beautyfort.com`. No gallery field exists |
| `Quantity` | Empty on every record |

### Delivery options (EUR, confirms currency)

| id | Country | Price |
|---|---|---|
| 135 | DE | €7.15 |
| 132 | NL | €7.65 |
| 133 | IT | €8.05 |
| 139 | ES | €8.20 |
| 157 | PT | €8.20 |
| 138 | BE | €8.95 |
| 137 | SE | €10.65 |

Seven countries. No FR, AT, or UK — BeautyFort cannot fulfil elsewhere.

---

## BTS

Fifteen keys, all present on every record. No type inconsistencies.

| Field | Findings |
|---|---|
| `id` | 46,111 unique, range 130–421,568 |
| `ean` | Never empty, never duplicated, always 13 digits, single-value. **12.1% have leading zeros** |
| `categories` | `/`-separated IDs. 61% have 2, 31% have 3, up to 20. 1,834 distinct IDs referenced, **zero dangling** |
| `manufacturer` | 1,089 distinct. Top: DIOR 667, CATRICE 529, CLARINS 520, EUROSTIL 503, NYX 493 |
| `gender` | **98.4% `unisex`** (45,390). woman 352, man 278, children 91. Unusable as a facet |
| `price` | €0.07–€889.86, median €12.18. Never ≤ 0 |
| `recommended_price` | **0 on 21,070 rows (46%)**, max €42,795. Needs the clamp in DECISIONS #3 |
| `stock` | 0–600, median 3. **37.1% are zero** (17,117). ≤5: 25,880 |
| `image` | Never empty. Single host, 99.7% `.webp` |
| `description` | **100% empty**, no HTML |
| `name` | Max 195 chars |
| `delivery` / `leadtime_to_ship` | 48h on 42,992, 24h on 3,119 |
| `flammable` | true on 1,974 — usually blocks air freight |
| `restricted_countries` | Always `[]` |

### Category tree

4,103 nodes, 14 roots, max depth 4, **zero orphans and zero cycles**. Clean enough that a
straightforward recursive resolver works; no retry queue needed.

Roots by descendant count: Drugstore 1,179 · Men 567 · Parapharmacy 415 · Bath & Body 312 ·
Fragance 308 · Skin Care 275 · Designer perfumes 252 · Gifts 218 · Nutricosmetics 194 · Hair 176 ·
Makeup 127 · Sun 65 · COVID19 1 · REGALOS 0.

### Shipping

28 countries: 25 EU states (all but CY and MT) plus CH, GB, MC.

---

## Cross-vendor

**2,646 EANs appear in both feeds** — 22.8% of BeautyFort's 11,608 unique EANs, 5.7% of BTS's.

Neither vendor is consistently cheaper:

| EAN | BeautyFort | BTS |
|---|---|---|
| 4011700745401 | €4.55 | €7.03 |
| 4011700748822 | €11.05 | €10.40 |
| 4011700749232 | €11.05 | €13.17 |
| 0085715166012 | €22.13 | €27.95 |
| 0085715169617 | €15.77 | €17.99 |

## Column sizing from real maxima

| Field | Max observed | Use |
|---|---|---|
| Product name | 223 | `VARCHAR(500)` |
| Brand | 31 | `VARCHAR(191)` |
| Category path | 119 | `VARCHAR(300)` |
| Image URL | 90 | `VARCHAR(1000)` |
| Vendor product id | 8 | `VARCHAR(64)` |
| EAN | 13 | `VARCHAR(20)`, string always |
