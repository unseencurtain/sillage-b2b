#!/usr/bin/env python3
"""Find shop photos using EAN plus name/brand.

Every row must have an EAN. We try, in order:

  1. Open Beauty / Products / Food Facts by EAN
  2. Go-UPC by EAN
  3. Open Facts *search* by brand + name — keep only if the result EAN matches
  4. Bing Images: "EAN brand name", then "EAN brand", then EAN

A file is always saved as {ean}.jpg. We never scrape a product with no EAN.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from barcodes import codes_match, lookup_variants, normalize_ean  # noqa: E402

UA = (
    "SillageEanImageScrape/1.1 "
    "(+https://github.com/unseencurtain/Sillage; EAN+name shop photos)"
)
MIN_BYTES = 3500
BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
OFF_HOSTS = (
    "world.openbeautyfacts.org",
    "world.openproductsfacts.org",
    "world.openfoodfacts.org",
)

SKIP_OPEN_FACTS = False
_off_lock = Lock()
_off_timeouts = 0
_off_dead = False


def open_facts_ok() -> bool:
    if SKIP_OPEN_FACTS:
        return False
    return not _off_dead


def note_open_facts_timeout() -> None:
    global _off_timeouts, _off_dead
    with _off_lock:
        _off_timeouts += 1
        if _off_timeouts >= 4 and not _off_dead:
            _off_dead = True
            print("open-facts: giving up for this run (4 timeouts)", flush=True)


SKIP_URL = re.compile(
    r"(favicon|sprite|logo[-_]?only|1x1|pixel\.|placeholder|no[_-]?image|"
    r"woocommerce-placeholder|/th\?id=OIP)",
    re.I,
)


# urllib timeout does not reliably kill a stalled TLS handshake (Open Facts).
# curl --max-time does, so a dead host cannot freeze every worker.
def http_get(url: str, ua: str = UA, timeout: int = 8) -> tuple[int, bytes, str]:
    try:
        proc = subprocess.run(
            [
                "curl",
                "-sS",
                "-L",
                "--globoff",
                "--max-time",
                str(timeout),
                "--connect-timeout",
                "4",
                "--max-filesize",
                "2000000",
                "-A",
                ua,
                "-H",
                "Accept-Language: en-US,en;q=0.8",
                "-w",
                "\n__CURL__%{http_code}\t%{content_type}",
                url,
            ],
            capture_output=True,
            timeout=timeout + 5,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return 0, b"", ""
    raw = proc.stdout
    marker = b"\n__CURL__"
    idx = raw.rfind(marker)
    if idx == -1:
        return 0, raw, ""
    body = raw[:idx]
    meta = raw[idx + len(marker) :].decode("utf-8", "replace").strip()
    code_s, _, ctype = meta.partition("\t")
    try:
        code = int(code_s)
    except ValueError:
        code = 0
    return code, body, ctype


def json_get(url: str, ua: str = UA) -> tuple[int, dict | None]:
    status, body, ctype = http_get(url, ua=ua)
    if status != 200:
        return status, None
    if "json" not in (ctype or "") and not body[:1] in (b"{", b"["):
        return status, None
    try:
        return status, json.loads(body.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        return status, None


def pick_off_image(product: dict) -> str | None:
    for key in ("image_front_url", "image_url"):
        val = product.get(key)
        if isinstance(val, str) and val.startswith("http"):
            return val
    selected = product.get("selected_images") or {}
    front = (selected.get("front") or {}).get("display") or {}
    if isinstance(front, dict):
        for val in front.values():
            if isinstance(val, str) and val.startswith("http"):
                return val
    return None


def primary_codes(ean: str) -> list[str]:
    variants = lookup_variants(ean)
    if not variants:
        return []
    padded = next((v for v in variants if len(v) == 13), variants[0].zfill(13))
    out: list[str] = []
    for code in (padded, variants[0]):
        if code not in out:
            out.append(code)
    return out


def short_name(name: str) -> str:
    text = re.sub(r"\s+", " ", name or "").strip()
    text = re.sub(r"\b\d+([.,]\d+)?\s?(ml|g|oz|pcs?|st|er)\b", " ", text, flags=re.I)
    words = [w for w in text.split() if w]
    return " ".join(words[:8])


def lookup_open_facts_ean(ean: str) -> dict | None:
    if not open_facts_ok():
        return None
    # Beauty first (this shop). Other Open Facts hosts only if beauty misses.
    for host in OFF_HOSTS:
        code = primary_codes(ean)[0] if primary_codes(ean) else ean
        status, data = json_get(f"https://{host}/api/v0/product/{code}.json")
        if status == 0:
            note_open_facts_timeout()
            if not open_facts_ok():
                return None
        if status != 200 or not data or data.get("status") != 1:
            continue
        product = data.get("product") or {}
        found_code = str(data.get("code") or product.get("code") or "")
        if not codes_match(found_code, ean):
            continue
        img = pick_off_image(product)
        if not img:
            continue
        return {
            "source": host,
            "image_url": img,
            "found_code": found_code,
            "found_name": (product.get("product_name") or "")[:200],
        }
    return None


def lookup_open_facts_search(ean: str, brand: str, name: str) -> dict | None:
    if not open_facts_ok():
        return None
    terms = " ".join(p for p in (brand, short_name(name)) if p).strip()
    if len(terms) < 4:
        return None
    q = urllib.parse.quote(terms)
    for host in ("world.openbeautyfacts.org", "world.openproductsfacts.org"):
        url = (
            f"https://{host}/cgi/search.pl?search_terms={q}"
            f"&search_simple=1&action=process&json=1&page_size=8"
        )
        status, data = json_get(url)
        if status == 0:
            note_open_facts_timeout()
            if not open_facts_ok():
                return None
        if status != 200 or not data:
            continue
        for product in data.get("products") or []:
            found_code = str(product.get("code") or "")
            if not codes_match(found_code, ean):
                continue
            img = pick_off_image(product)
            if not img:
                continue
            return {
                "source": f"{host}/search",
                "image_url": img,
                "found_code": found_code,
                "found_name": (product.get("product_name") or "")[:200],
            }
    return None


def lookup_goupc(ean: str) -> dict | None:
    for code in primary_codes(ean):
        status, body, _ = http_get(f"https://go-upc.com/search?q={code}", ua=BROWSER_UA)
        if status != 200:
            continue
        html = body.decode("utf-8", "replace")
        if re.search(r"product not found|no product|invalid value", html, re.I):
            continue
        title = re.search(r"<title>([^<]+)", html, re.I)
        title_text = title.group(1) if title else ""
        page_codes = re.findall(r"\b(\d{8,14})\b", title_text + " " + html[:4000])
        if not any(codes_match(c, ean) for c in page_codes):
            continue
        images = re.findall(r"https://go-upc\.s3\.amazonaws\.com/images/[^\"'\s]+", html)
        images = [u for u in images if not u.lower().endswith((".png", ".ico", ".svg"))]
        if not images:
            continue
        return {
            "source": "go-upc.com",
            "image_url": images[0],
            "found_code": code,
            "found_name": title_text[:200],
        }
    return None


def bing_image_urls(query: str) -> list[str]:
    q = urllib.parse.quote(query)
    url = f"https://www.bing.com/images/search?q={q}&adlt=off&qft=+filterui:imagesize-medium"
    status, body, _ = http_get(url, ua=BROWSER_UA)
    if status != 200:
        return []
    html = body.decode("utf-8", "replace")
    found = re.findall(r"murl&quot;:&quot;(https?://[^&]+)&quot;", html)
    if not found:
        found = re.findall(r'"murl"\s*:\s*"(https?://[^"]+)"', html)
    out: list[str] = []
    for raw in found:
        img = raw.replace("\\u0026", "&").replace("\\/", "/")
        if SKIP_URL.search(img):
            continue
        if img not in out:
            out.append(img)
    return out[:8]


def search_queries(ean: str, brand: str, name: str) -> list[str]:
    code = primary_codes(ean)[0] if primary_codes(ean) else ean
    nm = short_name(name)
    brand = (brand or "").strip()
    queries: list[str] = []
    if brand and nm:
        queries.append(f"{code} {brand} {nm}")
    if brand:
        queries.append(f"{code} {brand}")
    if nm:
        queries.append(f"{code} {nm}")
    # de-dupe
    seen: set[str] = set()
    ordered: list[str] = []
    for q in queries:
        if q not in seen:
            seen.add(q)
            ordered.append(q)
    return ordered


def lookup_bing(ean: str, brand: str, name: str) -> dict | None:
    for query in search_queries(ean, brand, name):
        urls = bing_image_urls(query)
        # Prefer a URL that itself contains the EAN digits.
        codes = primary_codes(ean)
        ranked = [u for u in urls if any(c in u for c in codes)] + [
            u for u in urls if not any(c in u for c in codes)
        ]
        for img in ranked[:6]:
            blob = download_image(img)
            if not blob:
                continue
            return {
                "source": "bing:" + query[:80],
                "image_url": img,
                "found_code": ean,
                "found_name": query[:200],
                "_blob": blob,
            }
    return None


def download_image(url: str) -> bytes | None:
    status, body, ctype = http_get(url, ua=BROWSER_UA)
    if status != 200 or len(body) < MIN_BYTES:
        return None
    if "image" not in (ctype or "") and not body.startswith((b"\xff\xd8", b"\x89PNG", b"RIFF")):
        if not body.startswith((b"\xff\xd8", b"\x89PNG", b"RIFF")):
            return None
    return body


def dest_name(ean: str, url: str) -> str:
    norm = normalize_ean(ean) or "".join(ch for ch in ean if ch.isdigit())
    ext = Path(urlparse(url).path).suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
        ext = ".jpg"
    if ext == ".jpeg":
        ext = ".jpg"
    return f"{norm}{ext}"


def load_products(csv_path: Path) -> dict[str, dict[str, str]]:
    by_ean: dict[str, dict[str, str]] = {}
    with csv_path.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            ean = row.get("lookup_ean") or row.get("primary_ean") or ""
            norm = normalize_ean(ean)
            if not norm or norm in by_ean:
                continue
            by_ean[norm] = row
    return by_ean


def already_done(progress_path: Path, skip_miss: bool) -> set[str]:
    done: set[str] = set()
    if not progress_path.exists():
        return done
    with progress_path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            ean = normalize_ean(row.get("lookup_ean"))
            if not ean:
                continue
            status = row.get("status")
            if status == "found" or (skip_miss and status == "miss"):
                done.add(ean)
    return done


def append_progress(path: Path, lock: Lock, row: dict) -> None:
    with lock:
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def scrape_one(row: dict[str, str]) -> dict:
    ean = (row.get("lookup_ean") or row.get("primary_ean") or "").strip()
    brand = row.get("brand") or ""
    name = row.get("name") or ""
    # Fast exact EAN, then EAN+name (Bing), then the slower EAN databases.
    hit = (
        lookup_open_facts_ean(ean)
        or lookup_bing(ean, brand, name)
        or lookup_goupc(ean)
        or lookup_open_facts_search(ean, brand, name)
    )
    if not hit:
        return {"lookup_ean": ean, "status": "miss", "name": name, "brand": brand}
    blob = hit.pop("_blob", None) or download_image(hit["image_url"])
    if not blob:
        return {
            "lookup_ean": ean,
            "status": "miss",
            "reason": "download_failed",
            "source": hit.get("source"),
            "image_url": hit.get("image_url"),
        }
    filename = dest_name(ean, hit["image_url"])
    return {
        "lookup_ean": ean,
        "status": "found",
        "source": hit["source"],
        "image_url": hit["image_url"],
        "found_code": hit.get("found_code"),
        "found_name": hit.get("found_name"),
        "filename": filename,
        "bytes": len(blob),
        "_blob": blob,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--work-dir", default=os.path.expanduser("~/sillage/ean-image-scrape"))
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument(
        "--retry-miss",
        action="store_true",
        help="retry EANs previously marked miss (use after adding name tricks)",
    )
    ap.add_argument(
        "--skip-open-facts",
        action="store_true",
        help="do not call Open Facts (use when that API hangs the worker pool)",
    )
    args = ap.parse_args()

    work = Path(args.work_dir)
    csv_path = work / "missing-products.csv"
    scraped = work / "scraped"
    reports = work / "reports"
    scraped.mkdir(parents=True, exist_ok=True)
    reports.mkdir(parents=True, exist_ok=True)
    progress_path = reports / "progress.jsonl"

    global SKIP_OPEN_FACTS
    SKIP_OPEN_FACTS = args.skip_open_facts

    products = load_products(csv_path)
    # Resume: skip saved jpgs and jsonl hits. Skip previous misses unless
    # --retry-miss, so a restart does not re-walk dead Open Facts rows first.
    on_disk = {p.stem for p in scraped.iterdir() if p.is_file()}
    skip = already_done(progress_path, skip_miss=not args.retry_miss) | on_disk
    todo_rows = [row for norm, row in products.items() if norm not in skip]
    if args.limit:
        todo_rows = todo_rows[: args.limit]
    print(
        f"catalog={len(products)} skip={len(skip)} "
        f"todo={len(todo_rows)} workers={args.workers} retry_miss={args.retry_miss} "
        f"skip_open_facts={SKIP_OPEN_FACTS}",
        flush=True,
    )

    lock = Lock()
    found = 0
    miss = 0
    workers = max(1, min(args.workers, 8))

    def run(row: dict[str, str]) -> dict:
        time.sleep(0.08)
        return scrape_one(row)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(run, row): row for row in todo_rows}
        for i, fut in enumerate(as_completed(futs), 1):
            result = fut.result()
            blob = result.pop("_blob", None)
            if result.get("status") == "found" and blob and result.get("filename"):
                (scraped / result["filename"]).write_bytes(blob)
                found += 1
            else:
                miss += 1
            append_progress(progress_path, lock, result)
            if i % 25 == 0 or i == len(todo_rows):
                print(f"progress {i}/{len(todo_rows)} found={found} miss={miss}", flush=True)

    summary = {
        "todo": len(todo_rows),
        "found": found,
        "miss": miss,
        "scraped_dir": str(scraped),
    }
    (reports / "scrape-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
