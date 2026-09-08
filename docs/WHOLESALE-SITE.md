# Wholesale storefront — `wholesale.mirainikki.xyz`

This repo **is** the wholesale-perfumes shop. It deploys its own WordPress + dashboard.
Retail BeautyFort + BTS lives in [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).

**Live:** shop https://wholesale.mirainikki.xyz · dashboard https://sillage-wholesale.mirainikki.xyz

| | Value |
|---|---|
| Compose | `name: sillage-wholesale` |
| Hub image | `unseencurtain/sillage-b2b:<sha>` |
| WordPress | `wholesale-ecom`, datadir `wp-wholesale` |
| MariaDB | `wholesale-db` (`earth_wpf` / `sillage_wpf`) port 3308 |
| Valkey | **independent** `wholesale-valkey` |
| Engine | `wholesale-core` :4001, `wholesale-cron` |
| Vendor | wholesale-perfumes only |
| Min order | €300 |
| Dispatch | sandbox-locked (`resolveDispatchDryRun()` always true) |

First bring-up: `production-environment/scripts/bootstrap-wholesale.sh`. Secrets:
`WHOLESALE_PERFUMES_USER` / `WHOLESALE_PERFUMES_TOKEN`. Do not enable live vendor spend.
