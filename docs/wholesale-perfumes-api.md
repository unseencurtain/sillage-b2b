# wholesale-perfumes.eu B2B cart & order API

Sanitized summary of the vendor’s B2B API notes (operator-supplied markdown).
**No credentials.** Auth values live only in gitignored `.env`.

Base URL: `https://www.wholesale-perfumes.eu/api/v1`  
Env override: `WHOLESALE_PERFUMES_API_BASE_URL`.

## Authentication

HTTP Basic:

- Username = e-shop login (email)
- Password = API token from portal user settings (not the shop password)

```
Authorization: Basic base64(username:token)
Content-Type: application/json
```

## Cart

Account-global mutable cart (one cart per API account).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/cart` | Set cart lines (body = array of `{ code, quantity }`) |
| `GET` | `/cart` | List cart items |
| `GET` | `/cart/{id_cart_item}` | One cart line |
| `DELETE` | `/cart` | Clear entire cart |
| `DELETE` | `/cart/{id_cart_item}` | Remove one line |
| `POST` | `/cart/submit` | Create order from current cart |

### Cart line `code`

`code` is the **catalog product id** (the same `id` as in the catalog/store XML), not the EAN.
Vendor samples use numeric ids (`3`) or string ids (`"1"`). Sillage sends `vendorProductId`
(catalog `id`).

### Submit body (optional)

```json
{ "note": "optional free-text note" }
```

Success includes `order_number` (string) and `error: 0`.

### Application-level status codes

Responses are typically HTTP 200 with an `error` field in JSON:

| Code | Meaning |
|---|---|
| 0 | OK |
| 3 | Not enough stock |
| 8 | Operation failed (often wraps per-line stock errors) |
| 1005 | Delivery type not chosen |
| 1012 | Cart is empty |
| 1018 | Delivery country not supported |
| 1030 | Item out of stock |
| 1031 | Product variation not chosen |

Out-of-stock submit example nests per-product errors under `items` with
`available_quantity`.

## Orders

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/order` | List `order_numbers` |
| `POST` | `/order` | Create order directly (`products[]` + optional `note`) — same error codes as submit |
| `GET` | `/order/{order_number}` | Order detail |

Sillage uses the cart flow (`DELETE` → `POST` → `GET` → `POST /cart/submit`), not
`POST /order`, so concurrent dispatches can serialize on one shared cart.

### Order GET shape

Detail is nested (vendor sample):

```json
{
  "result": {
    "items": [
      {
        "order_number": 1,
        "status_code": 2,
        "status_msg": 2,
        "order_items": [ { "id_product": 123, "pieces": 10, "…" : "…" } ]
      }
    ]
  }
}
```

`status_code` / `status_msg` meanings are not fully documented; poll maps string
messages when present and otherwise records the raw codes.

## Sillage safety rails

- Dry-run must perform **zero** remote cart I/O (not even `DELETE /cart`).
- Live submit holds `GET_LOCK('sillage:wholesale-perfumes-cart')`.
- No client idempotency key → crash mid-submit → `needs_attention`, never auto-retry.
- There is no sandbox; live submit spends real money.

See also: [`vendors-and-image-sources.md`](vendors-and-image-sources.md), CONTEXT §6, decision 25.
