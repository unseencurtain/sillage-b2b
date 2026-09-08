#!/usr/bin/env python3
"""Build the photo-pack lists from a live inventory dump + the wholesale export CSV.

Does not write the shop. Does not download bytes — see download_remote.py and rsync.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "ean-image-scrape"))

from barcodes import is_real_barcode, lookup_variants, normalize_ean  # noqa: E402
from image_rules import is_unusable_image, source_kind  # noqa: E402

IMAGE_EXT = {".jpg", ".jpeg", ".webp", ".png", ".gif"}


def ean_from_filename(name: str) -> str | None:
    stem = Path(name).stem
    return normalize_ean(stem)


def index_files(path: Path, *, rel_prefix: str = "") -> dict[str, str]:
    """normalized EAN → relative filename (first wins)."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        fn = os.path.basename(line)
        ean = ean_from_filename(fn)
        if not ean:
            continue
        out.setdefault(ean, f"{rel_prefix}{line}" if rel_prefix else line)
    return out


def load_overrides(path: Path) -> dict[str, str]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, str] = {}
    if not isinstance(raw, dict):
        return out
    for k, v in raw.items():
        url = v if isinstance(v, str) else (v.get("url") if isinstance(v, dict) else "")
        ean = normalize_ean(str(k))
        if not ean or not url or is_unusable_image(url):
            continue
        out.setdefault(ean, url.strip())
    return out


def parse_export(path: Path) -> list[dict[str, str]]:
    text = path.read_text(encoding="utf-8-sig")
    rows = list(csv.DictReader(text.splitlines(), delimiter=";"))
    out: list[dict[str, str]] = []
    for r in rows:
        ean = normalize_ean(r.get("EAN"))
        out.append(
            {
                "export_id": (r.get("id") or "").strip(),
                "brand": (r.get("BRAND") or "").strip(),
                "title": (r.get("TITLE") or "").strip(),
                "type": (r.get("TYPE") or "").strip(),
                "sex": (r.get("SEX") or "").strip(),
                "volume": (r.get("VOLUME") or "").strip(),
                "ean_raw": (r.get("EAN") or "").strip(),
                "ean": ean or "",
                "stock": (r.get("STOCK") or "").strip(),
                "price": (r.get("PRICE") or "").strip(),
                "tester": (r.get("TESTER") or "").strip(),
                "shade": (r.get("SHADE") or "").strip(),
            }
        )
    return out


def classify_shop_row(woo_thumb: str, vendor_image: str) -> tuple[str, str]:
    """Return (shop_status, displayed_kind)."""
    if not is_unusable_image(woo_thumb):
        return "has_shop_photo", source_kind(woo_thumb)
    if woo_thumb and woo_thumb.strip() and not is_unusable_image(woo_thumb):
        return "has_shop_photo", source_kind(woo_thumb)
    # Unusable Woo thumb — vendor URL may still exist but shop hides it.
    if vendor_image and not is_unusable_image(vendor_image):
        return "hidden_unusable_thumb", source_kind(vendor_image)
    return "missing", "none"


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--inventory", default="/workspace/tmp-image-inventory")
    ap.add_argument("--export-csv", default="")
    ap.add_argument("--out", default="/workspace/photo-pack")
    ap.add_argument("--snapshot", default=str(HERE / "snapshot"))
    args = ap.parse_args()

    inv = Path(args.inventory)
    out = Path(args.out)
    snap = Path(args.snapshot)
    lists = out / "lists"
    lists.mkdir(parents=True, exist_ok=True)
    snap.mkdir(parents=True, exist_ok=True)
    (out / "maps").mkdir(parents=True, exist_ok=True)

    export_path = Path(args.export_csv) if args.export_csv else None
    if not export_path:
        for cand in [
            Path("/home/ubuntu/.cursor/projects/workspace/uploads/export_0e0e.csv"),
            inv / "export.csv",
        ]:
            if cand.exists():
                export_path = cand
                break
    if not export_path or not export_path.exists():
        raise SystemExit("export.csv not found")

    overrides = load_overrides(inv / "image_overrides.json")
    cdn = index_files(inv / "cdn-files.txt")
    scraped = index_files(inv / "scraped-files.txt")
    brasty = index_files(inv / "brasty-files.txt")
    export_rows = parse_export(export_path)
    export_eans = {r["ean"] for r in export_rows if r["ean"]}

    # Extra EANs from the missing-products export (lookup_ean + extras).
    extra_by_sku: dict[str, list[str]] = {}
    missing_csv = inv / "missing-products.csv"
    if missing_csv.exists():
        with missing_csv.open(encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                sku = (row.get("sku") or "").strip()
                codes: list[str] = []
                for raw in [
                    row.get("primary_ean"),
                    row.get("lookup_ean"),
                    *(row.get("extra_eans") or "").split(";"),
                ]:
                    n = normalize_ean(raw)
                    if n and n not in codes:
                        codes.append(n)
                extra_by_sku[sku] = codes

    shop_rows: list[dict[str, str]] = []
    shop_missing: list[dict[str, str]] = []
    all_images: dict[str, dict[str, str]] = {}  # key = ean or url

    def note_image(
        *,
        ean: str,
        url: str,
        origin: str,
        local_path: str = "",
        sku: str = "",
        brand: str = "",
        name: str = "",
    ) -> None:
        if not url and not local_path:
            return
        key = ean or url
        prev = all_images.get(key)
        row = {
            "ean": ean,
            "url": url,
            "origin": origin,
            "kind": source_kind(url) if url else ("local_file" if local_path else "none"),
            "local_path": local_path,
            "example_sku": sku,
            "brand": brand,
            "name": name,
        }
        if not prev:
            all_images[key] = row
            return
        # Prefer our CDN / a local file over a hotlink for the same EAN.
        rank = {
            "cdn_file": 0,
            "scraped_file": 1,
            "brasty_file": 2,
            "override": 3,
            "shop_thumb": 4,
            "vendor_feed": 5,
        }
        if rank.get(origin, 9) < rank.get(prev["origin"], 9):
            all_images[key] = row

    for ean, fn in cdn.items():
        note_image(ean=ean, url=f"https://images.prinscosmetic.eu/{Path(fn).name}", origin="cdn_file", local_path=f"files/cdn/{Path(fn).name}")
    for ean, fn in scraped.items():
        note_image(ean=ean, url="", origin="scraped_file", local_path=f"files/scraped/{Path(fn).name}")
    for ean, fn in brasty.items():
        note_image(ean=ean, url="", origin="brasty_file", local_path=f"files/brasty/{fn}")
    for ean, url in overrides.items():
        local = ""
        if ean in cdn:
            local = f"files/cdn/{Path(cdn[ean]).name}"
        note_image(ean=ean, url=url, origin="override", local_path=local)

    vendor_counts = Counter()
    status_counts = Counter()
    kind_counts = Counter()

    with (inv / "all-products.tsv").open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 9:
                continue
            sku, ean_raw, brand, name, vendor, woo, vendor_img, identity, wp_id = parts[:9]
            vendor_counts[vendor] += 1
            eans = extra_by_sku.get(sku, [])
            n = normalize_ean(ean_raw)
            if n and n not in eans:
                eans = [n, *[e for e in eans if e != n]]
            lookup = next((e for e in eans if is_real_barcode(e)), eans[0] if eans else "")
            status, kind = classify_shop_row(woo, vendor_img)
            status_counts[status] += 1
            kind_counts[kind] += 1

            have_cdn = any(e in cdn for e in eans)
            have_scraped = any(e in scraped for e in eans)
            have_brasty = any(e in brasty for e in eans)
            have_override = any(e in overrides for e in eans)
            in_export = any(e in export_eans for e in eans)
            override_url = next((overrides[e] for e in eans if e in overrides), "")
            fill_origin = ""
            if have_override and not is_unusable_image(override_url):
                fill_origin = "override"
            elif have_cdn:
                fill_origin = "cdn_file"
            elif have_scraped:
                fill_origin = "scraped_unapplied"
            elif have_brasty:
                fill_origin = "brasty_unapplied"
            elif in_export:
                fill_origin = "export_ean_only_no_url"

            still_missing = status != "has_shop_photo" and fill_origin in {"", "export_ean_only_no_url", "scraped_unapplied", "brasty_unapplied"}
            # "still missing on shop" is status != has_shop_photo
            # "no bytes anywhere" is none of override/cdn/scraped/brasty
            no_bytes = not (have_override or have_cdn or have_scraped or have_brasty)

            row = {
                "sku": sku,
                "wp_post_id": wp_id,
                "vendor": vendor,
                "brand": brand,
                "name": name,
                "identity_key": identity,
                "primary_ean": ean_raw,
                "lookup_ean": lookup,
                "all_eans": ";".join(eans),
                "shop_status": status,
                "woo_thumb": woo,
                "woo_kind": source_kind(woo) if woo else "none",
                "vendor_image": vendor_img,
                "in_wholesale_export": "1" if in_export else "0",
                "has_override": "1" if have_override else "0",
                "has_cdn_file": "1" if have_cdn else "0",
                "has_scraped_file": "1" if have_scraped else "0",
                "has_brasty_file": "1" if have_brasty else "0",
                "fill_origin": fill_origin,
                "override_url": override_url,
                "no_image_bytes_anywhere": "1" if (status != "has_shop_photo" and no_bytes) else "0",
            }
            shop_rows.append(row)
            if status != "has_shop_photo":
                shop_missing.append(row)

            if woo and not is_unusable_image(woo):
                note_image(ean=lookup, url=woo, origin="shop_thumb", sku=sku, brand=brand, name=name)
            elif vendor_img and not is_unusable_image(vendor_img):
                note_image(ean=lookup, url=vendor_img, origin="vendor_feed", sku=sku, brand=brand, name=name)

    # Wholesale export coverage
    export_out: list[dict[str, str]] = []
    export_stats = Counter()
    for r in export_rows:
        ean = r["ean"]
        if not ean:
            export_stats["no_ean"] += 1
            coverage = "no_ean"
        elif ean in cdn:
            coverage = "our_cdn_file"
            export_stats["our_cdn_file"] += 1
        elif ean in overrides:
            coverage = "override_url"
            export_stats["override_url"] += 1
        elif ean in scraped:
            coverage = "scraped_unapplied"
            export_stats["scraped_unapplied"] += 1
        elif ean in brasty:
            coverage = "brasty_dump"
            export_stats["brasty_dump"] += 1
        else:
            coverage = "no_image_anywhere"
            export_stats["no_image_anywhere"] += 1
        url = overrides.get(ean, "")
        if ean in cdn:
            url = f"https://images.prinscosmetic.eu/{Path(cdn[ean]).name}"
        export_out.append(
            {
                **r,
                "coverage": coverage,
                "image_url": url,
                "cdn_file": Path(cdn[ean]).name if ean in cdn else "",
                "scraped_file": Path(scraped[ean]).name if ean in scraped else "",
                "brasty_file": brasty.get(ean, ""),
            }
        )

    missing_on_shop = [r for r in shop_rows if r["shop_status"] != "has_shop_photo"]
    missing_no_bytes = [r for r in missing_on_shop if r["no_image_bytes_anywhere"] == "1"]
    missing_but_have_bytes = [r for r in missing_on_shop if r["no_image_bytes_anywhere"] == "0"]
    missing_in_export = [r for r in missing_on_shop if r["in_wholesale_export"] == "1"]
    missing_in_export_no_bytes = [r for r in missing_in_export if r["no_image_bytes_anywhere"] == "1"]

    third_party: list[dict[str, str]] = []
    host_counts = Counter()
    seen_urls: set[str] = set()
    for ean, url in overrides.items():
        kind = source_kind(url)
        if kind in {"our_cdn", "unusable"}:
            continue
        if url in seen_urls:
            continue
        seen_urls.add(url)
        host = urlparse(url).netloc
        host_counts[host] += 1
        ext = Path(urlparse(url).path).suffix.lower() or ".jpg"
        if ext not in IMAGE_EXT:
            ext = ".jpg"
        third_party.append(
            {
                "ean": ean,
                "url": url,
                "host": host,
                "kind": kind,
                "suggested_file": f"files/remote/{host}/{ean}{ext}",
                "already_on_cdn": "1" if ean in cdn else "0",
            }
        )

    shop_fields = list(shop_rows[0].keys()) if shop_rows else ["sku"]
    write_csv(lists / "shop-products.csv", shop_fields, shop_rows)
    write_csv(lists / "shop-missing.csv", shop_fields, missing_on_shop)
    write_csv(lists / "shop-missing-no-bytes.csv", shop_fields, missing_no_bytes)
    write_csv(
        lists / "shop-missing-but-we-have-a-file.csv",
        shop_fields,
        missing_but_have_bytes,
    )
    export_fields = list(export_out[0].keys()) if export_out else ["ean"]
    write_csv(lists / "wholesale-export-coverage.csv", export_fields, export_out)
    write_csv(
        lists / "third-party-urls.csv",
        ["ean", "url", "host", "kind", "suggested_file", "already_on_cdn"],
        third_party,
    )

    image_rows = sorted(all_images.values(), key=lambda r: (r["origin"], r["ean"], r["url"]))
    write_csv(
        lists / "all-images.csv",
        ["ean", "origin", "kind", "url", "local_path", "example_sku", "brand", "name"],
        image_rows,
    )

    captured = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    state = {
        "captured_at": captured,
        "live_host": "ovhe (ovh-experi / 139.99.61.71)",
        "shop": "https://prinscosmetic.eu",
        "images_cdn": "https://images.prinscosmetic.eu",
        "do_not_apply_scraped_to_shop": True,
        "hide_without_image": "on",
        "counts": {
            "shop_products": len(shop_rows),
            "shop_with_usable_photo": status_counts["has_shop_photo"],
            "shop_missing_usable_photo": len(missing_on_shop),
            "shop_missing_sql_empty_or_non_http": int((inv / "missing-count.txt").read_text().strip() or "0"),
            "shop_missing_but_we_already_have_bytes": len(missing_but_have_bytes),
            "shop_missing_no_bytes_anywhere": len(missing_no_bytes),
            "shop_missing_also_in_wholesale_export": len(missing_in_export),
            "shop_missing_in_export_and_no_bytes": len(missing_in_export_no_bytes),
            "by_shop_status": dict(status_counts),
            "by_vendor": dict(vendor_counts),
            "cdn_files": len(cdn),
            "scraped_files_unapplied": len(scraped),
            "brasty_dump_files": len(brasty),
            "override_keys_usable": len(overrides),
            "third_party_hotlink_urls": len(third_party),
            "third_party_by_host": dict(host_counts),
            "unique_image_index_rows": len(image_rows),
            "wholesale_export_rows": len(export_rows),
            "wholesale_export_unique_eans": len(export_eans),
            "wholesale_export_coverage": dict(export_stats),
        },
        "wholesale_export": {
            "file": str(export_path),
            "has_image_url_column": False,
            "note": (
                "Semicolon CSV (id, brand, title, type, sex, volume, stock, price, EAN, …). "
                "No http(s) image URLs. Used as an EAN catalogue to match against our photos."
            ),
        },
        "what_still_missing_means": {
            "on_the_live_shop": len(missing_on_shop),
            "after_counting_files_we_already_have_but_have_not_applied": len(missing_no_bytes),
            "explanation": (
                "Live shop hides products whose Woo thumb is empty, not http(s), a placeholder, "
                "or a BeautyFort /pic/ thumb. Scraped/ and Brasty files are NOT on the shop until "
                "someone inspects them and runs apply with --apply-to-shop. Do not apply yet."
            ),
        },
        "restore_on_new_vps": [
            "Copy files/cdn/ → ~/ecom_sites/data/media/",
            "Copy maps/image_overrides.json → ~/sillage/sillage-core/data/image_overrides.json",
            "Optional: copy files/brasty/ → ~/brasty/ for future matching",
            "Optional: files/scraped/ is unreviewed — do not copy onto the CDN until inspected",
            "Recreate sillage-core / sillage-cron, then: docker exec sillage-core bun run sync -- --mode=full --source=cache --rewrite-only",
        ],
    }

    (lists / "STATE.json").write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    (out / "STATE.json").write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    (snap / "STATE.json").write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

    # Compact snapshot for git (not the 54k shop dump).
    write_csv(snap / "shop-missing-no-bytes.csv", shop_fields, missing_no_bytes)
    write_csv(
        snap / "wholesale-export-coverage.csv",
        export_fields,
        export_out,
    )
    write_csv(
        snap / "third-party-urls.csv",
        ["ean", "url", "host", "kind", "suggested_file", "already_on_cdn"],
        third_party,
    )
    write_csv(
        snap / "shop-missing-but-we-have-a-file.csv",
        shop_fields,
        missing_but_have_bytes,
    )

    # Human summary
    summary = f"""# Photo pack — snapshot {captured}

Live shop `{state['shop']}` · CDN `{state['images_cdn']}` · host `{state['live_host']}`

## How many photos are still missing?

| What | Count |
|---|---|
| WooCommerce products | {len(shop_rows):,} |
| **On the shop with a usable photo** | **{status_counts['has_shop_photo']:,}** |
| **On the shop with no usable photo** (hidden while hide-without-image is on) | **{len(missing_on_shop):,}** |
| Of those, we already have bytes or a real URL (CDN / override / scrape / Brasty) — **not applied** | {len(missing_but_have_bytes):,} |
| **Truly no photo anywhere** (no CDN file, no override URL, no scrape file, no Brasty dump file) | **{len(missing_no_bytes):,}** |
| Shop-missing EANs that also appear in the wholesale export.csv | {len(missing_in_export):,} |
| …and still no bytes anywhere | {len(missing_in_export_no_bytes):,} |

The wholesale file has **{len(export_rows):,}** rows and **{len(export_eans):,}** barcodes. It has **no image URL column**. Matching it does not add photos by itself; it only tells us which missing shop EANs exist in that catalogue.

### Wholesale export.csv coverage (by EAN)

| Coverage | Rows |
|---|---|
| Already on our CDN | {export_stats['our_cdn_file']:,} |
| Override URL (Shopify / BTS / ocean / …) | {export_stats['override_url']:,} |
| Unreviewed EAN scrape (`scraped/`) | {export_stats['scraped_unapplied']:,} |
| In the Brasty dump on the VPS | {export_stats['brasty_dump']:,} |
| **No image anywhere** | **{export_stats['no_image_anywhere']:,}** |
| No usable EAN | {export_stats['no_ean']:,} |

## What we already have (bytes + URLs)

| Source | Count | In this pack |
|---|---|---|
| Live CDN `~/ecom_sites/data/media/` | {len(cdn):,} | `files/cdn/` |
| EAN scrape, **not** on the shop | {len(scraped):,} | `files/scraped/` |
| Brasty dump (EAN.jpg, skip camera placeholders when restoring) | {len(brasty):,} | `files/brasty/` |
| `image_overrides.json` usable keys | {len(overrides):,} | `maps/image_overrides.json` |
| Third-party hotlinks to download | {len(third_party):,} | `files/remote/` + `lists/third-party-urls.csv` |

Third-party hosts: {dict(host_counts)}

## Do not

- Do not copy `files/scraped/` onto the live CDN until a human has inspected the JPEGs.
- Do not turn hide-without-image off to “fix” the missing count.
- Do not serve this pack with `python3 -m http.server` on `0.0.0.0`. Use `scripts/start-serve.sh` (localhost) and `scripts/stop-serve.sh`.
"""
    (lists / "MISSING.md").write_text(summary, encoding="utf-8")
    (out / "README.md").write_text(summary, encoding="utf-8")
    (snap / "MISSING.md").write_text(summary, encoding="utf-8")

    print(json.dumps(state["counts"], indent=2))
    print(f"wrote {lists}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
