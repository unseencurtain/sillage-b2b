"""Shop photo rules — keep in sync with sillage-core/src/sync/imageRules.ts."""

from __future__ import annotations

import re

_HTTP = re.compile(r"^https?://", re.I)


def is_placeholder_image(url: str | None) -> bool:
    if not url:
        return True
    trimmed = url.strip()
    low = trimmed.lower()
    if not low or low in {"none", "null"}:
        return True
    if not _HTTP.match(trimmed):
        return True
    if "no_image" in low or "woocommerce-placeholder" in low or "placeholder" in low:
        return True
    if low.endswith("/images/"):
        return True
    if "/thumb/" in low and "noimage" in low:
        return True
    return False


def is_weak_vendor_thumb(url: str | None) -> bool:
    if not url:
        return True
    if is_placeholder_image(url):
        return True
    low = url.lower()
    return "beautyfort.com/pic/" in low or bool(re.search(r"beautyfort\.com/pic\b", low))


def is_unusable_image(url: str | None) -> bool:
    return is_placeholder_image(url) or is_weak_vendor_thumb(url)


def source_kind(url: str | None) -> str:
    if is_unusable_image(url):
        return "unusable"
    low = (url or "").lower()
    if "images.prinscosmetic.eu" in low or "images.slilverbelt.xyz" in low:
        return "our_cdn"
    if "cdn.shopify.com" in low:
        return "shopify"
    if "images.btswholesaler.com" in low:
        return "bts_cdn"
    if "oceanfragrances.com" in low:
        return "oceanfragrances"
    if "beautyfort.com" in low:
        return "beautyfort"
    return "other_remote"
