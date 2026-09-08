#!/usr/bin/env python3
"""Walk the live Brasty dump; split real photos vs camera placeholders."""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "beautyfort-enriched"))
from brasty_placeholders import file_is_brasty_placeholder  # noqa: E402


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "/home/ubuntu/brasty")
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "/home/ubuntu/photo-inventory/indexes")
    out_dir.mkdir(parents=True, exist_ok=True)
    all_p = out_dir / "brasty-files.txt"
    real_p = out_dir / "brasty-real.txt"
    fake_p = out_dir / "brasty-placeholders.txt"
    all_n = real_n = fake_n = 0
    with all_p.open("w", encoding="utf-8") as all_f, real_p.open(
        "w", encoding="utf-8"
    ) as real_f, fake_p.open("w", encoding="utf-8") as fake_f:
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            line = str(path) + "\n"
            all_f.write(line)
            all_n += 1
            if file_is_brasty_placeholder(str(path)):
                fake_f.write(line)
                fake_n += 1
            else:
                real_f.write(line)
                real_n += 1
            if all_n % 5000 == 0:
                print(f"scanned {all_n}", flush=True)
    print(f"brasty files={all_n} real={real_n} placeholders={fake_n}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
