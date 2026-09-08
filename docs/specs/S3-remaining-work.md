# S3 — remaining work

This shop is wholesale-perfumes only. Retail BeautyFort + BTS image pipelines live in
[unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).

**Before any task:** read `../../AGENTS.md`, then `../CONTEXT.md`.

There is **one vendor** in this repo: `wholesale-perfumes`. Do not add BeautyFort or BTS connectors.
Image overrides are EAN → URL maps, not a second vendor.

Dispatch is sandbox-locked. Never enable live vendor spend.

Photos: `sillage-core/data/image_overrides.json` plus hide-without-image. The deleted
`python-analysis/beautyfort-enriched/` tree belonged to the retail shop.
