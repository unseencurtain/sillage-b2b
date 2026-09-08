#!/usr/bin/env python3
"""
Download and parse wholesale-perfumes.eu (SoleLuna) catalog XML.

Catalog is large and updates daily ~05:00 — download at most once per day.
Stock/price feed is separate and not needed for image enrichment.

Usage:
  python3 fetch_wholesale_perfumes.py              # download + parse, print stats
  python3 fetch_wholesale_perfumes.py --parse-only # use cached products/wholesale_perfumes_catalog.xml

Env (python-analysis/.env or process env):
  WHOLESALE_PERFUMES_USER, WHOLESALE_PERFUMES_TOKEN
  WHOLESALE_PERFUMES_CATALOG_URL (default LovelyXml/en catalog)
"""
from __future__ import annotations

import argparse
import os
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from base64 import b64encode
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PRODUCTS = ROOT / "products"
CACHE_XML = PRODUCTS / "wholesale_perfumes_catalog.xml"
DEFAULT_URL = "https://www.wholesale-perfumes.eu/xml/catalog/LovelyXml/en"

# Reuse enrich helpers when available
sys.path.insert(0, str(ROOT))
try:
    from enrich import is_placeholder_image, normalize_ean
except ImportError:  # pragma: no cover
    def normalize_ean(raw):
        if raw is None:
            return None
        cleaned = str(raw).strip().lstrip("'")
        if not cleaned or cleaned == "0000000000000" or not cleaned.isdigit():
            return None
        return cleaned.lstrip("0") or None

    def is_placeholder_image(url):
        if not url:
            return True
        low = str(url).lower()
        return "no_image" in low or "woocommerce-placeholder" in low or "placeholder" in low


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


def local_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def text_of(el: ET.Element | None) -> str:
    if el is None or el.text is None:
        return ""
    return el.text.strip()


def pick_image(product: ET.Element) -> str:
    """Prefer flask_front, else first non-empty picture child."""
    pictures = None
    for child in product:
        if local_name(child.tag) == "pictures":
            pictures = child
            break
    if pictures is None:
        return ""

    flask = ""
    fallback = ""
    for pic in pictures:
        name = local_name(pic.tag)
        url = text_of(pic)
        if not url or is_placeholder_image(url):
            continue
        if name == "flask_front":
            flask = url
            break
        if not fallback:
            fallback = url
    return flask or fallback


def collect_eans(product: ET.Element) -> list[str]:
    eans: list[str] = []
    seen: set[str] = set()

    def add(raw: str) -> None:
        ean = normalize_ean(raw)
        if ean and ean not in seen:
            seen.add(ean)
            eans.append(ean)

    for child in product:
        name = local_name(child.tag)
        if name == "ean":
            add(text_of(child))
        elif name == "all_eans":
            for sub in child:
                if local_name(sub.tag) == "ean":
                    add(text_of(sub))
    return eans


def parse_wholesale_perfumes_catalog(xml_path: Path | str | os.PathLike) -> dict[str, str]:
    """
    Build EAN → image URL from wholesale-perfumes catalog XML.
    Every EAN on a product (primary + all_eans) maps to the same picture URL.
    """
    path = Path(xml_path)
    tree = ET.parse(path)
    root = tree.getroot()
    index: dict[str, str] = {}

    # Root may be <catalog> or namespaced; products are <product> descendants.
    products = [el for el in root.iter() if local_name(el.tag) == "product"]
    for product in products:
        image = pick_image(product)
        if is_placeholder_image(image):
            continue
        for ean in collect_eans(product):
            if ean not in index:
                index[ean] = image
    return index


def download_catalog(url: str, dest: Path, user: str, token: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, method="GET")
    req.add_header("User-Agent", "SillageWholesalePerfumesFetch/1.0")
    if user and token:
        cred = b64encode(f"{user}:{token}".encode()).decode()
        req.add_header("Authorization", f"Basic {cred}")

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read()
            ctype = (resp.headers.get("Content-Type") or "").lower()
    except urllib.error.HTTPError as err:
        body = err.read()[:500].decode("utf-8", errors="replace")
        raise SystemExit(f"wholesale-perfumes catalog download failed HTTP {err.code}: {body}") from err
    except urllib.error.URLError as err:
        raise SystemExit(f"wholesale-perfumes catalog download failed: {err}") from err

    if b"<product" not in data[:200_000] and "xml" not in ctype:
        preview = data[:300].decode("utf-8", errors="replace")
        raise SystemExit(f"Response does not look like catalog XML. Preview:\n{preview}")

    dest.write_bytes(data)
    # Touch a sidecar stamp for “once a day” hygiene
    stamp = dest.with_suffix(dest.suffix + ".fetched_at")
    stamp.write_text(datetime.now(timezone.utc).isoformat() + "\n", encoding="utf-8")


def cache_is_fresh(dest: Path, max_age_hours: float = 20.0) -> bool:
    if not dest.is_file():
        return False
    age_s = datetime.now(timezone.utc).timestamp() - dest.stat().st_mtime
    return age_s < max_age_hours * 3600


def fetch_and_index(
    *,
    parse_only: bool = False,
    force: bool = False,
    url: str | None = None,
) -> dict[str, str]:
    load_dotenv(ROOT.parent / ".env")
    load_dotenv(ROOT / ".env")

    catalog_url = url or os.environ.get("WHOLESALE_PERFUMES_CATALOG_URL") or DEFAULT_URL
    user = os.environ.get("WHOLESALE_PERFUMES_USER", "").strip()
    token = os.environ.get("WHOLESALE_PERFUMES_TOKEN", "").strip()

    if not parse_only:
        if force or not cache_is_fresh(CACHE_XML):
            if not user or not token:
                if CACHE_XML.is_file():
                    print(
                        "WHOLESALE_PERFUMES_USER/WHOLESALE_PERFUMES_TOKEN unset — using cached XML",
                        file=sys.stderr,
                    )
                else:
                    raise SystemExit(
                        "Set WHOLESALE_PERFUMES_USER and WHOLESALE_PERFUMES_TOKEN in "
                        "python-analysis/.env (API token from wholesale-perfumes user settings)."
                    )
            else:
                print(f"Downloading wholesale-perfumes catalog → {CACHE_XML}")
                print(f"  url={catalog_url}")
                download_catalog(catalog_url, CACHE_XML, user, token)
        else:
            print(f"Using fresh cache (<20h): {CACHE_XML}")

    if not CACHE_XML.is_file():
        raise SystemExit(f"Missing catalog XML: {CACHE_XML}")

    index = parse_wholesale_perfumes_catalog(CACHE_XML)
    print(f"wholesale-perfumes catalog: {len(index)} EAN → image mappings")
    return index


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Fetch/parse wholesale-perfumes.eu catalog",
    )
    parser.add_argument("--parse-only", action="store_true", help="Do not download; parse cache only")
    parser.add_argument("--force", action="store_true", help="Download even if cache is fresh")
    parser.add_argument("--url", default=None, help="Override WHOLESALE_PERFUMES_CATALOG_URL")
    args = parser.parse_args(argv)
    fetch_and_index(parse_only=args.parse_only, force=args.force, url=args.url)


if __name__ == "__main__":
    main()
