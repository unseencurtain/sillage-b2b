# sillage-b2b — wholesale-perfumes shop

Standalone engine. **BeautyFort / BTS live in [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).** Do not add them here.

Read [`README.md`](README.md) then [`docs/CONTEXT.md`](docs/CONTEXT.md) for containers/DB. Empty VPS: `bootstrap-host.sh` then `deploy-vps.sh` (core + WordPress). Hub images: build on ovhe with `scripts/build-push-images.sh` → `unseencurtain/sillage-b2b:<sha>`. `--core-only` is day-2 only.

**Operator dashboard:** [`docs/OPERATOR-DASHBOARD.md`](docs/OPERATOR-DASHBOARD.md).
**Client how-to:** [`docs/CLIENT-GUIDE.md`](docs/CLIENT-GUIDE.md) — keep it in sync with UI changes.

Hard rules: never commit `.env`; Bun writes products; orders are HPOS; dispatch is sandbox-locked (dry-run). Placing a live vendor order spends real money — there is no vendor sandbox. Never enable live vendor spend.

```bash
cd production-environment/sillage-core
bun install
bun run migrate
bun run sync -- --source=local --vendor=all
bun run dev
bun test
```
