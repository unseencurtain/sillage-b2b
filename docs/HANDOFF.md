# HANDOFF — pick up after a month

Canonical resume doc for this **wholesale-perfumes** shop. Read this first, then
[`CONTEXT.md`](CONTEXT.md) and [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md).

Retail BeautyFort + BTS lives in [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).

---

## Memory — do not invent a different procedure

1. **Docker Hub builds happen on ovhe** (`docker login` as `unseencurtain`). Tag
   `unseencurtain/sillage-b2b:<sha>`. Do not install Docker in a cloud-agent pod. Do not rebuild
   WordPress unless asked.
2. **This repo is the wholesale shop**, not a suffix on retail. Compose `name: sillage-wholesale`.
   Containers: `wholesale-ecom`, `wholesale-db`, `wholesale-core`, `wholesale-cron`,
   `wholesale-valkey`. Independent MariaDB and Valkey — do not add Sillage retail services.
3. **Dispatch is sandbox-locked.** `resolveDispatchDryRun()` always returns `true`. Never enable
   live vendor spend from Settings or Orders.
4. **GitHub** is [unseencurtain/sillage-b2b](https://github.com/unseencurtain/sillage-b2b).

---

## Where things are

| Item | Location |
|---|---|
| **Live VPS** | SSH `ovhe` — `ubuntu@139.99.61.71` |
| **Public URLs** | Shop `https://wholesale.mirainikki.xyz` · Dashboard `https://sillage-wholesale.mirainikki.xyz` |
| **Compose** | `production-environment/compose.yaml` (`name: sillage-wholesale`) |
| **Hub images** | `unseencurtain/sillage-b2b:<tag>`, `unseencurtain/sillage-wordpress:<tag>` |
| **Env** | Laptop `production-environment/.env` → VPS `~/sillage/.env` (gitignored) |
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

First bring-up: `production-environment/scripts/bootstrap-wholesale.sh`. Secrets:
`WHOLESALE_PERFUMES_USER` / `WHOLESALE_PERFUMES_TOKEN`. Then Sync → Rebuild catalogue.

---

## If shop prices ≠ Settings multiplier

`GET_LOCK` is connection-scoped. Save must use a dedicated lock connection. If Save queues forever,
the previous sync did not release the lock — restart `wholesale-core` / `wholesale-cron`.
