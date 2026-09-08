# Task specs

Each task below is self-contained: read `../CONTEXT.md`, then your row here, then the deep spec if
one is linked. Acceptance criteria are what "done" means — not aspirations.

**Clients / humans:** [CLIENT-GUIDE.md](../CLIENT-GUIDE.md) — how to use the shop and dashboard.
Keep it matching live UI in the same change as any user-visible behaviour.

**Operator reference:** [OPERATOR-DASHBOARD.md](../OPERATOR-DASHBOARD.md) — BeautyFort + BTS
dashboard controls (Settings, Vendors, Sync, Orders). Parked WPF / dead knobs called out.

**Whole-project loop:** [AGENTS-RUNBOOK.md](../AGENTS-RUNBOOK.md) · photos on a new VPS:
[VPS-MIGRATE.md](../VPS-MIGRATE.md) · BTS tracking: [BTS-ORDERS.md](../BTS-ORDERS.md).

## Stage 1

| id | Task | Files | Done when |
|---|---|---|---|
| S1-scaffold | Bun + Hono app, Dockerfile, compose service, mysql2 pool, migration runner, `sillage` schema | `sillage-core/src/{config,db}/`, `migrations/` | `bun run migrate` creates every `sil_*` table and is idempotent on re-run |
| S1-connectors | `VendorConnector` base, BeautyFort + BTS implementations, `--source=local\|live` | `sillage-core/src/vendors/` | Both connectors normalize the `.feedscratch` fixtures with zero errors; the two BeautyFort bugs in CONTEXT §6 are fixed; `bun test` green |
| S1-diff | Checksum upsert into `sil_offers`, vanished detection, offer→product identity | `sillage-core/src/sync/diff.ts` | Second run on unchanged input reports 0 updated, 0 new, 0 vanished |
| S1-taxonomy | Categories, brands, attribute terms → WordPress terms | `sillage-core/src/sync/taxonomy.ts` | BTS depth-4 tree and BeautyFort depth-2 paths both parent correctly; only referenced BTS nodes exist |
| S1-writer | [Deep spec](S1-writer.md) — the batched SQL hot path | `sillage-core/src/sync/writer.ts` | 52.7k cold import under 8 min; all five derived tables in CONTEXT §3 consistent afterwards |
| S1-pricing | Multiplier, RRP clamp, stock-threshold visibility | `sillage-core/src/sync/pricing.ts` | Pure functions, unit-tested against the edge cases in DATA-PROFILE |
| S1-plugin | `sillage-bridge`, the seven items in CONTEXT §5 | `.../plugins/sillage-bridge/` | Images render from vendor URLs with zero `wp-content/uploads` requests; EAN search resolves exactly |
| S1-schedule | Call-interval fast sync + Rebuild button (optional nightly full) via container cron | `sillage-core/src/sync/`, `crontab` | Due ticks run unattended and log to `sil_sync_runs` |
| S1-verify | The verification pass | — | Every check in the plan's Verification section passes |

## Stage 2

| id | Task | Files | Done when |
|---|---|---|---|
| S2-ingest | HMAC webhook out of WordPress, HPOS order read, per-vendor split | `sillage-core/src/orders/ingest.ts` | A mixed-vendor WooCommerce order produces exactly two `sil_vendor_orders` rows |
| S2-dispatch | [Deep spec](S2-dispatch.md) — adapters, state machine, safety rails | `sillage-core/src/orders/` | Dry-run round-trips both vendors without spending money; coverage rules block unserviceable destinations |
| S2-tracking | Poller → tracking back into WooCommerce | `sillage-core/src/orders/tracking.ts` | Tracking number and courier appear on the WooCommerce order with an order note |
| S2-dashboard | React operations dashboard | `sillage-core/web/` | All seven pages functional against real data, authenticated |

## Stage 3

| id | Task | Files | Done when |
|---|---|---|---|
| S3-images | [Deep spec](S3-images.md) — ordered image playbook (WPF XML → ocean CSV → Brasty → cross-vendor) | `tools/images/`, `sillage-core/data/image_overrides.json` | Every catalogue product resolves to a real photo URL; overrides merged in priority order |
| S3-remaining | [Deep spec](S3-remaining-work.md) — Brasty photos, deploy, feature switch-on | `tools/images/brasty/`, deploy scripts, dashboard settings | Every product in the catalogue has a real photo, Stage 3 is live on cosmetic2, and the operator's numbers are entered |

Read the S3 spec in full before starting any of it. It carries the hazards and the assumptions that
are still open, and it is written to be followed without the context of the sessions that produced
Stage 3.

## Conventions

- TypeScript strict. No ORM, no query builder — parameterized SQL through `mysql2/promise`.
- Every SQL statement fully qualifies its database.
- Pure logic (normalize, checksum, slugify, pricing) lives in files with no database import so it
  can be unit-tested directly.
- Errors that need a human go to `sil_events` with a level, never a silent catch.
