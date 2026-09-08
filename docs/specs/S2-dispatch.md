# S2-dispatch — wholesale-perfumes adapter, state machine, safety rails

**A live submit spends real money.** wholesale-perfumes has no sandbox. This shop keeps
`resolveDispatchDryRun()` always true. Do not enable live vendor spend.

Retail BeautyFort + BTS adapters live in [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).

## State machine

```
received ──> approved ──> submitting ──> submitted ──> confirmed ──> dispatched ──> delivered
    │            │             │
    │            │             └──> needs_attention   (crash or ambiguous outcome)
    │            └──────────────────> failed          (validation, stock, coverage)
    └───────────────────────────────> cancelled
```

One `sil_vendor_orders` row per (WooCommerce order, vendor). This shop has one vendor.

Transitions are conditional `UPDATE`s so two workers cannot both claim a row.

## Safety rails

| Rail | Behaviour |
|---|---|
| `auto_dispatch_enabled` | Forced **off** on this shop |
| `dry_run` | Forced **true**. Records the exact payload; zero remote I/O |
| `max_order_value_eur` | Per-order ceiling |
| `daily_spend_cap_eur` | Rolling 24h sum |
| Coverage check | Destination country must be in `serviceable_countries` |
| Shop MOQ | €300 at cart/checkout (PHP bridge) |

## Adapter

`WholesalePerfumesOrderAdapter` only. Cart is account-global
(`DELETE /cart` → `POST /cart` → `GET /cart` → `POST /cart/submit`). Crash mid-submit would go to
`needs_attention` and must never auto-retry. Cart line `code` is catalog product `id`.

Company billing: Settings → Advanced → `company_billing_wholesale_perfumes`. Delivery is the
customer ship-to snapshot. Dashboard address edits never write HPOS `wp_wc_order_addresses`.

## WooCommerce order status

Sillage marks the WC order `completed` only when every **non-dry-run** vendor row is `delivered`
or `cancelled`. Dry-run rows never complete Woo.

## Acceptance

- Dry run completes end to end and spends nothing
- A destination outside coverage fails at validation
- Exceeding a spend rail blocks dispatch and records why
- Address edits in the dashboard do not change WooCommerce shipping
- Dry-run payloads show company invoice and customer delivery as separate blocks
