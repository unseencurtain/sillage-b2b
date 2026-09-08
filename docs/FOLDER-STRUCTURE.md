# Folder structure

This GitHub repo is **unseencurtain/sillage-b2b** (wholesale-perfumes). Retail lives in
[unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).

Two trees matter: **this repo** (code + docs) and the **live VPS** (compose, data, secrets).
The VPS is not a full git clone.

---

## GitHub repository (`unseencurtain/sillage-b2b`)

```
sillage-b2b/
├── AGENTS.md
├── README.md
├── docs/
│   ├── CLIENT-GUIDE.md
│   ├── CONTEXT.md
│   ├── HANDOFF.md
│   ├── OPERATOR-DASHBOARD.md
│   ├── WHOLESALE-SITE.md
│   ├── VPS-DEPLOY.md
│   └── …
├── production-environment/
│   ├── compose.yaml                   Project name: sillage-wholesale
│   ├── .env.example
│   ├── scripts/
│   ├── sillage-core/                  Bun API, sync, React dashboard
│   └── ecom_sites/
│       └── data/wp/wp-content/plugins/sillage-bridge/   only WP path in git
```

**Not in git:** `.env`, dashboard password, `secrets.overlay.env`, WordPress/MariaDB files.

`~/ecom_sites/data/media` is **not this shop**. It is the Sillage retail JPEG folder
(`lps-media` / `images.prinscosmetic.eu`) because BTS has no vendor photos. Wholesale
catalog pictures are `flask_front` URLs.

---

## Live VPS (wholesale stack)

| Container | Role |
|---|---|
| `wholesale-ecom` | WordPress storefront (`:106`) |
| `wholesale-db` | MariaDB `earth_wpf` + `sillage_wpf` (`:3308`) |
| `wholesale-valkey` | Object cache for this shop only |
| `wholesale-core` | API + dashboard (`:4001`) |
| `wholesale-cron` | Sync scheduler |

Do not add Sillage retail services (`ecom`, `ecom-db`, `sillage-core`, `lps-media`) to this compose file.

**Never delete:** `~/sillage/.env`, `~/sillage/sillage-core/data/secrets.overlay.env`,
wholesale WordPress / MariaDB data dirs.
