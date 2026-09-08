/** Curated IANA zones for Settings; mirrors server COMMON_TIMEZONES. */
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
  if (!tz) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(tz: string | null | undefined): string {
  const t = (tz ?? "").trim();
  if (!t) return "UTC";
  return isValidTimeZone(t) ? t : "UTC";
}

function zonedParts(date: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(timeZone),
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

function zonedLocalToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
): Date {
  const tz = resolveTimeZone(timeZone);
  let utcMs = Date.UTC(year, month - 1, day, hour, 0, 0);
  const want = Date.UTC(year, month - 1, day, hour, 0, 0);
  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(new Date(utcMs), tz);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    utcMs += want - asUtc;
  }
  return new Date(utcMs);
}

export function utcClockForLocalHour(timeZone: string, hour: number, now = new Date()): string {
  const tz = resolveTimeZone(timeZone);
  const h = Math.min(23, Math.max(0, Math.trunc(Number(hour)) || 0));
  const parts = zonedParts(now, tz);
  const d = zonedLocalToUtc(tz, parts.year, parts.month, parts.day, h);
  return `${d.toISOString().slice(11, 16)} UTC`;
}

export function formatInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: resolveTimeZone(timeZone),
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}
