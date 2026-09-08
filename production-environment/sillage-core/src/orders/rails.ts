/**
 * Safety rails for vendor dispatch.
 *
 * Every successful call beyond these rails spends real money. Defaults are fail-closed:
 * auto-dispatch off, dry-run on. Changing them is a deliberate dashboard action.
 */
import { sil } from "../config/env.ts";
import { query, type RowDataPacket } from "../db/pool.ts";
import type { GlobalSettings } from "../db/settings.ts";

export type RailBlock =
  | { ok: true }
  | { ok: false; rail: string; reason: string };

/** Destination must be in the vendor's serviceable country list. */
export function checkCoverage(country: string, serviceable: string[]): RailBlock {
  const code = country.toUpperCase();
  if (!code) return { ok: false, rail: "coverage", reason: "destination country is missing" };
  if (!serviceable.map((c) => c.toUpperCase()).includes(code)) {
    return {
      ok: false,
      rail: "coverage",
      reason: `${code} is outside this vendor's serviceable countries (${serviceable.join(", ")})`,
    };
  }
  return { ok: true };
}

/** Per-order value ceiling. */
export function checkOrderCeiling(itemsCost: number, shippingCost: number, maxEur: number): RailBlock {
  const total = itemsCost + (Number.isFinite(shippingCost) ? shippingCost : 0);
  if (total > maxEur) {
    return {
      ok: false,
      rail: "max_order_value",
      reason: `order total EUR ${total.toFixed(2)} exceeds ceiling EUR ${maxEur}`,
    };
  }
  return { ok: true };
}

/** Rolling 24h spend of already-submitted (non-dry-run) orders. */
export async function checkDailyCap(
  additionalEur: number,
  dailyCapEur: number,
): Promise<RailBlock> {
  const rows = await query<RowDataPacket & { spent: string | null }>(
    `SELECT COALESCE(SUM(total_cost), 0) AS spent
       FROM ${sil("sil_vendor_orders")}
      WHERE dry_run = 0
        AND status IN ('submitting','submitted','confirmed','dispatched','delivered','needs_attention')
        AND submitted_at >= NOW() - INTERVAL 1 DAY`,
  );
  const spent = Number(rows[0]?.spent ?? 0);
  if (spent + additionalEur > dailyCapEur) {
    return {
      ok: false,
      rail: "daily_spend_cap",
      reason: `EUR ${(spent + additionalEur).toFixed(2)} would exceed daily cap EUR ${dailyCapEur} (already spent ${spent.toFixed(2)})`,
    };
  }
  return { ok: true };
}

/**
 * Decide whether a row may leave `approved` for submit.
 *
 * Auto-dispatch off parks the row at approved for a human click. Dry-run is not a block — it
 * changes what submit does, not whether submit runs.
 */
export function checkAutoDispatch(settings: GlobalSettings, force: boolean): RailBlock {
  if (force || settings.ordersAutoDispatch) return { ok: true };
  return {
    ok: false,
    rail: "auto_dispatch",
    reason: "auto_dispatch is off; approve and dispatch from the dashboard",
  };
}

/** Run every rail that can be evaluated without a shipping quote. */
export function checkPreQuoteRails(
  settings: GlobalSettings,
  country: string,
  serviceable: string[],
  itemsCost: number,
  force: boolean,
): RailBlock {
  const auto = checkAutoDispatch(settings, force);
  if (!auto.ok) return auto;
  const coverage = checkCoverage(country, serviceable);
  if (!coverage.ok) return coverage;
  // Shipping unknown yet; ceiling checked again after the quote with the real total.
  return checkOrderCeiling(itemsCost, 0, settings.ordersMaxValueEur);
}
