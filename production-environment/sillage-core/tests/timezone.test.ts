import { describe, expect, test } from "bun:test";
import {
  isValidTimeZone,
  resolveTimeZone,
  todayAtHourUtc,
  toMysqlUtc,
  utcClockForLocalHour,
  windowOpenInZone,
  zonedLocalToUtc,
  zonedParts,
} from "../src/lib/timezone.ts";

describe("timezone helpers", () => {
  test("validates IANA names and falls back to UTC", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/Madrid")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(resolveTimeZone("")).toBe("UTC");
    expect(resolveTimeZone("bogus")).toBe("UTC");
    expect(resolveTimeZone("Asia/Dhaka")).toBe("Asia/Dhaka");
  });

  test("UTC local hour maps to the same UTC clock", () => {
    const now = new Date("2026-08-07T12:00:00.000Z");
    const start = todayAtHourUtc("UTC", 3, now);
    expect(start.toISOString()).toBe("2026-08-07T03:00:00.000Z");
    expect(toMysqlUtc(start)).toBe("2026-08-07 03:00:00");
    expect(utcClockForLocalHour("UTC", 3, now)).toBe("03:00 UTC");
  });

  test("Europe/Madrid summer offset (CEST = UTC+2)", () => {
    // 2026-08-07 is daylight-saving in Madrid.
    const now = new Date("2026-08-07T12:00:00.000Z");
    const start = todayAtHourUtc("Europe/Madrid", 3, now);
    expect(start.toISOString()).toBe("2026-08-07T01:00:00.000Z");
    expect(utcClockForLocalHour("Europe/Madrid", 3, now)).toBe("01:00 UTC");
  });

  test("Asia/Dhaka is UTC+6 year-round", () => {
    const now = new Date("2026-08-07T12:00:00.000Z");
    const start = todayAtHourUtc("Asia/Dhaka", 1, now);
    // 01:00 Dhaka = 19:00 previous day UTC
    expect(start.toISOString()).toBe("2026-08-06T19:00:00.000Z");
  });

  test("windowOpenInZone flips at the local hour", () => {
    const before = new Date("2026-08-07T00:59:00.000Z"); // 02:59 Madrid CEST
    const after = new Date("2026-08-07T01:00:00.000Z"); // 03:00 Madrid CEST
    expect(windowOpenInZone("Europe/Madrid", 3, before)).toBe(false);
    expect(windowOpenInZone("Europe/Madrid", 3, after)).toBe(true);
  });

  test("zonedLocalToUtc round-trips wall clock via zonedParts", () => {
    const utc = zonedLocalToUtc("Asia/Dhaka", 2026, 1, 15, 10);
    const parts = zonedParts(utc, "Asia/Dhaka");
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(1);
    expect(parts.day).toBe(15);
    expect(parts.hour).toBe(10);
  });
});
