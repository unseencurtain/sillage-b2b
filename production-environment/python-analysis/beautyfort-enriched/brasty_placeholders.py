"""Brasty 'no photo' placeholders — camera icon + BRASTY watermark, not a product shot.

The scrape saved these as EAN.jpg (often WebP bytes with a .jpg name). They must never
go onto the images CDN or into image_overrides.json.

Identified by MD5 of the file bytes (three encodings of the same graphic).
"""
from __future__ import annotations

import hashlib
import os

# 8542-byte, 8412-byte, and 9630-byte copies of the camera / "BRASTY" / green bar graphic.
BRASTY_NO_PHOTO_MD5 = frozenset(
    {
        "3c9965d4926d04529b513909a41373dc",
        "9ec47d66d285ccb6e9398a98ee7eafab",
        "f450cdeefbb9b0fc6f99b19a0b6fa094",
    }
)


def md5_file(path: str, chunk: int = 1 << 16) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        while True:
            buf = f.read(chunk)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def file_is_brasty_placeholder(path: str) -> bool:
    try:
        return md5_file(path) in BRASTY_NO_PHOTO_MD5
    except OSError:
        return False
