import { describe, expect, test } from "bun:test";
import { MAX_LOOKBACK_MS, resolveDeltaSince } from "../src/sync/deltaSince.ts";

const now = new Date("2026-08-30T08:30:00.000Z");

describe("resolveDeltaSince", () => {
  test("BTS floors a 30-minute last success to 48 hours", () => {
    const since = resolveDeltaSince({
      lastSuccessAt: new Date("2026-08-30T08:00:00.000Z"),
      vendorId: "bts",
      now,
    });
    expect(now.getTime() - since.getTime()).toBe(48 * 60 * 60 * 1000);
  });

  test("other vendors floor to 6 hours", () => {
    const since = resolveDeltaSince({
      lastSuccessAt: new Date("2026-08-30T08:00:00.000Z"),
      vendorId: "beautyfort",
      now,
    });
    expect(now.getTime() - since.getTime()).toBe(6 * 60 * 60 * 1000);
  });

  test("keeps a last success older than the floor (downtime catch-up)", () => {
    const last = new Date("2026-08-23T02:10:00.000Z");
    const since = resolveDeltaSince({ lastSuccessAt: last, vendorId: "bts", now });
    expect(since.getTime()).toBe(last.getTime());
  });

  test("caps lookback at 29 days", () => {
    const since = resolveDeltaSince({
      lastSuccessAt: new Date("2026-06-01T00:00:00.000Z"),
      vendorId: "bts",
      now,
    });
    expect(now.getTime() - since.getTime()).toBe(MAX_LOOKBACK_MS);
  });

  test("null last success uses the vendor floor", () => {
    const since = resolveDeltaSince({ lastSuccessAt: null, vendorId: "bts", now });
    expect(now.getTime() - since.getTime()).toBe(48 * 60 * 60 * 1000);
  });

  test("parses MariaDB datetime strings as UTC", () => {
    const since = resolveDeltaSince({
      lastSuccessAt: "2026-08-23 02:10:00",
      vendorId: "bts",
      now,
    });
    expect(since.toISOString()).toBe("2026-08-23T02:10:00.000Z");
  });
});
