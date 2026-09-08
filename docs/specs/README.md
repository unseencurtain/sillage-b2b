# Task specs

Each task is self-contained: read `../CONTEXT.md`, then your row here, then the deep spec if
linked. This repo is the **wholesale-perfumes** shop. Retail BeautyFort + BTS:
[unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).

**Clients:** [CLIENT-GUIDE.md](../CLIENT-GUIDE.md).
**Operator:** [OPERATOR-DASHBOARD.md](../OPERATOR-DASHBOARD.md).
**Loop:** [AGENTS-RUNBOOK.md](../AGENTS-RUNBOOK.md).

| id | Task | Files |
|---|---|---|
| S1-writer | [Deep spec](S1-writer.md) — batched SQL hot path | `sillage-core/src/sync/writer.ts` |
| S2-dispatch | [Deep spec](S2-dispatch.md) — WPF adapter, rails, dry-run | `sillage-core/src/orders/` |
| S3-images | [Deep spec](S3-images.md) — hide-without-image + overrides | `sillage-core/src/sync/imageRules.ts` |

## Conventions

- TypeScript strict. No ORM — parameterized SQL through `mysql2/promise`.
- Every SQL statement fully qualifies its database.
- Pure logic lives in files with no database import so it can be unit-tested.
- Errors that need a human go to `sil_events`. Dispatch stays sandbox-locked.
