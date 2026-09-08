# Agent runbook — wholesale-perfumes shop

Standalone engine. Retail BeautyFort + BTS lives in [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).

Read this when you pick up the repo cold. Then open only the one deep doc you need.

| If you need | Read |
|---|---|
| **Client / human how-to** | [`CLIENT-GUIDE.md`](CLIENT-GUIDE.md) |
| Resume / live host | [`HANDOFF.md`](HANDOFF.md) |
| Schema, containers, what PHP may write | [`CONTEXT.md`](CONTEXT.md) |
| Dashboard knobs (engineers) | [`OPERATOR-DASHBOARD.md`](OPERATOR-DASHBOARD.md) |
| This shop’s layout | [`WHOLESALE-SITE.md`](WHOLESALE-SITE.md) |
| Fresh VPS | [`VPS-DEPLOY.md`](VPS-DEPLOY.md) |
| Hard rules | [`../AGENTS.md`](../AGENTS.md) |

Hub image: `unseencurtain/sillage-b2b:<sha>`. Compose project `sillage-wholesale`. Valkey container `wholesale-valkey`.

**Dispatch is sandbox-locked.** `resolveDispatchDryRun` is always true. There is no vendor sandbox; a live submit spends real money. Do not enable live vendor spend.

```bash
cd production-environment/sillage-core
bun install
bun run migrate
bun run sync -- --source=local --vendor=all
bun run dev
bun test
```
