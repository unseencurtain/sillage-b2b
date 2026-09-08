import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatInTimeZone, resolveTimeZone } from "@/lib/timezone";
import { useOperatorTimezone } from "@/components/TimezoneProvider";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function eur(n: number | string | null | undefined) {
  const v = Number(n ?? 0);
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(v);
}

/** Format a MariaDB/UTC timestamp in the given IANA zone (default UTC). */
export function fmtDate(v: string | null | undefined, timeZone = "UTC") {
  if (!v) return "—";
  const d = new Date(v.includes("T") ? v : v.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "—";
  return formatInTimeZone(d, resolveTimeZone(timeZone));
}

/** Dashboard clocks follow Settings → schedule_timezone. */
export function useFmtDate() {
  const tz = useOperatorTimezone();
  return (v: string | null | undefined) => fmtDate(v, tz);
}
