/**
 * Turn a WooCommerce order into one dispatchable row per vendor.
 *
 * Orders are read from the HPOS tables directly. WooCommerce 11 stores them in `wp_wc_orders` and
 * friends, not in `wp_posts`, and reading is safe to do in SQL — the reason the writer path goes
 * through the plugin's REST endpoint instead is that *writing* an order has to fire emails, notes
 * and lookup-table updates. Nothing here writes to WordPress.
 */
import { sil, wp } from "../config/env.ts";
import {
  execute,
  query,
  transaction,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "../db/pool.ts";
import { loadVendors, recordEvent } from "../db/settings.ts";
import { logger } from "../lib/log.ts";
import type { IngestResult, OrderAddress, VendorLine, WooOrder, WooOrderLine } from "./types.ts";

const log = logger("orders");

/** Statuses that mean the customer has paid and we owe them goods. */
export const DISPATCHABLE_STATUSES = ["wc-processing", "wc-completed"];

const emptyAddress = (): OrderAddress => ({
  firstName: "",
  lastName: "",
  company: "",
  address1: "",
  address2: "",
  city: "",
  state: "",
  postcode: "",
  country: "",
  email: "",
  phone: "",
});

interface OrderRow extends RowDataPacket {
  id: number;
  status: string;
  currency: string;
  total_amount: string;
  customer_note: string | null;
  date_created_gmt: string;
}

interface AddressRow extends RowDataPacket {
  address_type: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  address_1: string | null;
  address_2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  email: string | null;
  phone: string | null;
}

interface LineRow extends RowDataPacket {
  order_item_id: number;
  order_item_name: string;
  product_id: string | null;
  variation_id: string | null;
  qty: string | null;
  line_total: string | null;
}

function toAddress(row: AddressRow): OrderAddress {
  return {
    firstName: row.first_name ?? "",
    lastName: row.last_name ?? "",
    company: row.company ?? "",
    address1: row.address_1 ?? "",
    address2: row.address_2 ?? "",
    city: row.city ?? "",
    state: row.state ?? "",
    postcode: row.postcode ?? "",
    country: (row.country ?? "").toUpperCase(),
    email: row.email ?? "",
    phone: row.phone ?? "",
  };
}

/** Read one order in full. Returns null when the id is not an order, or is a refund. */
export async function readWooOrder(orderId: number): Promise<WooOrder | null> {
  const orders = await query<OrderRow>(
    `SELECT id, status, currency, total_amount, customer_note, date_created_gmt
       FROM ${wp("wc_orders")} WHERE id = ? AND type = 'shop_order'`,
    [orderId],
  );
  const order = orders[0];
  if (!order) return null;

  const addresses = await query<AddressRow>(
    `SELECT * FROM ${wp("wc_order_addresses")} WHERE order_id = ?`,
    [orderId],
  );
  const billing = addresses.find((a) => a.address_type === "billing");
  const shipping = addresses.find((a) => a.address_type === "shipping");

  // The line item's product and quantity live in itemmeta, one row per field, so they are pivoted
  // here rather than fetched as four separate queries.
  const lines = await query<LineRow>(
    `SELECT i.order_item_id, i.order_item_name,
            MAX(CASE WHEN m.meta_key = '_product_id'   THEN m.meta_value END) AS product_id,
            MAX(CASE WHEN m.meta_key = '_variation_id' THEN m.meta_value END) AS variation_id,
            MAX(CASE WHEN m.meta_key = '_qty'          THEN m.meta_value END) AS qty,
            MAX(CASE WHEN m.meta_key = '_line_total'   THEN m.meta_value END) AS line_total
       FROM ${wp("woocommerce_order_items")} i
       LEFT JOIN ${wp("woocommerce_order_itemmeta")} m ON m.order_item_id = i.order_item_id
      WHERE i.order_id = ? AND i.order_item_type = 'line_item'
      GROUP BY i.order_item_id, i.order_item_name`,
    [orderId],
  );

  return {
    id: Number(order.id),
    status: order.status,
    currency: order.currency,
    total: Number(order.total_amount),
    customerNote: order.customer_note ?? "",
    createdAt: String(order.date_created_gmt),
    billing: billing ? toAddress(billing) : emptyAddress(),
    shipping: shipping ? toAddress(shipping) : emptyAddress(),
    lines: lines.map<WooOrderLine>((l) => ({
      itemId: Number(l.order_item_id),
      name: l.order_item_name,
      // A variation is a distinct post; prefer it, since that is what we would have to order.
      productId: Number(l.variation_id) || Number(l.product_id) || 0,
      quantity: Number(l.qty ?? 0),
      lineTotal: Number(l.line_total ?? 0),
    })),
  };
}

/**
 * Where an order ships to. WooCommerce leaves the shipping address blank for virtual orders and
 * for customers who did not tick "ship to a different address", in which case billing is the
 * delivery address.
 */
export function destinationAddress(order: WooOrder): OrderAddress {
  return order.shipping.address1 !== "" && order.shipping.country !== "" ? order.shipping : order.billing;
}

interface OfferRow extends RowDataPacket {
  wp_post_id: number;
  offer_id: number;
  vendor_id: number;
  vendor_product_id: string;
  sku: string;
  primary_ean: string | null;
  vendor_price: string;
}

/**
 * Attribute each line to the vendor that currently supplies it.
 *
 * The product's *primary* offer is used, not the one that was primary when the customer ordered.
 * Under EAN deduplication the primary offer is whichever vendor is cheapest and in stock, so
 * re-resolving at dispatch time is what lets a second vendor cover a product the first has since
 * run out of.
 */
export async function resolveVendorLines(
  order: WooOrder,
): Promise<{ lines: VendorLine[]; unresolved: IngestResult["unresolved"] }> {
  const postIds = [...new Set(order.lines.map((l) => l.productId).filter((id) => id > 0))];
  const unresolved: IngestResult["unresolved"] = [];

  if (postIds.length === 0) {
    return {
      lines: [],
      unresolved: order.lines.map((l) => ({
        itemId: l.itemId,
        productId: l.productId,
        name: l.name,
        reason: "line has no product id",
      })),
    };
  }

  const offers = await query<OfferRow>(
    `SELECT p.wp_post_id, o.id AS offer_id, o.vendor_id, o.vendor_product_id, o.sku,
            o.primary_ean, o.vendor_price
       FROM ${sil("sil_products")} p
       JOIN ${sil("sil_offers")} o ON o.id = p.primary_offer_id
      WHERE p.wp_post_id IN (${postIds.map(() => "?").join(",")})`,
    postIds,
  );
  const byPost = new Map(offers.map((o) => [Number(o.wp_post_id), o]));

  const vendors = await loadVendors();
  const vendorById = new Map(vendors.map((v) => [v.id, v]));

  const lines: VendorLine[] = [];
  for (const line of order.lines) {
    const offer = byPost.get(line.productId);
    if (!offer) {
      unresolved.push({
        itemId: line.itemId,
        productId: line.productId,
        name: line.name,
        reason: line.productId === 0 ? "line has no product id" : "product is not supplied by any vendor",
      });
      continue;
    }
    const vendor = vendorById.get(Number(offer.vendor_id));
    if (!vendor) {
      unresolved.push({
        itemId: line.itemId,
        productId: line.productId,
        name: line.name,
        reason: `vendor ${offer.vendor_id} is not registered`,
      });
      continue;
    }

    lines.push({
      ...line,
      vendorId: vendor.id,
      vendorSlug: vendor.slug,
      vendorProductId: offer.vendor_product_id,
      sku: offer.sku,
      ean: offer.primary_ean,
      offerId: Number(offer.offer_id),
      unitCost: Number(offer.vendor_price),
      unitPrice: line.quantity > 0 ? line.lineTotal / line.quantity : 0,
    });
  }

  return { lines, unresolved };
}

/**
 * Our reference for a vendor order.
 *
 * The vendor suffix is load-bearing. A mixed cart produces one row per vendor, and BeautyFort
 * treats this string as an idempotency key that must be unique forever — two rows sharing
 * `SIL-1234` would collide both in `sil_vendor_orders.uniq_reference` and at the vendor.
 */
export function orderReference(wcOrderId: number, skuPrefix: string): string {
  return `SIL-${wcOrderId}-${skuPrefix.toUpperCase()}`;
}

/**
 * Split an order into vendor orders. Safe to call repeatedly: a vendor that already has a row is
 * left completely alone, because by then it may already have been submitted and paid for.
 */
export async function ingestOrder(orderId: number): Promise<IngestResult> {
  const order = await readWooOrder(orderId);
  if (!order) throw new Error(`Order ${orderId} does not exist`);

  const result: IngestResult = { orderId, created: [], existing: [], unresolved: [] };

  const { lines, unresolved } = await resolveVendorLines(order);
  result.unresolved = unresolved;

  if (unresolved.length > 0) {
    await recordEvent("warn", "orders", `order ${orderId}: ${unresolved.length} line(s) not attributable to a vendor`, {
      unresolved,
    });
  }
  if (lines.length === 0) {
    log.warn(`order ${orderId}: nothing to dispatch`);
    return result;
  }

  const destination = destinationAddress(order);
  const vendors = await loadVendors();
  const vendorById = new Map(vendors.map((v) => [v.id, v]));

  const byVendor = new Map<number, VendorLine[]>();
  for (const line of lines) {
    const bucket = byVendor.get(line.vendorId);
    if (bucket) bucket.push(line);
    else byVendor.set(line.vendorId, [line]);
  }

  for (const [vendorId, vendorLines] of byVendor) {
    const vendor = vendorById.get(vendorId)!;
    const reference = orderReference(order.id, vendor.skuPrefix);
    const itemsCost = vendorLines.reduce((sum, l) => sum + l.unitCost * l.quantity, 0);
    const revenue = vendorLines.reduce((sum, l) => sum + l.lineTotal, 0);

    const created = await transaction(async (conn: PoolConnection) => {
      // INSERT IGNORE rather than upsert: an existing row may already be submitted, and rewriting
      // its cost or line items would misrepresent what was actually ordered from the vendor.
      const [insert] = await conn.execute<ResultSetHeader>(
        `INSERT IGNORE INTO ${sil("sil_vendor_orders")}
           (wc_order_id, wc_order_number, vendor_id, status, our_reference, currency,
            destination_country, delivery_address_json, items_cost, revenue)
         VALUES (?, ?, ?, 'received', ?, ?, ?, ?, ?, ?)`,
        [
          order.id,
          String(order.id),
          vendorId,
          reference,
          order.currency,
          destination.country,
          JSON.stringify(destination),
          itemsCost.toFixed(2),
          revenue.toFixed(2),
        ],
      );
      if (insert.affectedRows === 0) return null;

      const vendorOrderId = insert.insertId;
      for (const l of vendorLines) {
        await conn.execute(
          `INSERT INTO ${sil("sil_vendor_order_items")}
             (vendor_order_id, wc_order_item_id, wp_post_id, offer_id, sku, vendor_product_id,
              ean, name, quantity, unit_cost, unit_price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            vendorOrderId,
            l.itemId,
            l.productId,
            l.offerId,
            l.sku,
            l.vendorProductId,
            l.ean,
            l.name.slice(0, 500),
            l.quantity,
            l.unitCost.toFixed(4),
            l.unitPrice.toFixed(4),
          ],
        );
      }

      await conn.execute(
        `INSERT INTO ${sil("sil_order_events")} (vendor_order_id, from_status, to_status, message, context)
         VALUES (?, NULL, 'received', ?, ?)`,
        [
          vendorOrderId,
          `ingested ${vendorLines.length} line(s) from WooCommerce order ${order.id}`,
          JSON.stringify({ reference, itemsCost, revenue, destination: destination.country }),
        ],
      );

      return vendorOrderId;
    });

    if (created === null) {
      result.existing.push(vendor.slug);
      continue;
    }
    result.created.push({
      vendorOrderId: created,
      vendor: vendor.slug,
      reference,
      lines: vendorLines.length,
      itemsCost: Number(itemsCost.toFixed(2)),
    });
  }

  log.info(
    `order ${orderId}: ${result.created.length} vendor order(s) created, ` +
      `${result.existing.length} already present, ${result.unresolved.length} line(s) unresolved`,
  );
  return result;
}

interface PendingRow extends RowDataPacket {
  id: number;
}

/**
 * Catch orders whose webhook never arrived.
 *
 * The plugin's webhook is best-effort — sillage-core may be restarting, or the request may time
 * out — so a missed notification has to delay dispatch rather than lose it. This is the safety net
 * that makes that true.
 */
export async function sweepDispatchableOrders(limit = 50): Promise<IngestResult[]> {
  const rows = await query<PendingRow>(
    `SELECT o.id
       FROM ${wp("wc_orders")} o
      WHERE o.type = 'shop_order'
        AND o.status IN (${DISPATCHABLE_STATUSES.map(() => "?").join(",")})
        AND NOT EXISTS (SELECT 1 FROM ${sil("sil_vendor_orders")} v WHERE v.wc_order_id = o.id)
      ORDER BY o.date_created_gmt ASC
      LIMIT ?`,
    [...DISPATCHABLE_STATUSES, limit],
  );

  if (rows.length === 0) return [];
  log.info(`sweep found ${rows.length} order(s) with no vendor rows`);

  const results: IngestResult[] = [];
  for (const row of rows) {
    try {
      results.push(await ingestOrder(Number(row.id)));
    } catch (err) {
      log.error(`sweep failed for order ${row.id}`, String(err));
      await recordEvent("error", "orders", `sweep failed for order ${row.id}: ${String(err)}`);
    }
  }
  return results;
}
