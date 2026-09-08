/**
 * Pure validation for PUT /api/vendors/:slug. No database imports.
 *
 * vat_rate is a fraction (0.21 = 21%), matching migration 013 and pricing.ts:
 * cost = vendorPrice × fxRate × (1 + vatRate).
 */

export interface VendorPatch {
  storefrontLabel?: string;
  /** null clears the override (fall back to global multiplier + price tiers). */
  priceMultiplier?: number | null;
  /** null clears the override (fall back to global stock threshold). */
  minVisibleStock?: number | null;
  fxRate?: number;
  vatRate?: number;
  /** null removes min_order_value_eur from order_config. */
  minOrderValueEur?: number | null;
  serviceableCountries?: string[];
  active?: boolean;
  liveMaxPerDay?: number | null;
  storeLiveMaxPerDay?: number | null;
  storeLiveMinMinutes?: number | null;
}

export type VendorPatchResult = { ok: true; patch: VendorPatch } | { ok: false; error: string };

const ISO_COUNTRY = /^[A-Z]{2}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseNonNegFinite(value: unknown, field: string): { ok: true; n: number } | { ok: false; error: string } {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, error: `${field} must be a finite non-negative number` };
    }
    return { ok: true, n: value };
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (t === "") return { ok: false, error: `${field} must be a finite non-negative number` };
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: `${field} must be a finite non-negative number` };
    }
    return { ok: true, n };
  }
  return { ok: false, error: `${field} must be a finite non-negative number` };
}

function parseNullableNonNeg(
  value: unknown,
  field: string,
): { ok: true; n: number | null } | { ok: false; error: string } {
  if (value === null || value === "") return { ok: true, n: null };
  return parseNonNegFinite(value, field);
}

function parseNullableInt(
  value: unknown,
  field: string,
): { ok: true; n: number | null } | { ok: false; error: string } {
  if (value === null || value === "") return { ok: true, n: null };
  const parsed = parseNonNegFinite(value, field);
  if (!parsed.ok) return parsed;
  if (!Number.isInteger(parsed.n)) {
    return { ok: false, error: `${field} must be a non-negative integer` };
  }
  return { ok: true, n: parsed.n };
}

/** Parse and validate a vendor update body. Rejects unknown shapes with a clear message. */
export function parseVendorPatch(body: unknown): VendorPatchResult {
  if (!isObject(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const patch: VendorPatch = {};
  const keys = Object.keys(body);
  if (keys.length === 0) {
    return { ok: false, error: "Empty patch — nothing to update" };
  }

  const allowed = new Set([
    "storefrontLabel",
    "priceMultiplier",
    "minVisibleStock",
    "fxRate",
    "vatRate",
    "minOrderValueEur",
    "serviceableCountries",
    "active",
    "liveMaxPerDay",
    "storeLiveMaxPerDay",
    "storeLiveMinMinutes",
  ]);
  for (const key of keys) {
    if (!allowed.has(key)) {
      return { ok: false, error: `Unknown field: ${key}` };
    }
  }

  if ("storefrontLabel" in body) {
    if (typeof body.storefrontLabel !== "string") {
      return { ok: false, error: "storefrontLabel must be a string" };
    }
    const label = body.storefrontLabel.trim();
    if (label.length === 0) {
      return { ok: false, error: "storefrontLabel must not be empty" };
    }
    if (label.length > 64) {
      return { ok: false, error: "storefrontLabel is too long (max 64)" };
    }
    patch.storefrontLabel = label;
  }

  if ("priceMultiplier" in body) {
    const r = parseNullableNonNeg(body.priceMultiplier, "priceMultiplier");
    if (!r.ok) return r;
    patch.priceMultiplier = r.n;
  }

  if ("minVisibleStock" in body) {
    const r = parseNullableInt(body.minVisibleStock, "minVisibleStock");
    if (!r.ok) return r;
    patch.minVisibleStock = r.n;
  }

  if ("fxRate" in body) {
    const r = parseNonNegFinite(body.fxRate, "fxRate");
    if (!r.ok) return r;
    if (r.n === 0) return { ok: false, error: "fxRate must be greater than zero" };
    patch.fxRate = r.n;
  }

  if ("vatRate" in body) {
    // Fraction uplift: 0.21 means +21%. Same interpretation as sil_vendors.vat_rate / pricing.ts.
    const r = parseNonNegFinite(body.vatRate, "vatRate");
    if (!r.ok) return r;
    patch.vatRate = r.n;
  }

  if ("minOrderValueEur" in body) {
    const r = parseNullableNonNeg(body.minOrderValueEur, "minOrderValueEur");
    if (!r.ok) return r;
    patch.minOrderValueEur = r.n;
  }

  if ("serviceableCountries" in body) {
    if (!Array.isArray(body.serviceableCountries)) {
      return { ok: false, error: "serviceableCountries must be an array of ISO country codes" };
    }
    const countries: string[] = [];
    for (const raw of body.serviceableCountries) {
      if (typeof raw !== "string") {
        return { ok: false, error: "serviceableCountries entries must be strings" };
      }
      const code = raw.trim().toUpperCase();
      if (!ISO_COUNTRY.test(code)) {
        return {
          ok: false,
          error: `Invalid country code "${raw}" — expected two-letter uppercase ISO (e.g. DE)`,
        };
      }
      if (!countries.includes(code)) countries.push(code);
    }
    patch.serviceableCountries = countries;
  }

  if ("active" in body) {
    if (typeof body.active !== "boolean") {
      return { ok: false, error: "active must be a boolean" };
    }
    patch.active = body.active;
  }

  if ("liveMaxPerDay" in body) {
    const r = parseNullableInt(body.liveMaxPerDay, "liveMaxPerDay");
    if (!r.ok) return r;
    patch.liveMaxPerDay = r.n;
  }

  if ("storeLiveMaxPerDay" in body) {
    const r = parseNullableInt(body.storeLiveMaxPerDay, "storeLiveMaxPerDay");
    if (!r.ok) return r;
    patch.storeLiveMaxPerDay = r.n;
  }

  if ("storeLiveMinMinutes" in body) {
    const r = parseNullableInt(body.storeLiveMinMinutes, "storeLiveMinMinutes");
    if (!r.ok) return r;
    patch.storeLiveMinMinutes = r.n;
  }

  return { ok: true, patch };
}
