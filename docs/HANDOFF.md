# HANDOFF — pick up after a month

Canonical resume doc for this **wholesale-perfumes** shop. Read this first, then
[`CONTEXT.md`](CONTEXT.md) and [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md).

Retail BeautyFort + BTS lives in [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).

---

## Memory — do not invent a different procedure

1. **Empty VPS is first-class.** This repo must bring up WordPress, WooCommerce, HPOS, Caddy,
   MariaDB (`wholesale-db`), Valkey, and wholesale-core on a blank Ubuntu box **without looking
   at unseencurtain/Sillage**. Recipe: `bootstrap-host.sh` as root, then
   `deploy-vps.sh --host <new> --shop … --dash …` (default builds **core + WordPress** into
   `~/sillage-wholesale/`). `--core-only` is day-2 only. WordPress is pinned in
   `wordpress-image/Dockerfile` (`wordpress:7.1-php8.3-apache`). First boot runs
   `scripts/wp-fresh-install.php`.
   **Photos:** wholesale-perfumes catalog XML (`flask_front` URLs). Do **not** create a
   `wholesale-media` container or mount `~/ecom_sites/data/media`. That directory is the
   **Sillage retail** CDN (`images.prinscosmetic.eu` / `lps-media`) because BTS has no vendor
   images and some retail photos are hosted there.
2. **Docker Hub builds happen on a VPS that is `docker login` as `unseencurtain` (today: ovhe).**
   Tag `unseencurtain/sillage-b2b:<sha>`. Do not install Docker in a cloud-agent pod. Do not float
   `wordpress:latest`. Do not run this empty-VPS deploy against ovhe while `wholesale-ecom` still
   lives inside the combined `~/sillage` compose — container names would collide. Cut over first.
3. **This repo is the wholesale shop**, not a suffix on retail. Compose `name: sillage-wholesale`.
   Containers: `wholesale-ecom`, `wholesale-db`, `wholesale-core`, `wholesale-cron`,
   `wholesale-valkey`. Independent MariaDB and Valkey — do not add Sillage retail services
   (no BeautyFort, no BTS, no `ecom` / `ecom-db`, no `lps-media`).
4. **Dispatch is sandbox-locked.** `resolveDispatchDryRun()` always returns `true`. Never enable
   live vendor spend from Settings or Orders.
5. **GitHub** is [unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b).

---

## Where things are

| Item | Location |
|---|---|
| **Live VPS** | SSH `ovhe` — `ubuntu@139.99.61.71` |
| **Public URLs** | Shop `https://wholesale.mirainikki.xyz` · Dashboard `https://sillage-wholesale.mirainikki.xyz` |
| **Compose** | `production-environment/compose.yaml` (`name: sillage-wholesale`) |
| **Hub images** | Live engine `unseencurtain/sillage-b2b:082d695`; empty-VPS WordPress `unseencurtain/sillage-wordpress:ab5ead8` (live `wholesale-ecom` still `d35613d`) |
| **Env** | Laptop `production-environment/.env` → VPS `~/sillage-wholesale/.env` (gitignored) |
| **Client how-to** | [`CLIENT-GUIDE.md`](CLIENT-GUIDE.md) |
| **Operator UI** | [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md) |

---

## Right now — wholesale is this repo

| Item | Value |
|---|---|
| Shop | https://wholesale.mirainikki.xyz → `127.0.0.1:106` (`wholesale-ecom`) |
| Dashboard | https://sillage-wholesale.mirainikki.xyz → `127.0.0.1:4001` (`wholesale-core`) |
| MariaDB | `wholesale-db` port `3308` — `earth_wpf` / `sillage_wpf` |
| Valkey | `wholesale-valkey` (independent) |
| Vendor | wholesale-perfumes only |
| Min order | €300 |
| Dispatch | dry-run only |

Empty VPS: `bootstrap-host.sh` then `deploy-vps.sh` (core + WordPress + HPOS). Secrets:
`WHOLESALE_PERFUMES_USER` / `WHOLESALE_PERFUMES_TOKEN`. Then Sync → Rebuild catalogue.
Do not use `bootstrap-wholesale.sh` — that was the old “second shop on the retail VPS” helper.

---

## If shop prices ≠ Settings multiplier

`GET_LOCK` is connection-scoped. Save must use a dedicated lock connection. If Save queues forever,
the previous sync did not release the lock — restart `wholesale-core` / `wholesale-cron`.
