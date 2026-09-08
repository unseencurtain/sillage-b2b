/**
 * BTS publishes catalogue changes in a daily batch, not continuously. Asking
 * `getProductChanges` for "since the last successful sync" (often 25–35 minutes,
 * because BeautyFort succeeds on the same combined run) returns an empty list
 * even when hundreds of SKUs changed overnight.
 *
 * Floor the lookback so a quiet window cannot hide a batch. Cap at 29 days —
 * the BTS endpoint rejects anything wider.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Minimum lookback per vendor slug. BTS needs ~2 days to cover a missed nightly batch. */
export const MIN_LOOKBACK_MS: Record<string, number> = {
  bts: 48 * HOUR,
};

export const DEFAULT_MIN_LOOKBACK_MS = 6 * HOUR;
export const MAX_LOOKBACK_MS = 29 * DAY;

export function parseRunTimestamp(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const raw = value.trim();
  if (!raw) return null;
  const iso = raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function resolveDeltaSince(opts: {
  lastSuccessAt: Date | string | null | undefined;
  vendorId?: string;
  now?: Date;
}): Date {
  const now = opts.now ?? new Date();
  const minMs = (opts.vendorId && MIN_LOOKBACK_MS[opts.vendorId]) || DEFAULT_MIN_LOOKBACK_MS;
  const floor = new Date(now.getTime() - minMs);
  const cap = new Date(now.getTime() - MAX_LOOKBACK_MS);

  const candidate = parseRunTimestamp(opts.lastSuccessAt);
  // Earlier timestamp = longer lookback. Prefer last success when it is older
  // than the floor (e.g. after downtime); otherwise use the floor.
  const chosen = candidate && candidate.getTime() < floor.getTime() ? candidate : floor;
  return chosen.getTime() < cap.getTime() ? cap : chosen;
}
