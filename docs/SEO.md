# SEO / Googlebot — retail shop

**Who owns listing:** Bun writes static XML. **Caddy serves the files.** PHP does not
build sitemaps.

**Minutes between syncs** (Sillage dashboard — 30, 40, whatever you set) is for
**wholesale price and stock**. Google does not need that. Fast sync does **not**
rebuild the sitemap and does **not** tell Google that prices changed.

Nightly **Daily full catalogue rebuild** (and a full content rewrite) refreshes the
static sitemap: which products exist and are shop-visible. That is a few seconds of
SQL + disk in Bun, then Caddy. Apache workers stay idle.

Google still hits PHP only when it opens a product **page** (`/product/slug/`). That
is a normal page view. We do not put price/stock JSON-LD on those pages on purpose.

## Files Caddy serves (no PHP)

Host dir: `~/ecom_sites/data/sitemaps/`

| URL | File |
|---|---|
| `/robots.txt` | `robots.txt` (points at the index) |
| `/wp-sitemap.xml` | index of product sitemap pages |
| `/wp-sitemap-posts-product-N.xml` | 2000 shop-visible product URLs each |

Rebuild:

```bash
# on VPS, without waiting for a Hub image (same SQL as Bun)
python3 production-environment/scripts/write-sitemaps.py

# after sillage-core image includes the writer:
docker exec sillage-core bun run sitemap
```

Full sync in Bun calls `writeProductSitemaps()` at the end. Fast ticks do not,
unless they created brand-new Woo posts.

**Live image `sillage-core:a0f03e1` does not include that Bun writer yet.** Until the
next Hub deploy, ovhe writes the same XML with
`python3 ~/sillage/scripts/write-sitemaps.py` (host cron `0 19 * * *` UTC, after the
Dhaka 23:00 full rebuild). Caddy still serves the files either way.

## Plugin (`Sillage_Seo` 1.1.2)

Request-time only, cheap:

- **Disable WordPress core sitemaps** so PHP never runs a 54k-row sitemap query.
- **`noindex,nofollow`** on a catalogue-hidden product HTML page if Google still
  opens that URL.

Do not add Googlebot to the Caddy AI-crawler block ([`CRAWLER-SHIELD.md`](CRAWLER-SHIELD.md)).

## Verdict (live checks, 2026-09-03)

| Check | Result |
|---|---|
| Googlebot → `/` and `/product/…` | **HTTP 200** (not blocked) |
| Caddy `@heavybot` vs Googlebot | **Does not match** — only ClaudeBot / GPTBot / CCBot / Bytespider / Amazonbot / meta-externalagent |
| Product sitemap | Static files from Bun/Caddy; **not** PHP |
| Hidden products in sitemap | **Omitted** (same `exclude-from-catalog` / `exclude-from-search` as the shop) |
| Price / stock in sitemap | **None** |

After Caddy is serving the files (Caddy user must be able to traverse
`~/ecom_sites/data/sitemaps` — `write-sitemaps.py` sets the execute bit on parent dirs):

```bash
curl -sI https://prinscosmetic.eu/wp-sitemap.xml | head -5
curl -sI -A 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' \
  https://prinscosmetic.eu/wp-sitemap-posts-product-2.xml | head -5
```

In Google Search Console: resubmit `https://prinscosmetic.eu/wp-sitemap.xml`.

