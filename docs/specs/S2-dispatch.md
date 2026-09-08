# S2-dispatch — vendor order adapters, state machine, safety rails

**Every successful call in this component spends real money.** Neither vendor has a sandbox.
BeautyFort's `mode: false` is live. BTS's `setCreateOrder` is always live. Build the rails first
and the adapters second.

## State machine

```
received ──> approved ──> submitting ──> submitted ──> confirmed ──> dispatched ──> delivered
    │            │             │
    │            │             └──> needs_attention   (crash or ambiguous outcome)
    │            └──────────────────> failed          (validation, stock, coverage)
    └───────────────────────────────> cancelled
```

One `sil_vendor_orders` row per (WooCommerce order, vendor), unique key on `(wc_order_id,
vendor_id)`. A mixed-vendor cart produces two rows that succeed or fail independently.

Transitions are conditional `UPDATE`s (`SET status='submitting' WHERE status='approved'`) so two
workers cannot both claim a row. Zero affected rows means someone else took it — return, do not
retry.

## Safety rails — implement before any adapter

| Rail | Behaviour |
|---|---|
| `auto_dispatch_enabled` | Default **false**. Orders stop at `approved` until a human clicks Dispatch |
| `dry_run` | Default **true**. Runs every step including validation and quoting, stops before the call that commits money, records the exact payload |
| `max_order_value_eur` | Per-order ceiling. Exceeding it routes to `needs_attention` |
| `daily_spend_cap_eur` | Rolling 24h sum of submitted order totals. Exceeding it blocks dispatch |
| Coverage check | Destination country must be in the vendor's `serviceable_countries` |

Every blocked dispatch writes a `sil_events` row explaining which rail fired.

## Idempotency — asymmetric between vendors

**BeautyFort** has a real idempotency key. `yourOrderReference = SIL-{wc_order_id}` is fixed for the
lifetime of the order and must be unique across test and live forever. A duplicate submit is
rejected by the vendor rather than creating a second order, so retrying is safe.

**BTS accepts no client reference and exposes no list-orders endpoint.** There is no way to ask
"did my last request land?". Therefore:

- Write the `submitting` transition and the request payload hash to the database **before** the
  HTTP call, and commit.
- On success, store `vendor_order_number` and move to `submitted`.
- On a network error or timeout the outcome is genuinely unknown: move to `needs_attention` with
  the payload recorded.
- **On startup, any BTS row left in `submitting` goes to `needs_attention`. Never auto-retry.**
  A human reconciles against the BTS portal.

This is deliberate. Automatic retry here means occasionally paying twice for one order.

## Adapters

Both implement:

```ts
interface VendorOrderAdapter {
  readonly slug: string;
  serviceableCountries(): Promise<string[]>;
  verifyStock(items: OrderItem[]): Promise<StockVerification>;
  quoteShipping(dest: Destination, items: OrderItem[]): Promise<ShippingQuote[]>;
  submit(order: VendorOrderDraft, dryRun: boolean): Promise<VendorOrderResult>;
  poll(vendorOrderNumber: string): Promise<VendorOrderStatus>;
  cancel?(vendorOrderNumber: string): Promise<CancelResult>;
}
```

### BTS — single shot

1. `getProductStock(skus)` — max 100 per call, verify every line
2. `getShippingPrices({country_code, postal_code}, products)` → pick by configured strategy
   (cheapest or fastest) → `shipping_cost_id`
3. `setCreateOrder({ payment_method, products, shipping_cost_id, dropshipping: 1, ...address })`
4. Response may be a JSON object **or a bare order-number string** — the existing client already
   handles both; keep that

Order-level error codes to surface verbatim: `no_stock`, `shipping_cost_code_error`,
`no_enough_money`, `no_enough_credit`, `state_code_error`, `payment_method_error`,
`country_code_is_required`.

### BeautyFort — four steps, partially committed state

1. `getAccountInformation()` → delivery option ID for the destination country (fixed table, no
   per-cart quote)
2. `createOrder("Direct Dispatch", "SIL-{id}")` → `orderReference` — **persist immediately**, this
   is a real order shell
3. `addOrderItem(stockCode, qty, orderReference)` per line
4. `placeOrder(deliveryOptionId, invoice…, delivery…, orderReference, "SIL-{id}", false)`

Failing between steps 2 and 4 leaves an unplaced shell at the vendor. Unplaced shells are
cancellable, so the recovery path calls `cancelOrder` and returns the row to `approved`. Record
`orderReference` before every subsequent step so recovery always knows what to clean up.

Dropshipping requires `"Direct Dispatch"`, never `"Wholesale"`. Generate a fresh nonce per request.

## Shipping coverage

| Vendor | Countries |
|---|---|
| BeautyFort | BE DE ES IT NL PT SE — flat €7.15–€10.65 |
| BTS | 25 EU (all but CY, MT) plus CH, GB, MC — live quote |

Enforced in two places: at checkout, so a customer never buys something that cannot ship; and in
primary-offer selection, so a deduped product resolves to a vendor that serves the destination.

BTS flags 1,974 products `flammable`, which typically bars air freight — carried through to the
order record for the operator.

## Polling

Every 15 minutes for orders in `submitted` or `confirmed` (and `dispatched`, for delivery).
BeautyFort's own guidance is no more than one status poll per 5 minutes.

- BTS — `getOrder(orderNumber)` for status; `getTrackings([...])` when tracking is still
  empty. v2.1 `order_not_found` / `tracking: null` means **not assigned yet** (24–72h after
  create), not a missing order. **Cancelled** must leave `submitted` (it is not a forward
  rank). Details: [`../BTS-ORDERS.md`](../BTS-ORDERS.md).
- BeautyFort — `getOrderDetail(ref, undefined, true)`, tracking arrives in `parcels[]`
  (`courierName`, `trackingCode`, `trackingURL`, `dateDispatched`) once status is `Dispatched`

On first tracking, hand off to S2-tracking to write back into WooCommerce.

## Billing vs delivery addresses

- **Delivery** (customer ship-to) lives in `sil_vendor_orders.delivery_address_json`. Ingest
  snapshots WooCommerce shipping (else billing) once. Dashboard edits update only Sillage — they
  never write HPOS `wp_wc_order_addresses`.
- **Billing / invoice** uses Settings profiles `company_billing_beautyfort` /
  `company_billing_bts`, overridable per order via `billing_address_json`.
- BeautyFort: `InvoiceAddress*` ← company billing; `DeliveryAddress*` ← delivery JSON.
- BTS: API ship-to only (delivery + `dropshipping: 1`). Company billing is recorded in the dry-run
  payload for ops; there is no BTS billing address API field.

## WooCommerce order status

Sillage marks the WC order `completed` only when every **non-dry-run** vendor row for that order
is `delivered` or `cancelled`. Rows in `submitted` / `confirmed` / `dispatched` leave WC at
`processing`. If a brand-new checkout jumps to `completed` before any poll, that is WooCommerce
payment/auto-complete config — not this path.

## Acceptance

- Dry run completes end to end for both vendors and spends nothing
- A destination outside a vendor's coverage fails at validation, not at the vendor
- Killing the process mid-submit leaves a BTS row in `needs_attention`, never resubmitted on restart
- Exceeding either spend rail blocks dispatch and records why
- A mixed-vendor order dispatches to both vendors independently, and one failing does not roll back
  the other
- Address edits in the dashboard do not change WooCommerce shipping
- Dry-run payloads show company invoice and customer delivery as separate blocks
- WC completes only after all live vendor rows are delivered (or cancelled)
