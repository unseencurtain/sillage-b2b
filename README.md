# Sillage B2B (wholesale-perfumes)

Separate GitHub home for the **wholesale-perfumes.eu / SoleLuna** B2B lane.

The retail LPS shop ([unseencurtain/Sillage](https://github.com/unseencurtain/Sillage)) sells
**BeautyFort + BTS only**. B2B must not share that WordPress catalogue, `/shop`, or dashboards.

## Layout

| Path | Purpose |
|---|---|
| `docs/wholesale-perfumes-api.md` | Sanitized cart/order API notes (no secrets) |
| `env/.env.example` | `WHOLESALE_PERFUMES_*` placeholders |
| `sillage-vendor/` | Extracted connector, order adapter, tests, SQL migrations |
| This README | Project entry |

## Status

Scaffold + extracted vendor code. Next: own compose/WordPress/Sillage stack and domain.
Do not place live orders against wholesale-perfumes from the retail shop (`orders_dry_run` there
must stay on for BF/BTS testing).

## Provenance

Split from `Sillage` at tag `pre-scratch-20260808` (`31d63de`). Retail tree keeps a thin pointer
under `b2b-wholesale/` and may still carry a parked copy of the connector until it is removed.
