#!/usr/bin/env python3
"""Write static product sitemaps on the VPS host (no PHP, no Hub image required).

Same rules as sillage-core/src/sync/sitemaps.ts: shop-visible products only,
URL + lastmod date, no prices, no stock. Caddy serves the files.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from xml.sax.saxutils import escape

PAGE = 2000
DEST = Path(os.environ.get("SITEMAP_HOST_DIR", os.path.expanduser("~/ecom_sites/data/sitemaps")))
BASE = os.environ.get("WP_BASE_URL", "https://prinscosmetic.eu").rstrip("/")

SQL = r"""
SELECT p.post_name, p.post_modified_gmt
  FROM earth.wp_posts p
 WHERE p.post_type = 'product'
   AND p.post_status = 'publish'
   AND p.post_name <> ''
   AND p.ID NOT IN (
     SELECT tr.object_id
       FROM earth.wp_term_relationships tr
       JOIN earth.wp_term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
       JOIN earth.wp_terms t ON t.term_id = tt.term_id
      WHERE tt.taxonomy = 'product_visibility'
        AND t.slug IN ('exclude-from-catalog', 'exclude-from-search')
   )
 ORDER BY p.ID
"""


def mysql_tsv(sql: str) -> str:
    pw = subprocess.check_output(
        ["bash", "-lc", "grep ^MYSQL_ROOT_PWD= ~/sillage/.env | cut -d= -f2-"],
        text=True,
    ).rstrip("\n")
    return subprocess.check_output(
        [
            "docker",
            "exec",
            "-e",
            f"MYSQL_PWD={pw}",
            "ecom-db",
            "mariadb",
            "-uroot",
            "-N",
            "--batch",
            "-e",
            sql,
        ],
        text=True,
    )


def lastmod(raw: str) -> str:
    return (raw or "")[:10]


def main() -> int:
    rows: list[tuple[str, str]] = []
    for line in mysql_tsv(SQL).splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        slug, modified = parts[0].strip(), parts[1].strip()
        if slug:
            rows.append((slug, lastmod(modified)))
    pages = [rows[i : i + PAGE] for i in range(0, len(rows), PAGE)] or [[]]
    newest = max((d for _, d in rows), default="") or "1970-01-01"
    tmp = DEST.with_name(DEST.name + ".tmp")
    if tmp.exists():
        import shutil

        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    robots = (
        "User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n\n"
        f"Sitemap: {BASE}/wp-sitemap.xml\n"
    )
    (tmp / "robots.txt").write_text(robots, encoding="utf-8")
    index_items = []
    for i in range(1, len(pages) + 1):
        loc = escape(f"{BASE}/wp-sitemap-posts-product-{i}.xml")
        index_items.append(
            f"  <sitemap>\n    <loc>{loc}</loc>\n    <lastmod>{escape(newest)}</lastmod>\n  </sitemap>"
        )
    (tmp / "wp-sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(index_items)
        + "\n</sitemapindex>\n",
        encoding="utf-8",
    )
    for i, page in enumerate(pages, start=1):
        urls = []
        for slug, day in page:
            loc = escape(f"{BASE}/product/{slug}/")
            urls.append(
                f"  <url>\n    <loc>{loc}</loc>\n    <lastmod>{escape(day)}</lastmod>\n  </url>"
            )
        (tmp / f"wp-sitemap-posts-product-{i}.xml").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            + "\n".join(urls)
            + "\n</urlset>\n",
            encoding="utf-8",
        )
    if DEST.exists():
        import shutil

        shutil.rmtree(DEST)
    tmp.rename(DEST)
    # Caddy runs as user `caddy` and cannot traverse a 750 home directory.
    for parent in [DEST, *DEST.parents]:
        try:
            os.chmod(parent, os.stat(parent).st_mode | 0o001)
        except PermissionError:
            break
        if parent == Path("/home") or parent == Path("/"):
            break
    for f in DEST.iterdir():
        os.chmod(f, os.stat(f).st_mode | 0o004)
    print(f"wrote {len(rows)} URLs in {len(pages)} page(s) → {DEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
