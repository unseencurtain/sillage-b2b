# wholesale-perfumes B2B API

This shop’s only vendor. Retail BeautyFort + BTS: [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage).

| Feed | URL (defaults) |
|---|---|
| Catalog XML | `WHOLESALE_PERFUMES_CATALOG_URL` — `…/xml/catalog/LovelyXml/en` |
| Store XML (price/stock) | `WHOLESALE_PERFUMES_STOCK_URL` — `…/xml/store/LovelyXml/EUR` |
| Order API | `WHOLESALE_PERFUMES_API_BASE_URL` — `https://www.wholesale-perfumes.eu/api/v1` |

Auth: `WHOLESALE_PERFUMES_USER` + `WHOLESALE_PERFUMES_TOKEN` (Secrets UI or `.env`).

## Orders

The order API is an account-global mutable cart:

`DELETE /cart` → `POST /cart` → `GET /cart` → `POST /cart/submit` (optional `{ note }`).

Cart line `code` is the catalog product `id`. Two concurrent dispatches would merge into one
wrong order, so the sequence holds `GET_LOCK('sillage-wholesale:wholesale-perfumes-cart')`.

**This shop never calls submit.** `resolveDispatchDryRun()` is always true. Dry-run records the
invoice payload (company billing from Settings → Advanced) and does zero remote I/O.

There is no client idempotency key. A crash mid-submit (if live spend were ever enabled) must go
to `needs_attention` and must never auto-retry.

Application `error != 0` on HTTP 200 is a clear reject. HTTP/network failures after mutation
stay ambiguous.
