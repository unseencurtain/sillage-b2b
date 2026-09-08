# sillage-b2b — wholesale-perfumes shop

Standalone dropshipping engine for **wholesale-perfumes.eu** only. This repo can deploy its own
WordPress + dashboard without [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage)
(BeautyFort + BTS retail).

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
./production-environment/scripts/build-push-images.sh --core-only
```

Tag `unseencurtain/sillage-b2b:<sha>`. Do not rebuild WordPress unless asked.

First shop bring-up: `production-environment/scripts/bootstrap-wholesale.sh`.

## Settings → Advanced

Volume filter and description mode apply to this perfume catalogue. Company billing is the
**wholesale-perfumes** invoice profile used on dry-run dispatch payloads — not BeautyFort/BTS.

## Not this repo

Retail LPS (prinscosmetic.eu, BeautyFort + BTS) stays in **Sillage**. Do not copy those connectors here.
