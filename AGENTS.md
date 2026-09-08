# sillage-b2b — wholesale-perfumes shop

Standalone engine. **BeautyFort / BTS live in [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).** Do not add them here.

Read [`README.md`](README.md) then [`docs/CONTEXT.md`](docs/CONTEXT.md) for containers/DB. Empty VPS: `bootstrap-host.sh` then `deploy-vps.sh` (core + WordPress). Hub images: build on ovhe with `scripts/build-push-images.sh` → `unseencurtain/sillage-b2b:<sha>`. `--core-only` is day-2 only.

## Standing setup facts — do not ask for these again

Wiping a VPS and standing the wholesale shop up again? These are settled. The retail repo's
`docs/REBUILD-FROM-SCRATCH.md` carries the full retrospective; this is the wholesale half.

| Thing | Value |
|---|---|
| Shop | `wholesale.codeinmoon.xyz` |
| Dashboard | `sillage-wholesale.codeinmoon.xyz` |
| WordPress admin | `orange` |
| Dashboard operator | `wildwest` |
| Host folder | `~/sillage-wholesale` (what `deploy-vps.sh` creates) |
| Test VPS | `ovh` — `51.79.255.226` |

```bash
./production-environment/scripts/deploy-vps.sh --host ovh \
  --shop wholesale.codeinmoon.xyz --dash sillage-wholesale.codeinmoon.xyz \
  --wp-user orange --dash-user wildwest
```

- **Never `admin`** for either login; the script refuses it.
- **No media directory.** Wholesale images are remote `flask_front` URLs from the vendor
  catalogue. There is no `images.*` host and nothing to copy between boxes.
- **The catalogue stays empty until the operator presses Rebuild catalogue.** The scheduler
  declines every tick until one run has succeeded — do not start a sync to be helpful.
- **DNS before deploying.** The script refuses to start until both names resolve to the box. A
  DNS panel's host field appends the zone, so pasting an FQDN yields
  `wholesale.codeinmoon.xyz.codeinmoon.xyz`: the doubled name resolves, the real one NXDOMAINs,
  Let's Encrypt declines, and the browser reports a bare connection failure. Enter the label.
- **Swap is not optional.** A full sync peaks near 2 GB; on a 3.7 GB box without swap the OOM
  killer takes Apache mid-import. The script creates 4 GB if it is missing.
- **A Hub tag says nothing about its WordPress.** The script compares the image's bundled
  version against the Dockerfile pin and refuses a mismatch.

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
