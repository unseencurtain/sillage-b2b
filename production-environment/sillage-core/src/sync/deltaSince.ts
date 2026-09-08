/**
 * Floor the lookback for price/stock deltas so a quiet window cannot hide a batch.
 * Cap at 29 days.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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
  void opts.vendorId;
  const now = opts.now ?? new Date();
  const floor = new Date(now.getTime() - DEFAULT_MIN_LOOKBACK_MS);
  const cap = new Date(now.getTime() - MAX_LOOKBACK_MS);

  const candidate = parseRunTimestamp(opts.lastSuccessAt);
  // Earlier timestamp = longer lookback. Prefer last success when it is older
  // than the floor (e.g. after downtime); otherwise use the floor.
  const chosen = candidate && candidate.getTime() < floor.getTime() ? candidate : floor;
  return chosen.getTime() < cap.getTime() ? cap : chosen;
}
