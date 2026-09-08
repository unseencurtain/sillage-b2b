# Health (2026-08-30) — suggestions

Checked on live `ovhe` (`sillage-core:e706d10` at audit time) plus the BTS v2.1 order API.

## Working

- Shop, dashboard, CDN containers up. Hide-without-image **on**. Daily full rebuild **on**
  (23:00 `Asia/Dhaka`). Fast live sync succeeding (BTS Δ / BF full pages).
- Image overrides bind-mounted. Shop CDN is `~/ecom_sites/data/media/` only. Brasty dump
  removed 2026-09-03. Unreviewed EAN scrape is **not** on the shop.
- Orders dry-run **on**, auto-dispatch **off**. Cron still polls live rows every 15 minutes.
- BTS catalogue JWT v2.1 is correct; empty product lists as HTTP 404 `no products found`
  are treated as empty.

## Fixed in this change-set (deploy to see on the dashboard)

- Sync **Shop writes** column: `New n · Updated n · Prices n` (Vite build was broken by a
  stray `}` — syntax restored).
- BTS poll: `getTrackings` + `tracking: null` handling; **Cancelled** actually updates
  `sil_vendor_orders` (live `SIL-54253-BTS` / `179330441368` was Cancelled at BTS but stuck
  `submitted` in Sillage).
- Cross-vendor photos: extra EANs on an offer are indexed, not only `primary_ean`.
- GitHub restore: override map + CDN filename manifest + `restore_found_images.py` + migrate
  runbook. Binaries stay out of git on purpose (~380 MB).

## Edge (2026-08-31)

Shop Caddy **must** 403 AI training crawlers (`ClaudeBot` and the rest). Live
already has it. New VPS: `deploy-vps.sh` writes it. Manual paste:
[`CRAWLER-SHIELD.md`](CRAWLER-SHIELD.md).

---

## Do next (priority)

1. **Deploy this image** and poll vendor order id `3` so the cancelled BTS test row leaves
   `submitted`.
2. **Keep hide-without-image on.** ~12k leftovers still have EANs that are not in the 36k
   Brasty dump (plus 31 gift-set SKUs with no barcode). Continue scrape / manual photos.
   Victoria’s Secret `0197575132998` still needs a real shot.
3. **Fill BeautyFort company billing** in Settings before any live BF dispatch.
4. **rsync `~/ecom_sites/data/media/`** (or keep the old CDN up) before you wipe `ovhe` —
   git cannot rebuild those JPEGs alone.

## Improvements (optional)

| Item | Why | Risk |
|---|---|---|
| Live-gate cooldown should `skip`, not `error` the whole `sil_sync_runs` row | Run 22 is `error` only because BTS was fetched 0 min ago (`min 30`) | Low — connector/gate |
| Full rewrite of ~71 published products missing `product_brand` terms | Fast path never writes brand relationships | Medium I/O |
| Operator photo-finder UI for BF `/pic/` SKUs | Agents still run the Python matcher by hand | Product work |
| Raise BTS tracking poll toward 2–4h when live volume grows | Matches vendor advice; 15 min is fine at 1–2 rows | Config |
| Map vendor `cancelled` → WooCommerce `cancelled` (today we do not complete WC on cancel) | Test order will not auto-complete; a real cancel might leave WC `processing` | Product decision |
| Do not git-lfs 36k Brasty files | 3.7 GB dump; restore from VPS/Brasty instead | — |

## Known leftover orders (live DB)

| id | Vendor | Status | Notes |
|---|---|---|---|
| 1 | BF | failed (dry) | US outside serviceable countries — expected |
| 2, 4, 5 | BF | parked / approved / delivered | Poll stopped: vendor no longer returns those OrderReferences |
| 3 | BTS | submitted → should become **cancelled** after deploy | Portal Cancelled, no tracking |
| 6 | BF | approved (dry) | Never placed |

No rows in `sil_vendor_order_tracking` — none of the live numbers currently have a carrier
code, and the BTS row was never shipped.
