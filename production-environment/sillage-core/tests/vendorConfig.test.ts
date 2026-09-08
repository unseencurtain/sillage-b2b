import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LIVE_MAX_PER_DAY,
  resolveLiveMaxPerDay,
  resolveWholesalePerfumesStoreLimits,
} from "../src/vendors/liveLimits.ts";
import { parseVendorPatch } from "../src/vendors/validateVendorPatch.ts";

describe("parseVendorPatch", () => {
  test("accepts a full valid patch", () => {
    const r = parseVendorPatch({
      storefrontLabel: "LPS03",
      priceMultiplier: null,
      minVisibleStock: 2,
      fxRate: 1,
      vatRate: 0.21,
      minOrderValueEur: 100,
      serviceableCountries: ["de", "nl", "BE"],
      active: false,
      liveMaxPerDay: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch.vatRate).toBe(0.21);
    expect(r.patch.serviceableCountries).toEqual(["DE", "NL", "BE"]);
    expect(r.patch.priceMultiplier).toBeNull();
    expect(r.patch.active).toBe(false);
  });

  test("rejects non-object / empty / unknown fields", () => {
    expect(parseVendorPatch(null).ok).toBe(false);
    expect(parseVendorPatch([]).ok).toBe(false);
    expect(parseVendorPatch({}).ok).toBe(false);
    const unknown = parseVendorPatch({ nope: 1 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("Unknown field");
  });

  test("rejects negative or non-finite multipliers, fx, and VAT", () => {
    expect(parseVendorPatch({ priceMultiplier: -1 }).ok).toBe(false);
    expect(parseVendorPatch({ fxRate: -0.1 }).ok).toBe(false);
    expect(parseVendorPatch({ fxRate: 0 }).ok).toBe(false);
    expect(parseVendorPatch({ vatRate: Number.NaN }).ok).toBe(false);
    expect(parseVendorPatch({ vatRate: -0.05 }).ok).toBe(false);
    expect(parseVendorPatch({ fxRate: "Infinity" }).ok).toBe(false);
  });

  test("VAT is a non-negative fraction (same as pricing.ts)", () => {
    const ok = parseVendorPatch({ vatRate: "0.21" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.patch.vatRate).toBe(0.21);
    // 21 would mean +2100% — allowed by schema but operator-facing UI documents fraction form.
    expect(parseVendorPatch({ vatRate: 21 }).ok).toBe(true);
  });

  test("rejects invalid country codes", () => {
    const r = parseVendorPatch({ serviceableCountries: ["DEU"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ISO");
    expect(parseVendorPatch({ serviceableCountries: ["D"] }).ok).toBe(false);
    expect(parseVendorPatch({ serviceableCountries: "DE" }).ok).toBe(false);
  });

  test("rejects non-integer stock / live caps", () => {
    expect(parseVendorPatch({ minVisibleStock: 1.5 }).ok).toBe(false);
    expect(parseVendorPatch({ liveMaxPerDay: 2.2 }).ok).toBe(false);
  });

  test("empty string clears nullable overrides", () => {
    const r = parseVendorPatch({
      priceMultiplier: "",
      minVisibleStock: "",
      minOrderValueEur: "",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch.priceMultiplier).toBeNull();
    expect(r.patch.minVisibleStock).toBeNull();
    expect(r.patch.minOrderValueEur).toBeNull();
  });
});

describe("resolveLiveMaxPerDay", () => {
  test("prefers the vendor row over legacy settings", () => {
    expect(resolveLiveMaxPerDay("beautyfort", { liveMaxPerDay: 7 }, 20)).toBe(7);
    expect(resolveLiveMaxPerDay("wholesale-perfumes", { liveMaxPerDay: 1 }, 99)).toBe(1);
  });

  test("falls back to legacy setting when row is null / unset", () => {
    expect(resolveLiveMaxPerDay("bts", { liveMaxPerDay: null }, 48)).toBe(48);
    expect(resolveLiveMaxPerDay("bts", null, 12)).toBe(12);
  });

  test("falls back to built-in defaults when both are missing", () => {
    expect(resolveLiveMaxPerDay("beautyfort", null, null)).toBe(20);
    expect(resolveLiveMaxPerDay("bts", { liveMaxPerDay: null }, null)).toBe(48);
    expect(resolveLiveMaxPerDay("wholesale-perfumes", null, undefined)).toBe(1);
    expect(DEFAULT_LIVE_MAX_PER_DAY.beautyfort).toBe(20);
  });
});

describe("resolveWholesalePerfumesStoreLimits", () => {
  test("keeps catalog/store separation defaults (24/day, 60 min)", () => {
    const r = resolveWholesalePerfumesStoreLimits(null);
    expect(r.maxPerDay).toBe(24);
    expect(r.minMinutes).toBe(60);
  });

  test("prefers vendor row over defaults", () => {
    expect(
      resolveWholesalePerfumesStoreLimits({ storeLiveMaxPerDay: 10, storeLiveMinMinutes: 30 }),
    ).toEqual({ maxPerDay: 10, minMinutes: 30 });
    expect(
      resolveWholesalePerfumesStoreLimits({ storeLiveMaxPerDay: null, storeLiveMinMinutes: null }),
    ).toEqual({ maxPerDay: 24, minMinutes: 60 });
  });
});
