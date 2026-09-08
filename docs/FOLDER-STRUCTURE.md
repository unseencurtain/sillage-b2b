# Folder structure

Two trees matter: **this GitHub repo** (code + docs) and the **live VPS** (compose, data,
secrets). They are not the same. The VPS is not a full git clone.

---

## GitHub repository (`unseencurtain/Sillage`)

```
Sillage/
├── AGENTS.md                          Agents: hard rules + read order
├── README.md                          What the repo is + how to run
├── docs/
│   ├── CLIENT-GUIDE.md                Humans: how to use shop + dashboard
│   ├── DOMAIN-MIGRATION.md            Humans: change shop/dash/image hostnames
│   ├── FOLDER-STRUCTURE.md            This file
│   ├── VPS-DEPLOY.md                  Fresh VPS from zero
│   ├── VPS-MIGRATE.md                 New VPS (copy data / restore photos)
│   ├── HANDOFF.md                     Resume after a gap
│   ├── OPERATOR-DASHBOARD.md          Engineers: every UI control
│   ├── CONTEXT.md                     Schema + container facts
│   ├── AGENTS-RUNBOOK.md              Agent loop
│   ├── EAN-IMAGE-SCRAPE.md            Missing photos: fill by EAN only
│   └── …
├── production-environment/
│   ├── compose.yaml                   The only compose file (retail + optional wholesale profile)
│   ├── .env.example                   All env keys (copy to .env, never commit)
│   ├── scripts/
│   │   ├── deploy-vps.sh
│   │   ├── vps-bootstrap.sh           DB grants + wp-config SILLAGE_* defines
│   │   ├── bootstrap-wholesale.sh     Second WP + sillage_wpf on the same VPS
│   │   └── bootstrap-host.sh
│   ├── sillage-core/                  Bun API, sync, React dashboard
│   │   ├── data/image_overrides.json  EAN → photo URL (in git)
│   │   └── data/found-images-manifest.json
│   ├── ecom_sites/
│   │   ├── config/                    php.ini, Apache hide-version, MariaDB, lps-media nginx
│   │   └── data/wp/wp-content/plugins/sillage-bridge/   only WP path in git
│   ├── python-analysis/               Photo matcher / restore / EAN scrape
│   │   └── ean-image-scrape/          Export missing + EAN-only download
│   └── wordpress-image/
├── tools/images/brasty/               Optional Playwright scrape
└── b2b-wholesale/                     Pointer only (parked)
```

**Not in git:** `.env`, dashboard password, `secrets.overlay.env`, WordPress/MariaDB files,
`ecom_sites/data/media/**` (the JPEG bytes), Brasty dump.

---

## Live VPS (`ubuntu@139.99.61.71`, tidy layout)

After cleanup, home should look like this:

```
/home/ubuntu/
├── START-HERE.txt                     One-page live reminder
├── photo-inventory/                   Live CAN/CANNOT CSVs (2026-09-03)
├── sillage/                           App (compose + env + thin binds)
│   ├── .env                           Secrets + image tags + the three domains
│   ├── compose.yaml
│   ├── .feedscratch/                  Vendor feed cache (writable)
│   ├── ean-image-scrape/              Unreviewed EAN scrape (scraped/ is NOT the shop CDN)
│   ├── python-analysis/               Inventory + sitemap helpers copied for ovhe
│   ├── scripts/                       vps-bootstrap.sh, write-sitemaps.py
│   ├── sillage-core/
│   │   ├── data/image_overrides.json
│   │   ├── data/secrets.overlay.env
│   │   └── logs/
│   └── ecom_sites/config/             php.ini, mariadb.vps.cnf, lps-media nginx
├── ecom_sites/data/                   Bind-mounted data (do not delete)
│   ├── wp/                            Retail WordPress
│   ├── wp-wholesale/                  Wholesale WordPress (wholesale.mirainikki.xyz)
│   ├── wp-db/                         Retail MariaDB only (earth + sillage)
│   ├── wholesale-db/                  Wholesale MariaDB (earth_wpf + sillage_wpf)
│   ├── media/                         **Shop CDN photos** (images.prinscosmetic.eu)
│   ├── sitemaps/                      Retail robots + wp-sitemap*.xml (Caddy)
│   └── sitemaps-wholesale/            Wholesale sitemaps
└── caddy/Caddyfile                    Symlink → /etc/caddy/Caddyfile
```

**Removed on purpose (2026-09-03):** `~/brasty/` (dump; needed hits copied to media),
`~/ovhe-backup/`, `~/sillage/backups/`, duplicate download zips.

Docker reads:

| Container | Host path |
|---|---|
| `ecom` | `~/ecom_sites/data/wp` + `~/sillage/ecom_sites/config/php.ini` |
| `ecom-db` | `~/ecom_sites/data/wp-db` (retail only) |
| `wholesale-db` | `~/ecom_sites/data/wholesale-db` |
| `lps-media` | `~/ecom_sites/data/media` |
| `sillage-core` / `sillage-cron` | overrides + secrets + logs + `~/sillage/.feedscratch` |
| `wholesale-ecom` | `~/ecom_sites/data/wp-wholesale` |
| `wholesale-core` / `wholesale-cron` | `secrets.overlay.wholesale.env` + `image_overrides.wholesale.json` + `logs-wholesale` |

Host Caddy (`/etc/caddy/Caddyfile`) is **not** inside `~/sillage`. It terminates TLS and
proxies `:104` (retail shop), `:4000` (retail dashboard), `:105` (images),
`:106` (wholesale shop), `:4001` (wholesale dashboard). The shop sites must 403
AI training crawlers — snippet
[`ecom_sites/config/caddy-heavybot.snippet`](../production-environment/ecom_sites/config/caddy-heavybot.snippet),
story [`CRAWLER-SHIELD.md`](CRAWLER-SHIELD.md). The images site strips `Server` / `Via`
and `lps-media` 404s are plain text (no nginx version).

---

## What we removed from the VPS (leftovers)

These were **not** used by the running stack after the single-compose move:

| Path | Why it went |
|---|---|
| `~/sillage-core/` | Old split-tree copy (live binds are under `~/sillage/sillage-core/`) |
| `~/redis/` | Legacy compose; Valkey is in `~/sillage/compose.yaml` |
| `~/wordpress-image/` | Empty leftover Dockerfile |
| `~/Sillage/` | Only existed for `.feedscratch`; cache now lives in `~/sillage/.feedscratch` |
| `~/vps-bootstrap.sh` | Duplicate; real script is `~/sillage/scripts/vps-bootstrap.sh` |
| `~/ecom_sites/compose.yaml*` + `.env.legacy-unused` | Old split compose (do not `compose up` from here) |
| `~/sillage/.env.bak-wrong-domains-*` | Stale env scrap |
| `~/ovhe-backup/{home,images,database,…}` | Extracted copy of the zip — zip kept |
| `~/ecom_sites/config/` | Unused after the move to `~/sillage/ecom_sites/config/` |
| `~/ecom_sites/compose.yaml*` + `wp-state` + `snapshots/` | Old split compose and unused WP snapshots |
| `~/ecom_sites/.env.legacy-unused` | Leftover split-env scrap |

**Never delete:** `~/sillage/.env`, `~/sillage/sillage-core/data/secrets.overlay.env`,
`~/ecom_sites/data/`.
