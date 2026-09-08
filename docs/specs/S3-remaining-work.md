# S3 — remaining work, written for an agent to execute alone

This spec exists because the operator is handing execution to a coding agent with no memory of the
sessions that produced Stage 3. Everything needed is here or in the two documents it points at.

**Before any task:** read `../../AGENTS.md`, then `../CONTEXT.md`. Trust `CONTEXT.md` over your
instincts about WordPress and WooCommerce — several things in this install are not the default.
Then read only the task below that you were asked to do.

For **product images**, read [S3-images.md](S3-images.md) first — it is the ordered playbook
(WPF XML → oceanfragrances CSV → Brasty → cross-vendor fill).

---

## 0. Naming and environments — do not assume

Two things have already caused real mistakes. Both are settled; do not re-derive them.

**There are exactly three vendors in code.** `bts`, `beautyfort`, and `wholesale-perfumes` (B2B
at wholesale-perfumes.eu / SoleLuna). **This retail shop syncs only BF + BTS**; wholesale-perfumes
is parked under `b2b-wholesale/` for a future separate site. Everything else that produces pictures
— **oceanfragrances** (a CSV), **Brasty**, the Shopify export, one vendor's photo filling another's
product — is an *image source*: EAN → image URL, no stock, no prices, no orders. Do not add a fourth
vendor row, connector, or SKU prefix for an image source. The full table is in `CONTEXT.md` §6 under
"Vendors versus image sources"; read it before touching vendor code.

"Ocean" means oceanfragrances, the image CSV, and nothing else. An earlier agent named the
wholesaler `ocean`; that was wrong and was corrected in `568eb38`. Surviving `ocean` strings in the
tree are deliberate image-source references — leave them.

**Two VPS hosts exist and they are not interchangeable.**

| SSH host | Hostname | Role | What you may do |
|---|---|---|---|
| `ovhe` | `ovh-experi` | **Live** retail shop | Deploy, migrate, sync, restart |
| `ovh` | `ovh` | Unused (empty) | Do not deploy unless repurposed |

Test on `ovhe` once local `bun test` / `bun run typecheck` are green. Regardless of host: never run
`--source=live` against the wholesaler, and never dispatch a real vendor order — that spends real
money and neither API has a sandbox.

Applied-migration state, verified 7 Aug: local `007`, `ovhe` `008`, `ovh` `009`. Migrations `010`
onward are unapplied everywhere, and `sil_vendors` holds only `beautyfort` and `bts`.

---

## 1. Where things stand

All Stage 3 work lives on branch `cursor/client-features-stage3` (commits below; tip may
advance — use `git log origin/cursor/client-features-stage3 --oneline`):

| Commit | What landed |
|---|---|
| `45a59bb` | Cost-band markup tiers, LPS01/LPS02 storefront labels, hide-products-without-image |
| `90dc296` | `tools/images/brasty/` scraper scaffold behind an investigation gate |
| `3372207` | Small-order cart fee in the PHP bridge |
| `bcfc783` | wholesale-perfumes.eu as a third supplier, seeded inactive |
| `725667f` | Per-vendor dashboard editor, fee label setting, live caps moved onto the vendor row |
| `ca23d88` | This handoff spec (`docs/specs/S3-remaining-work.md`) |
| `465c980` | Headless Brasty login (`BRASTY_EMAIL` / `BRASTY_PASSWORD` → `storageState.json`) |
| `568eb38` | Renamed the wholesaler `ocean` → `wholesale-perfumes`, SKU prefix `OC` → `WPF` |

The branch history is **linear**: it sits on top of `cursor/ocean-image-overrides`, which sits on top
of `cursor/bf-image-pipeline-theme`, which sits on `main`. Merging `cursor/client-features-stage3`
into `main` therefore brings all three branches at once. Do not merge the older two separately.

Green as of `465c980`: `bun test` 65 passing, `bun run typecheck` clean, `php -l` clean.

### Deliberately inert

Nothing in Stage 3 changes customer-visible behaviour until someone turns it on. Preserve that
property — if a task below would silently alter live prices or visibility, stop and say so.

| Feature | State | Turned on by |
|---|---|---|
| Markup tiers | Seeded `[]`, meaning the old single multiplier still applies | Entering bands, then `--rewrite-all` |
| Hide products without image | **Default ON** — this one does bite on the next full sync | Already on; measure before deploying |
| Small-order cart fee | `cart_min_enabled = 0` | Dashboard toggle |
| wholesale-perfumes supplier | Seeded **inactive**, with guessed values | Vendors page, after confirming the guesses |
| Brasty images | Extraction strategy refuses to run | Task 1 below |

---

## 2. Rules that apply to every task

1. Never read or write `production-environment/ecom_sites/data/wp/` or `data/wp-db/`, except the
   `sillage-bridge` plugin directory. They hold WordPress core and raw MariaDB files.
2. Never commit a credential. Real secrets live in gitignored `.env` files; only `.env.example`
   placeholders are tracked.
3. Bun writes products via raw SQL; PHP never does. The plugin's job list in `CONTEXT.md` §5 is
   closed at eight items. Adding a ninth needs a `DECISIONS.md` entry, not a quiet commit.
4. Placing a vendor order spends real money. There is no sandbox on any vendor API. Respect
   `orders_dry_run` and the dispatch rails.
5. EANs are strings. Leading zeros are significant on thousands of rows. Never cast one to a number.
6. TypeScript strict, no ORM, parameterized SQL through `mysql2/promise`, every statement fully
   qualifying its database. Pure logic lives in files with no database import.
7. Migrations are sequential and idempotent. The highest is `014`; take the next free number.
8. Do not run git commands unless the operator explicitly asks. Leave work in the tree for review.

### Verification, run before reporting any task done

```bash
cd production-environment/sillage-core
bun run typecheck          # must be clean
bun test                   # 65 passing at the time of writing; never fewer
```

For PHP: `php -l` on each modified file. For the scraper: `npm run typecheck` in
`tools/images/brasty`.

---

## 3. Task 1 — finish the Brasty image scraper

See also [S3-images.md](S3-images.md) §3 for the Brasty rules and tool layout.

**Why it matters.** The client's loudest complaint is products showing a placeholder instead of a
photo, and he will not sell them. Brasty is *only* a photo source — not a supplier. There is no
Brasty catalogue sync, no order API and no shipping rules to build. Photos are matched to products
by EAN alone, so an image scraped from Brasty can illustrate a BeautyFort or wholesale-perfumes.eu
product; the override map is vendor-agnostic by design.

**Prerequisite the agent cannot satisfy.** `BRASTY_EMAIL` and `BRASTY_PASSWORD` must exist in the
gitignored `tools/images/brasty/.env`. Email is often the same as the wholesale-perfumes shop login; the password
is the Brasty wholesale portal password (not the wholesale-perfumes API token). If either is absent, stop and
say so rather than proceeding.

### 1a. Run the investigation

The site has no product detail pages; products exist only in a searchable listing, and the large
preview is triggered from the row. **How that preview loads is genuinely unknown**, and the tool is
deliberately built to refuse guessing: `imageExtractor.ts` ships a `pending-investigation` strategy
that throws even when it can see plausible candidate URLs.

Read `tools/images/brasty/README.md` for the exact script names, then run the login followed by the
investigation. One verified obstacle: a cookie-consent overlay intercepts clicks — clicking the
header "Log in" link while the banner is up does nothing at all. The login flow is supposed to
dismiss it; if the investigation reports zero candidates, suspect the banner before suspecting the
selectors.

The investigation answers seven questions with evidence: whether the large image is already in the
DOM, in a `data-*` attribute, injected on hover, a CSS background, fetched over the network after
hover, served by a JSON endpoint, or derivable from the thumbnail URL by a predictable rewrite. It
writes a markdown report and a JSON file under `tools/images/brasty/findings/`.

### 1b. Implement the real extraction strategy

Read the findings, then implement one concrete `ExtractionStrategy` in `imageExtractor.ts` and
register it with `setExtractionStrategy(...)`. Constraints from the original requirements, all of
which still hold: always download the original largest file, never a screenshot, never a crop; if
the URL is already in the HTML, extract it directly; if it only appears on the network, capture the
request. Verify the matched row's EAN equals the searched EAN before saving anything.

Then trial-run against a slice of ten to twenty rows of the Brasty CSV and inspect the output before
scaling up. Do not launch a full run on first success.

### 1c. Publish the images

Files land as `EAN.jpg`. Three steps turn them into storefront images:

1. The watermark pass composites the client's logo, which is already committed at
   `tools/images/brasty/assets/lps-logo.png`. Originals are never overwritten.
2. The images need a public URL, because this store never creates WordPress attachments — every
   product image is an external URL rendered by a plugin filter. Host directory
   `production-environment/ecom_sites/data/media/` is bind-mounted read-only into the dedicated
   `lps-media` nginx container (not a named volume; not under `data/wp/`). Edge proxy keeps the
   public path at `/lps-media/` (`shop-gateway` locally, host Caddy on VPS → port 105). Set
   `LPS_MEDIA_BASE_URL` in `tools/images/brasty/.env` to `https://images.prinscosmetic.eu` (or
   `http://localhost/lps-media` locally).
3. The merge script writes an EAN → URL map into `production-environment/sillage-core/data/image_overrides.json`,
   merging rather than overwriting, because the Python enricher already owns thousands of keys there
   for BeautyFort and wholesale-perfumes. It backs the file up first.

Afterwards the shop needs a sync before anything changes on screen — see Task 2's note about
`--rewrite-all`.

**Scale note.** The catalogue is roughly 14,000 products and the CSV may grow past 100,000 rows. The
downloader is resumable through an append-only manifest keyed by EAN and defaults to a concurrency
of one with a politeness delay. Do not raise that default to make a demo faster; a blocked account
costs more than a slow crawl. The bulk run belongs on the VPS, not a laptop.

---

## 4. Task 2 — deploy Stage 3

Target is the `cosmetic2` / `sillage2` shop on the OVH VPS. `production-environment/scripts/deploy-vps.sh`
and `ecom_sites/bootstrap-sillage.sh` already encode the mechanics; read them rather than inventing
commands.

Order matters:

1. **Merge.** One merge of `cursor/client-features-stage3` into `main` brings all Stage 3 work.
2. **Migrate.** `bun run migrate` applies `010` through `014`. All are idempotent.
3. **Re-run the grants step.** This is the easiest thing to forget and it fails loudly at runtime:
   the plugin now reads `sillage.sil_settings` and `sillage.sil_vendors` in addition to
   `sil_ean_index`, and those `GRANT`s are applied *after* migrate because table-level grants need
   the tables to exist. Both deploy scripts were updated; make sure the one you use actually ran.
4. **Update the plugin.** `class-sillage-cart-fee.php` is new.
5. **Measure before you sync.** `hide_products_without_image` defaults on, so the first full sync
   will pull every still-imageless product out of the catalogue and search. Find out how many that
   is before the client notices — the sync summary reports `hiddenNoImage`. If the number is
   alarming, do Task 1 first, or turn the setting off until the photos exist.
6. **Sync.** `bun run sync -- --rewrite-all`. The rewrite is mandatory, not optional: sync hashes
   cover vendor data only, so storefront labels, markup tiers and image rules are invisible to the
   change detector and will not otherwise be applied.
7. **Verify.** Categories read LPS01 / LPS02, prices reflect whatever tiers were entered, no
   product in the catalogue shows a placeholder, and the dashboard's vendor editor saves.

---

## 5. Task 3 — turn features on, with the operator's numbers

None of these are engineering decisions. Get the values from the operator; do not invent them.

- **Markup tiers.** The client said "up to €80 × 1.7, above €80 × 1.5" but also "it varies a lot",
  which is why the tiers are editable data seeded empty. Entering them changes every price, so it
  needs `--rewrite-all` and a deliberate decision, not a drive-by edit.
- **Small-order fee / MOQ.** Global `cart_min_*` fee remains opt-in (defaults off). Per-vendor
  `min_order_value_eur` hard-blocks cart/checkout with a storefront-label shortfall — wired so
  customers see it before dispatch. wholesale-perfumes seed is still €100 until the operator
  confirms the real figure.
- **wholesale-perfumes sell path.** **Parked** for a separate B2B site (`b2b-wholesale/`). Not
  sold on this retail shop. Cart `code` = catalog product `id` confirmed
  (`b2b-wholesale/docs/wholesale-perfumes-api.md`). Confirm MOQ / countries / VAT before any
  future B2B live spend; keep `orders_dry_run=1` on this stack.

---

## 6. Known hazards and open assumptions

Read these before touching the related code; each one cost real time to establish.

- **wholesale-perfumes cart is account-global mutable state.** Two concurrent dispatches would merge into one
  wrong order. The empty → insert → verify → submit sequence runs under a `GET_LOCK` advisory lock,
  and dry-run performs no remote mutation at all — not even emptying the cart. Preserve both
  properties.
- **No vendor offers an idempotency key** except BeautyFort. A crash mid-submit leaves the order in
  `needs_attention` and must never auto-retry.
- **Fast sync only refreshes an image when the product is written anyway** — for a price, stock or
  visibility change. A product whose photo merely improves from one valid URL to a better one waits
  for the nightly full sync. This is a known limitation, not a bug; flipping in or out of the hidden
  state does change the price hash, so newly-found images for hidden products land promptly.
- **A per-vendor price multiplier disables tiered pricing for that vendor**, by design: the
  precedence is vendor override, then tiers, then the global multiplier. The Vendors page says so;
  keep it saying so.
- **Global cart fee fails open; vendor MOQ fails open only if vendors cannot be read.** An
  unreachable settings row or a message template without `{remaining}` must never block a sale via
  the fee path. Per-vendor MOQ intentionally blocks checkout when `min_order_value_eur` is set and
  readable — that is the wholesaler floor, not the optional Foodpanda fee.
- **Never change `sku_prefix`, vendor slugs, or the product slug formula.** They are baked into
  roughly 52,000 SKUs and into existing order history. Storefront naming is a separate
  `storefront_label` column precisely so renaming is safe.

---

## 7. Explicitly out of scope

- Brasty as a supplier — catalogue, orders and the 26 kg-per-box shipping table. The operator
  dropped it; Brasty is a photo source only. The rate table survives in the vendor notes as
  reference material.
- Matching Google's consumer prices. Not implementable as stated without price scraping; the markup
  tiers are the agreed approximation.
- B2B on this WordPress. **Decided:** separate future site (`b2b-wholesale/`); this shop is
  BF/BTS retail only.
