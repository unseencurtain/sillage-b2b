/**
 * wholesale-perfumes.eu order adapter — cart-based submit.
 *
 * Two hazards, both handled explicitly:
 * 1. The cart is account-global mutable state. Concurrent dispatches would merge into one wrong
 *    order. The empty→insert→verify→submit sequence runs under a MariaDB GET_LOCK.
 * 2. There is no client idempotency key (same as BTS). Rails already refuse to re-submit a live
 *    `submitted` row; a crash mid-submit leaves `needs_attention` and must never auto-retry.
 *
 * Dry-run means *no remote mutation whatsoever* — not even DELETE /cart.
 *
 * API shape: docs/vendors/wholesale-perfumes-api.md
 */
import { env } from "../../config/env.ts";
import { query, type RowDataPacket } from "../../db/pool.ts";
import { loadVendor } from "../../db/settings.ts";
import {
  extractOrderNumber,
  WholesalePerfumesApiError,
  WholesalePerfumesClient,
  type WholesalePerfumesOrderView,
} from "../../vendors/wholesale-perfumes/WholesalePerfumesClient.ts";
import type {
  CancelResult,
  Destination,
  OrderItem,
  ShippingQuote,
  StockVerification,
  VendorOrderAdapter,
  VendorOrderDraft,
  VendorOrderResult,
  VendorOrderStatus,
  VendorPollStatus,
} from "../adapter.ts";

const CART_LOCK = "sillage:wholesale-perfumes-cart";
const CART_LOCK_TIMEOUT_SEC = 120;

/**
 * Cart line `code` = catalog product `id` (not EAN).
 * Confirmed by the vendor B2B API doc (PHP sample `{ code: 3, quantity: 4 }` and
 * POST /order `"code": "1"` — both are catalog ids). Still prefer a staging cart
 * round-trip before go-live; change only this function if wrong.
 */
export function wholesalePerfumesCartCode(item: OrderItem): string {
  return item.vendorProductId;
}

function client(): WholesalePerfumesClient {
  return new WholesalePerfumesClient({
    user: env.wholesalePerfumes.user,
    token: env.wholesalePerfumes.token,
    catalogUrl: env.wholesalePerfumes.catalogUrl,
    storeUrl: env.wholesalePerfumes.storeUrl,
    apiBaseUrl: env.wholesalePerfumes.apiBaseUrl,
  });
}

async function acquireCartLock(): Promise<boolean> {
  const rows = await query<RowDataPacket & { locked: number | null }>(
    `SELECT GET_LOCK(?, ?) AS locked`,
    [CART_LOCK, CART_LOCK_TIMEOUT_SEC],
  );
  return rows[0]?.locked === 1;
}

async function releaseCartLock(): Promise<void> {
  await query(`SELECT RELEASE_LOCK(?)`, [CART_LOCK]);
}

/** Map GET /order status fields onto our poll enum. Numeric codes are undocumented → unknown. */
export function mapWholesalePerfumesPollStatus(view: WholesalePerfumesOrderView): {
  status: VendorPollStatus;
  rawStatus: string;
} {
  const msg =
    view.statusMsg !== null && view.statusMsg !== undefined ? String(view.statusMsg).trim() : "";
  const code =
    view.statusCode !== null && view.statusCode !== undefined ? String(view.statusCode).trim() : "";
  const rawStatus = msg || code || "unknown";
  const lower = rawStatus.toLowerCase();

  let status: VendorPollStatus = "unknown";
  if (lower.includes("deliver")) status = "delivered";
  else if (lower.includes("ship") || lower.includes("dispatch")) status = "dispatched";
  else if (lower.includes("cancel")) status = "cancelled";
  else if (lower.includes("confirm") || lower.includes("paid") || lower.includes("process")) {
    status = "confirmed";
  } else if (lower.includes("pend") || lower.includes("new") || lower.includes("open")) {
    status = "pending";
  }

  return { status, rawStatus };
}

export class WholesalePerfumesOrderAdapter implements VendorOrderAdapter {
  readonly slug = "wholesale-perfumes";

  async serviceableCountries(): Promise<string[]> {
    const vendor = await loadVendor("wholesale-perfumes");
    return vendor.serviceableCountries;
  }

  /**
   * wholesale-perfumes has no dedicated stock-check endpoint. Trust sil_offers quantities carried on the
   * draft (kept fresh by the hourly store sync). Still enforce positive qty here.
   * Live submit may still fail with API codes 3 / 8 / 1030 if stock moved.
   */
  async verifyStock(items: OrderItem[]): Promise<StockVerification> {
    const lines = items.map((item) => ({
      sku: item.sku,
      requested: item.quantity,
      available: item.quantity,
      ok: item.quantity > 0,
    }));
    const bad = lines.filter((l) => !l.ok);
    return {
      ok: bad.length === 0,
      lines,
      reason: bad.length === 0 ? undefined : `invalid quantity on ${bad.map((l) => l.sku).join(", ")}`,
    };
  }

  /**
   * wholesale-perfumes does not expose a per-cart shipping quote in the documented cart API. Return a single
   * placeholder so the dispatcher rails can still project a total; operator confirms rates later.
   */
  async quoteShipping(_dest: Destination, _items: OrderItem[]): Promise<ShippingQuote[]> {
    return [
      {
        id: "wholesale-perfumes-default",
        company: "wholesale-perfumes.eu (rate TBC)",
        cost: 0,
        deliveryDays: undefined,
      },
    ];
  }

  async submit(order: VendorOrderDraft, dryRun: boolean): Promise<VendorOrderResult> {
    const vendor = await loadVendor("wholesale-perfumes");
    const minOrder = Number(vendor.orderConfig.min_order_value_eur ?? 0);

    const stock = await this.verifyStock(order.items);
    if (!stock.ok) {
      return {
        committed: false,
        vendorOrderNumber: null,
        shippingCost: null,
        shippingOptionId: null,
        shippingCompany: null,
        totalCost: null,
        requestPayload: null,
        responsePayload: stock,
        error: stock.reason ?? "stock verification failed",
      };
    }

    const quotes = await this.quoteShipping(order.destination, order.items);
    const chosen = quotes[0]!;
    const itemsCost = order.items.reduce((s, i) => s + i.unitCost * i.quantity, 0);

    if (minOrder > 0 && itemsCost < minOrder) {
      return {
        committed: false,
        vendorOrderNumber: null,
        shippingCost: chosen.cost,
        shippingOptionId: chosen.id,
        shippingCompany: chosen.company,
        totalCost: null,
        requestPayload: { itemsCost, minOrder },
        responsePayload: { error: "below_min_order_value" },
        error: `wholesale-perfumes min order value €${minOrder} not met (items €${itemsCost.toFixed(2)})`,
      };
    }

    const cartLines = order.items.map((i) => ({
      code: wholesalePerfumesCartCode(i),
      quantity: i.quantity,
    }));

    const addr = order.destination.address;
    const requestPayload = {
      ourReference: order.ourReference,
      cartLines,
      note: order.ourReference,
      codeField: "catalog id (vendorProductId)",
      delivery: {
        name: `${addr.firstName} ${addr.lastName}`.trim(),
        address1: addr.address1,
        address2: addr.address2,
        city: addr.city,
        postcode: addr.postcode,
        country: order.destination.country,
        phone: addr.phone,
      },
      companyBilling: order.billing
        ? {
            company: order.billing.address.company,
            vat: order.billing.vat,
            name: `${order.billing.address.firstName} ${order.billing.address.lastName}`.trim(),
            address1: order.billing.address.address1,
            city: order.billing.address.city,
            postcode: order.billing.address.postcode,
            country: order.billing.country,
          }
        : null,
      itemsCost,
      quote: chosen,
      minOrderValueEur: minOrder,
    };

    // Dry-run: build and record the payload only. No DELETE/POST to the cart API.
    if (dryRun) {
      return {
        committed: false,
        vendorOrderNumber: null,
        shippingCost: chosen.cost,
        shippingOptionId: chosen.id,
        shippingCompany: chosen.company,
        totalCost: Number((itemsCost + chosen.cost).toFixed(2)),
        requestPayload,
        responsePayload: { dryRun: true },
      };
    }

    if (!(await acquireCartLock())) {
      return {
        committed: false,
        vendorOrderNumber: null,
        shippingCost: chosen.cost,
        shippingOptionId: chosen.id,
        shippingCompany: chosen.company,
        totalCost: null,
        requestPayload,
        responsePayload: { error: "wholesale_perfumes_cart_lock_busy" },
        error: "could not acquire wholesale-perfumes cart advisory lock — another dispatch holds it",
      };
    }

    try {
      const api = client();
      await api.clearCart();
      await api.addToCart(cartLines);
      const cart = await api.getCart();
      const submitResponse = await api.submitCart({ note: order.ourReference });
      const vendorOrderNumber = extractOrderNumber(submitResponse);

      if (!vendorOrderNumber) {
        // Submit may or may not have created an order — treat as ambiguous (no idempotency key).
        return {
          committed: false,
          vendorOrderNumber: null,
          shippingCost: chosen.cost,
          shippingOptionId: chosen.id,
          shippingCompany: chosen.company,
          totalCost: null,
          requestPayload,
          responsePayload: { cart, submitResponse },
          ambiguous: true,
          error: "wholesale-perfumes submit returned no order_number",
        };
      }

      return {
        committed: true,
        vendorOrderNumber,
        shippingCost: chosen.cost,
        shippingOptionId: chosen.id,
        shippingCompany: chosen.company,
        totalCost: Number((itemsCost + chosen.cost).toFixed(2)),
        requestPayload,
        responsePayload: { cart, submitResponse },
      };
    } catch (err) {
      const apiErr = err instanceof WholesalePerfumesApiError ? err : null;
      // Documented error codes mean the order was not created. HTTP/network after mutation is ambiguous.
      const ambiguous = !(apiErr?.isClearReject);
      return {
        committed: false,
        vendorOrderNumber: null,
        shippingCost: chosen.cost,
        shippingOptionId: chosen.id,
        shippingCompany: chosen.company,
        totalCost: null,
        requestPayload,
        responsePayload: {
          error: String(err),
          apiError: apiErr?.apiError ?? null,
          details: apiErr?.details ?? null,
        },
        ambiguous,
        error: String(err),
      };
    } finally {
      await releaseCartLock();
    }
  }

  async poll(vendorOrderNumber: string): Promise<VendorOrderStatus> {
    const view = await client().getOrder(vendorOrderNumber);
    const { status, rawStatus } = mapWholesalePerfumesPollStatus(view);

    return {
      status,
      vendorOrderNumber,
      rawStatus,
      parcels: [],
      shippingCompany: null,
    };
  }

  async cancel?(_vendorOrderNumber: string): Promise<CancelResult> {
    return {
      ok: false,
      fee: null,
      message: "wholesale-perfumes has no documented cancel API; cancel via the wholesale-perfumes.eu portal",
    };
  }
}
