/**
 * Vendor order dispatcher.
 *
 * Transitions are conditional UPDATEs so two workers cannot both claim a row. A row left in
 * `submitting` for BTS is never auto-retried — that is how we avoid paying twice when the
 * outcome of setCreateOrder is unknown.
 */
import { createHash } from "node:crypto";
import { sil } from "../config/env.ts";
import { execute, query, type RowDataPacket } from "../db/pool.ts";
import { loadSettings, loadVendor, recordEvent, type GlobalSettings } from "../db/settings.ts";
import { logger } from "../lib/log.ts";
import { resolveDispatchDryRun } from "../storefront/profile.ts";
import type { VendorOrderAdapter, VendorOrderResult } from "./adapter.ts";
import { createOrderAdapter } from "./adapters/index.ts";
import { resolveBillingAddress, resolveDeliveryAddress } from "./addresses.ts";
import { readWooOrder, destinationAddress } from "./ingest.ts";
import {
  checkCoverage,
  checkDailyCap,
  checkOrderCeiling,
  checkPreQuoteRails,
} from "./rails.ts";
import type { OrderAddress } from "./types.ts";

const log = logger("dispatch");

export type VendorOrderStatus =
  | "received"
  | "approved"
  | "submitting"
  | "submitted"
  | "confirmed"
  | "dispatched"
  | "delivered"
  | "failed"
  | "cancelled"
  | "needs_attention";

interface VendorOrderRow extends RowDataPacket {
  id: number;
  wc_order_id: number;
  vendor_id: number;
  status: VendorOrderStatus;
  our_reference: string;
  vendor_order_number: string | null;
  currency: string;
  destination_country: string;
  delivery_address_json: string | Record<string, unknown> | null;
  billing_address_json: string | Record<string, unknown> | null;
  items_cost: string;
  shipping_cost: string | null;
  total_cost: string | null;
  revenue: string;
  shipping_option_id: string | null;
  shipping_company: string | null;
  request_payload: string | Record<string, unknown> | null;
  dry_run: number;
  attempts: number;
  last_error: string | null;
}

interface ItemRow extends RowDataPacket {
  sku: string;
  vendor_product_id: string;
  ean: string | null;
  name: string;
  quantity: number;
  unit_cost: string;
}

async function loadRow(id: number): Promise<VendorOrderRow | undefined> {
  return (await query<VendorOrderRow>(`SELECT * FROM ${sil("sil_vendor_orders")} WHERE id = ?`, [id]))[0];
}

async function loadItems(vendorOrderId: number): Promise<ItemRow[]> {
  return query<ItemRow>(
    `SELECT sku, vendor_product_id, ean, name, quantity, unit_cost
       FROM ${sil("sil_vendor_order_items")} WHERE vendor_order_id = ?`,
    [vendorOrderId],
  );
}

async function transition(
  id: number,
  from: VendorOrderStatus | VendorOrderStatus[],
  to: VendorOrderStatus,
  message: string,
  patch: Record<string, unknown> = {},
): Promise<boolean> {
  const fromList = Array.isArray(from) ? from : [from];
  const sets = ["status = ?", "updated_at = NOW()"];
  const params: unknown[] = [to];

  for (const [key, value] of Object.entries(patch)) {
    sets.push(`${key} = ?`);
    params.push(value);
  }

  params.push(id, ...fromList);
  const result = await execute(
    `UPDATE ${sil("sil_vendor_orders")}
        SET ${sets.join(", ")}
      WHERE id = ? AND status IN (${fromList.map(() => "?").join(",")})`,
    params,
  );

  if (result.affectedRows === 0) return false;

  const fromStatus = fromList.length === 1 ? fromList[0]! : fromList.join("|");
  await execute(
    `INSERT INTO ${sil("sil_order_events")} (vendor_order_id, from_status, to_status, message, context)
     VALUES (?, ?, ?, ?, ?)`,
    [id, fromStatus, to, message.slice(0, 1000), Object.keys(patch).length ? JSON.stringify(patch) : null],
  );
  return true;
}

function payloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

/** Move received → approved after the rails that do not need a quote pass. */
export async function approveVendorOrder(id: number, force = false): Promise<{ ok: boolean; reason?: string }> {
  const row = await loadRow(id);
  if (!row) return { ok: false, reason: "vendor order not found" };
  if (row.status !== "received" && row.status !== "approved") {
    return { ok: false, reason: `cannot approve from status ${row.status}` };
  }

  const settings = await loadSettings();
  const vendor = await loadVendor(
    (await query<RowDataPacket & { slug: string }>(`SELECT slug FROM ${sil("sil_vendors")} WHERE id = ?`, [row.vendor_id]))[0]!
      .slug,
  );

  const check = checkPreQuoteRails(
    settings,
    row.destination_country,
    vendor.serviceableCountries,
    Number(row.items_cost),
    force,
  );

  if (!check.ok) {
    // Coverage and ceiling failures are terminal; auto_dispatch is just "wait for a human".
    if (check.rail === "auto_dispatch") {
      if (row.status === "received") {
        await transition(id, "received", "approved", "awaiting manual dispatch (auto_dispatch off)");
      }
      return { ok: false, reason: check.reason };
    }
    await transition(id, ["received", "approved"], "failed", check.reason, {
      last_error: `${check.rail}: ${check.reason}`,
    });
    await recordEvent("warn", "dispatch", `order ${id} blocked by ${check.rail}`, check);
    return { ok: false, reason: check.reason };
  }

  if (row.status === "received") {
    const moved = await transition(id, "received", "approved", "rails passed");
    if (!moved) return { ok: false, reason: "lost race claiming the row" };
  }
  return { ok: true };
}

export interface DispatchOptions {
  /** Bypass the auto_dispatch rail (dashboard "Dispatch" button). */
  force?: boolean;
  /** Override the dry_run setting for this call. */
  dryRun?: boolean;
}

export interface DispatchResult {
  id: number;
  status: VendorOrderStatus;
  dryRun: boolean;
  vendorOrderNumber: string | null;
  reason?: string;
}

/**
 * Run one vendor order through quote → rails → submit.
 *
 * With dry_run (the default) every vendor call short of the money-committing one still runs, and
 * the exact payload is recorded. The row ends in `submitted` with dry_run=1 so the dashboard can
 * show what would have been sent; a subsequent real dispatch starts from a fresh approval.
 */
export async function dispatchVendorOrder(
  id: number,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const settings = await loadSettings();
  const force = options.force ?? false;
  const dryRun = resolveDispatchDryRun(options.dryRun ?? settings.ordersDryRun);

  // A prior dry-run ends in `submitted` with dry_run=1 and no vendor order number. Live follow-up
  // must reopen that row — otherwise approve fails with "cannot approve from status submitted"
  // and the dashboard looks like Live succeeded while the vendor never saw the order.
  const existing = await loadRow(id);
  if (!existing) return { id, status: "failed", dryRun, vendorOrderNumber: null, reason: "vendor order not found" };
  if (!dryRun && existing.status === "submitted" && existing.dry_run === 1) {
    const reopened = await transition(id, "submitted", "approved", "re-open dry-run for live dispatch", {
      dry_run: 0,
      last_error: null,
    });
    if (!reopened) {
      return {
        id,
        status: (await loadRow(id))!.status,
        dryRun,
        vendorOrderNumber: null,
        reason: "could not reopen dry-run order for live dispatch",
      };
    }
  } else if (existing.status === "submitted" && existing.dry_run === 0) {
    return {
      id,
      status: "submitted",
      dryRun: false,
      vendorOrderNumber: existing.vendor_order_number,
      reason: "already submitted live — refuse to double-spend",
    };
  }

  const approved = await approveVendorOrder(id, force);
  if (!approved.ok && approved.reason?.includes("auto_dispatch")) {
    return { id, status: "approved", dryRun, vendorOrderNumber: null, reason: approved.reason };
  }
  if (!approved.ok) {
    const row = await loadRow(id);
    return {
      id,
      status: row?.status ?? "failed",
      dryRun,
      vendorOrderNumber: row?.vendor_order_number ?? null,
      reason: approved.reason,
    };
  }

  const row = (await loadRow(id))!;
  const vendorRow = (
    await query<RowDataPacket & { slug: string }>(`SELECT slug FROM ${sil("sil_vendors")} WHERE id = ?`, [
      row.vendor_id,
    ])
  )[0]!;
  const vendor = await loadVendor(vendorRow.slug);
  const adapter = createOrderAdapter(vendor.slug);
  const items = await loadItems(id);
  const woo = await readWooOrder(row.wc_order_id);
  if (!woo) {
    await transition(id, "approved", "failed", "WooCommerce order no longer exists", {
      last_error: "wc order missing",
    });
    return { id, status: "failed", dryRun, vendorOrderNumber: null, reason: "wc order missing" };
  }

  const dest = resolveDeliveryAddress(
    row.delivery_address_json,
    destinationAddress(woo),
    row.destination_country,
  );
  const billingAddr = await resolveBillingAddress(row.billing_address_json, vendor.slug);
  const coverage = checkCoverage(dest.country || row.destination_country, vendor.serviceableCountries);
  if (!coverage.ok) {
    await transition(id, "approved", "failed", coverage.reason, {
      last_error: `${coverage.rail}: ${coverage.reason}`,
    });
    return { id, status: "failed", dryRun, vendorOrderNumber: null, reason: coverage.reason };
  }

  // Claim the row before any vendor HTTP call that could spend money.
  const claimed = await transition(id, "approved", "submitting", dryRun ? "dry-run submit" : "live submit", {
    dry_run: dryRun ? 1 : 0,
    attempts: row.attempts + 1,
    last_error: null,
  });
  if (!claimed) {
    return { id, status: (await loadRow(id))!.status, dryRun, vendorOrderNumber: null, reason: "lost race" };
  }

  try {
    const draft = {
      ourReference: row.our_reference,
      wcOrderId: row.wc_order_id,
      destination: { address: dest, country: dest.country || row.destination_country },
      billing: {
        address: billingAddr,
        country: billingAddr.country || dest.country || row.destination_country,
        vat: billingAddr.vat || undefined,
      },
      items: items.map((i) => ({
        sku: i.sku,
        vendorProductId: i.vendor_product_id,
        ean: i.ean,
        name: i.name,
        quantity: Number(i.quantity),
        unitCost: Number(i.unit_cost),
      })),
      shippingOptionId: row.shipping_option_id ?? undefined,
    };

    // Quote first so the ceiling and daily-cap rails see a real total. Adapters re-quote inside
    // submit; the cost of a second quote is negligible against the cost of a wrong dispatch.
    const quotes = await adapter.quoteShipping(draft.destination, draft.items);
    const shippingCost = quotes[0]?.cost ?? 0;
    const itemsCost = Number(row.items_cost);
    const projected = itemsCost + shippingCost;

    const ceiling = checkOrderCeiling(itemsCost, shippingCost, settings.ordersMaxValueEur);
    if (!ceiling.ok) {
      await transition(id, "submitting", "needs_attention", ceiling.reason, {
        last_error: `${ceiling.rail}: ${ceiling.reason}`,
        shipping_cost: shippingCost,
      });
      await recordEvent("warn", "dispatch", `order ${id} blocked by ${ceiling.rail}`, ceiling);
      return { id, status: "needs_attention", dryRun, vendorOrderNumber: null, reason: ceiling.reason };
    }

    if (!dryRun) {
      const cap = await checkDailyCap(projected, settings.ordersDailyCapEur);
      if (!cap.ok) {
        await transition(id, "submitting", "needs_attention", cap.reason, {
          last_error: `${cap.rail}: ${cap.reason}`,
          shipping_cost: shippingCost,
        });
        await recordEvent("warn", "dispatch", `order ${id} blocked by ${cap.rail}`, cap);
        return { id, status: "needs_attention", dryRun, vendorOrderNumber: null, reason: cap.reason };
      }
    }

    // Persist the payload hash *before* the committing call. For BTS this is the only record of
    // what we tried to send if the process dies mid-request.
    const preHash = payloadHash({ draft, quotes, dryRun });
    await execute(
      `UPDATE ${sil("sil_vendor_orders")}
          SET request_payload = ?, payload_hash = ?, shipping_option_id = ?, shipping_company = ?, shipping_cost = ?
        WHERE id = ? AND status = 'submitting'`,
      [
        JSON.stringify({ draft, quotes }),
        preHash,
        quotes[0]?.id ?? null,
        quotes[0]?.company ?? null,
        shippingCost,
        id,
      ],
    );

    const result: VendorOrderResult = await adapter.submit(draft, dryRun);
    return await applySubmitResult(id, adapter, result, dryRun, settings);
  } catch (err) {
    // Unexpected throw. For BTS/wholesale-perfumes an ambiguous outcome must not be auto-retried (no idempotency key).
    const message = String(err);
    const to: VendorOrderStatus =
      vendor.slug === "bts" || vendor.slug === "wholesale-perfumes" ? "needs_attention" : "failed";
    await transition(id, "submitting", to, message, { last_error: message });
    await recordEvent("error", "dispatch", `order ${id} submit threw: ${message}`);
    return { id, status: to, dryRun, vendorOrderNumber: null, reason: message };
  }
}

async function applySubmitResult(
  id: number,
  adapter: VendorOrderAdapter,
  result: VendorOrderResult,
  dryRun: boolean,
  _settings: GlobalSettings,
): Promise<DispatchResult> {
  const hash = payloadHash(result.requestPayload);

  if (result.ambiguous) {
    await transition(id, "submitting", "needs_attention", result.error ?? "ambiguous submit outcome", {
      request_payload: JSON.stringify(result.requestPayload),
      response_payload: JSON.stringify(result.responsePayload),
      payload_hash: hash,
      shipping_cost: result.shippingCost,
      shipping_option_id: result.shippingOptionId,
      shipping_company: result.shippingCompany,
      last_error: result.error ?? "ambiguous",
    });
    return {
      id,
      status: "needs_attention",
      dryRun,
      vendorOrderNumber: null,
      reason: result.error,
    };
  }

  if (result.error && !result.committed) {
    // BeautyFort may have created a shell; keep its number for cleanup.
    const to: VendorOrderStatus = result.vendorOrderNumber && adapter.cancel ? "needs_attention" : "failed";
    await transition(id, "submitting", to, result.error, {
      vendor_order_number: result.vendorOrderNumber,
      request_payload: JSON.stringify(result.requestPayload),
      response_payload: JSON.stringify(result.responsePayload),
      payload_hash: hash,
      shipping_cost: result.shippingCost,
      shipping_option_id: result.shippingOptionId,
      shipping_company: result.shippingCompany,
      last_error: result.error,
    });
    return { id, status: to, dryRun, vendorOrderNumber: result.vendorOrderNumber, reason: result.error };
  }

  await transition(id, "submitting", "submitted", dryRun ? "dry-run payload recorded" : "submitted to vendor", {
    vendor_order_number: result.vendorOrderNumber,
    request_payload: JSON.stringify(result.requestPayload),
    response_payload: JSON.stringify(result.responsePayload),
    payload_hash: hash,
    shipping_cost: result.shippingCost,
    shipping_option_id: result.shippingOptionId,
    shipping_company: result.shippingCompany,
    total_cost: result.totalCost,
    dry_run: dryRun ? 1 : 0,
    submitted_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    last_error: null,
  });

  log.info(
    `vendor order ${id}: ${dryRun ? "dry-run" : "live"} submit → ` +
      `${result.vendorOrderNumber ?? "no vendor number"} total=${result.totalCost}`,
  );

  return {
    id,
    status: "submitted",
    dryRun,
    vendorOrderNumber: result.vendorOrderNumber,
  };
}

/**
 * On startup (and each cron tick): any BTS row stuck in `submitting` goes to needs_attention.
 * BeautyFort shells in the same state are cancellable, so they go there too for a human to decide.
 */
export async function recoverStuckSubmits(): Promise<number> {
  const rows = await query<VendorOrderRow>(
    `SELECT * FROM ${sil("sil_vendor_orders")} WHERE status = 'submitting'`,
  );
  let n = 0;
  for (const row of rows) {
    const moved = await transition(
      row.id,
      "submitting",
      "needs_attention",
      "recovered from stuck submitting state — do not auto-retry",
      { last_error: "stuck in submitting on startup/tick" },
    );
    if (moved) {
      n++;
      await recordEvent("warn", "dispatch", `recovered stuck vendor order ${row.id}`);
    }
  }
  return n;
}

/** Approve + dispatch every received/approved row that auto_dispatch would take. */
export async function dispatchDueOrders(limit = 20): Promise<DispatchResult[]> {
  await recoverStuckSubmits();
  const settings = await loadSettings();
  if (!settings.ordersAutoDispatch) {
    // Still promote received → approved so the dashboard has something to click.
    const pending = await query<VendorOrderRow>(
      `SELECT id FROM ${sil("sil_vendor_orders")} WHERE status = 'received' ORDER BY id LIMIT ?`,
      [limit],
    );
    for (const row of pending) await approveVendorOrder(row.id, false);
    return [];
  }

  const rows = await query<VendorOrderRow>(
    `SELECT id FROM ${sil("sil_vendor_orders")}
      WHERE status IN ('received','approved')
      ORDER BY id LIMIT ?`,
    [limit],
  );
  const results: DispatchResult[] = [];
  for (const row of rows) {
    results.push(await dispatchVendorOrder(row.id, { force: true }));
  }
  return results;
}

/** Re-expose the destination helper for adapters/tests that already hold an address. */
export type { OrderAddress };
