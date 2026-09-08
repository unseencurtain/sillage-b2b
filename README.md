# sillage-b2b — wholesale-perfumes shop

Standalone dropshipping engine for **wholesale-perfumes.eu** only. This repo can deploy its own
WordPress + dashboard without [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage)
(the BeautyFort + BTS retail shop).

| | Live |
|---|---|
| Shop | https://wholesale.mirainikki.xyz |
| Dashboard | https://sillage-wholesale.mirainikki.xyz |
| Vendor | wholesale-perfumes only |
| Minimum order | €300 |
| Dispatch | sandbox (dry-run) — never hits vendor cart/submit |

## Run locally

```bash
cd production-environment
cp .env.example .env          # fill MYSQL_* / DASHBOARD_* / WHOLESALE_PERFUMES_*
docker network create ecom_network
docker network create redis_network
touch sillage-core/data/secrets.overlay.env
docker compose --env-file .env up -d
```

Engine + dashboard without Docker:

```bash
cd production-environment/sillage-core
bun install
bun run web:build
bun test
bun run dev   # needs MariaDB from compose
```

Hub image (build on the VPS that is `docker login` as unseencurtain):

```bash
./production-environment/scripts/build-push-images.sh          # empty VPS: core + WordPress
./production-environment/scripts/build-push-images.sh --core-only  # day-2 engine only
```

Tag `unseencurtain/sillage-b2b:<sha>`. WordPress is pinned (7.1 / PHP 8.3), not `wordpress:latest`.

Empty VPS: as root `bootstrap-host.sh`, then `deploy-vps.sh --host … --shop … --dash …`.
That installs WooCommerce, HPOS, and Caddy (shop + dashboard). Product photos come from the
wholesale-perfumes catalog (`flask_front` URLs), not from the retail JPEG folder on the VPS.
Do not use `bootstrap-wholesale.sh` (old second-shop-on-retail helper).

## Settings → Advanced

Volume filter and description mode apply to this perfume catalogue. Company billing is the
**wholesale-perfumes** invoice profile used on dry-run dispatch payloads.

## Not this repo

Retail LPS (prinscosmetic.eu) stays in **Sillage**. Do not copy those connectors here.
