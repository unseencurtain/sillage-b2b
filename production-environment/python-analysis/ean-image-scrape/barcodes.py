"""Barcode-only helpers. A photo is never accepted without a matching GTIN/EAN/UPC."""

from __future__ import annotations

import re

DUMMY = {
    "0987654321234",
    "1234567890123",
    "1234567890128",
    "0000000000000",
    "1111111111111",
}


def digits_only(raw: str | None) -> str:
    if raw is None:
        return ""
    return re.sub(r"\D", "", str(raw).strip().lstrip("'"))


def normalize_ean(raw: str | None) -> str | None:
    cleaned = digits_only(raw)
    if not cleaned or cleaned in DUMMY or set(cleaned) == {"0"}:
        return None
    stripped = cleaned.lstrip("0") or None
    return stripped


def is_real_barcode(raw: str | None) -> bool:
    """Keep a row only when it has a usable barcode. Name/brand alone is not enough."""
    cleaned = digits_only(raw)
    if not cleaned or cleaned in DUMMY or set(cleaned) == {"0"}:
        return False
    stripped = cleaned.lstrip("0")
    if not stripped:
        return False
    # Real retail GTINs are 8 / 12 / 13 (sometimes stored zero-padded to 13/14).
    if len(cleaned) >= 12 and len(stripped) >= 8:
        return True
    return len(stripped) >= 8


def lookup_variants(raw: str | None) -> list[str]:
    """Barcode forms to query. Never includes a product name."""
    cleaned = digits_only(raw)
    norm = normalize_ean(raw)
    if not cleaned or not norm:
        return []
    out: list[str] = []
    for cand in (cleaned, norm, cleaned.zfill(12), cleaned.zfill(13), norm.zfill(12), norm.zfill(13)):
        if cand and cand not in out and cand not in DUMMY:
            out.append(cand)
    return out


def codes_match(found: str | None, raw: str | None) -> bool:
    """Accept an upstream hit only when its barcode is the same GTIN (leading zeros ignored)."""
    a = normalize_ean(found)
    b = normalize_ean(raw)
    if not a or not b:
        return False
    if a == b:
        return True
    return a.zfill(14) == b.zfill(14)
