/**
 * Pure poll-state helpers. Kept off tracking.ts so unit tests do not load env/db.
 */
import type { VendorPollStatus } from "./adapter.ts";

/** Errors that will not clear on retry — park the row so the cron tick stops spamming. */
export function isPermanentPollFailure(err: unknown): boolean {
  const msg = String(err);
  return (
    /no OrderReference/i.test(msg) ||
    /order not found/i.test(msg) ||
    /invalid vendor order number/i.test(msg) ||
    /does not exist/i.test(msg)
  );
}

const STATUS_RANK: Record<string, number> = {
  submitted: 1,
  confirmed: 2,
  dispatched: 3,
  delivered: 4,
};

function mapPollToRow(status: VendorPollStatus): string | null {
  switch (status) {
    case "confirmed":
      return "confirmed";
    case "dispatched":
      return "dispatched";
    case "delivered":
      return "delivered";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * Advance (or cancel) a vendor-order row from a poll result.
 *
 * Forward ranks only: submitted → confirmed → dispatched → delivered.
 * Cancelled is terminal from submitted/confirmed/dispatched.
 */
export function nextVendorOrderStatus(
  current: string,
  polled: VendorPollStatus,
): string | null {
  if (polled === "cancelled" && current !== "cancelled" && current !== "delivered") {
    return "cancelled";
  }
  const next = mapPollToRow(polled);
  if (next && (STATUS_RANK[next] ?? 0) > (STATUS_RANK[current] ?? 0)) return next;
  return null;
}
