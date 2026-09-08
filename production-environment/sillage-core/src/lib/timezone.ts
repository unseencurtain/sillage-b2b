/**
 * IANA timezone helpers for operator schedule + dashboard clocks.
 * MariaDB stays UTC; wall-clock math uses Intl (no CONVERT_TZ tables required).
 */

export const DEFAULT_TIMEZONE = "UTC";

/** Curated list for the Settings UI; any valid IANA string still round-trips. */
export const COMMON_TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Rome",
  "Europe/Warsaw",
  "Europe/Athens",
  "Asia/Dhaka",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
] as const;

export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Invalid / empty → UTC. */
export function resolveTimeZone(tz: string | null | undefined): string {
  const t = (tz ?? "").trim();
  if (!t) return DEFAULT_TIMEZONE;
  return isValidTimeZone(t) ? t : DEFAULT_TIMEZONE;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const tz = resolveTimeZone(timeZone);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/**
 * UTC instant for civil Y-M-D H:M:S in `timeZone`.
 * Iteratively corrects an initial UTC guess against Intl wall-clock parts.
 */
export function zonedLocalToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
): Date {
  const tz = resolveTimeZone(timeZone);
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const want = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(new Date(utcMs), tz);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    utcMs += want - asUtc;
  }
  return new Date(utcMs);
}

/** Today's H:00:00 in `timeZone`, as a UTC Date (relative to `now`). */
export function todayAtHourUtc(timeZone: string, hour: number, now = new Date()): Date {
  const tz = resolveTimeZone(timeZone);
  const h = Math.min(23, Math.max(0, Math.trunc(hour) || 0));
  const parts = zonedParts(now, tz);
  return zonedLocalToUtc(tz, parts.year, parts.month, parts.day, h, 0, 0);
}

export function windowOpenInZone(timeZone: string, hour: number, now = new Date()): boolean {
  return now.getTime() >= todayAtHourUtc(timeZone, hour, now).getTime();
}

/** `YYYY-MM-DD HH:MM:SS` for MariaDB DATETIME comparisons (pool is UTC). */
export function toMysqlUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function formatInTimeZone(date: Date, timeZone: string): string {
  const tz = resolveTimeZone(timeZone);
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

/** UTC clock time of today's local hour (for Settings preview). */
export function utcClockForLocalHour(timeZone: string, hour: number, now = new Date()): string {
  const d = todayAtHourUtc(timeZone, hour, now);
  return `${d.toISOString().slice(11, 16)} UTC`;
}
