/**
 * Pure pricing and visibility rules. No database imports — unit-testable against DATA-PROFILE edge cases.
 *
 * Storefront price is always cost × multiplier. Cost = vendorPrice × fxRate × (1 + vatRate).
 * Vendor recommended retail (RRP) is ignored: BTS publishes zeros on ~46% of rows and absurd
 * outliers (up to 42,795), so using RRP as a "was/now" strike-through misleads customers and hides
 * the multiplier effect.
 *
 * Multiplier precedence: per-vendor price_multiplier override > matching price tier > global multiplier.
 */

export interface PricingInput {
  vendorPrice: number;
  /** Accepted for API compatibility; never used for storefront price. */
  vendorRecommendedPrice: number | null;
  stock: number;
}

/** One cost band. `maxCost: null` means no upper bound and must be last after sorting. */
export interface PriceTier {
  maxCost: number | null;
  multiplier: number;
}

export interface PricingRules {
  /** Plain float. 0.5, 1.2 and 2 are all valid. Used when tiers are empty or none match. */
  multiplier: number;
  /**
   * Cost bands in ascending maxCost order (null-bound last). Empty when a per-vendor multiplier
   * override is in effect, or when the operator has not configured tiers.
   */
  priceTiers: PriceTier[];
  fxRate: number;
  /**
   * Fraction uplift applied before markup (wholesale-perfumes publishes price_no_vat). Default 0 so existing
   * vendors are unchanged: cost = vendorPrice × fxRate × (1 + vatRate).
   */
  vatRate: number;
  /** Inclusive: stock <= threshold hides the product. */
  stockThreshold: number;
  /** Kept for settings compatibility; unused after RRP was dropped. */
  maxRrpRatio: number;
}

export interface PricingResult {
  regularPrice: number;
  salePrice: number | null;
  effectivePrice: number;
  onSale: boolean;
  stock: number;
  stockStatus: "instock" | "outofstock";
  hidden: boolean;
}

export const DEFAULT_RULES: PricingRules = {
  multiplier: 1.0,
  priceTiers: [],
  fxRate: 1.0,
  vatRate: 0,
  stockThreshold: 0,
  maxRrpRatio: 10,
};

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Defensive parse of the `price_tiers` settings JSON. Malformed input never throws — invalid
 * entries are dropped and reported via `warnings`.
 */
export function parsePriceTiers(raw: unknown): { tiers: PriceTier[]; warnings: string[] } {
  const warnings: string[] = [];
  let list: unknown;

  if (raw === null || raw === undefined || raw === "") {
    return { tiers: [], warnings };
  }
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      warnings.push("price_tiers is not valid JSON; using empty tier list");
      return { tiers: [], warnings };
    }
  } else {
    list = raw;
  }

  if (!Array.isArray(list)) {
    warnings.push("price_tiers must be a JSON array; using empty tier list");
    return { tiers: [], warnings };
  }

  const parsed: PriceTier[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (!entry || typeof entry !== "object") {
      warnings.push(`price_tiers[${i}] is not an object; dropped`);
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const mult = Number(obj.multiplier);
    if (!Number.isFinite(mult) || mult < 0) {
      warnings.push(`price_tiers[${i}] has invalid multiplier; dropped`);
      continue;
    }
    let maxCost: number | null;
    if (obj.maxCost === null || obj.maxCost === undefined) {
      maxCost = null;
    } else {
      const n = Number(obj.maxCost);
      if (!Number.isFinite(n) || n < 0) {
        warnings.push(`price_tiers[${i}] has invalid maxCost; dropped`);
        continue;
      }
      maxCost = n;
    }
    parsed.push({ maxCost, multiplier: mult });
  }

  // Ascending maxCost; unbounded (null) last. Stable for equal bounds.
  parsed.sort((a, b) => {
    if (a.maxCost === null && b.maxCost === null) return 0;
    if (a.maxCost === null) return 1;
    if (b.maxCost === null) return -1;
    return a.maxCost - b.maxCost;
  });

  const unbounded = parsed.filter((t) => t.maxCost === null);
  if (unbounded.length > 1) {
    warnings.push("price_tiers has multiple unbounded tiers; keeping the last after sort");
    const bounded = parsed.filter((t) => t.maxCost !== null);
    return { tiers: [...bounded, unbounded[unbounded.length - 1]!], warnings };
  }

  return { tiers: parsed, warnings };
}

/** cost = vendorPrice × fxRate × (1 + vatRate); first tier with maxCost >= cost wins (null = always matches). */
export function resolveTierMultiplier(cost: number, rules: PricingRules): number {
  for (const tier of rules.priceTiers) {
    if (tier.maxCost === null || cost <= tier.maxCost) return tier.multiplier;
  }
  return rules.multiplier;
}

export function computePricing(input: PricingInput, rules: PricingRules): PricingResult {
  void input.vendorRecommendedPrice;
  void rules.maxRrpRatio;

  const vat = Number.isFinite(rules.vatRate) ? Math.max(0, rules.vatRate) : 0;
  const cost = input.vendorPrice * rules.fxRate * (1 + vat);
  const multiplier = resolveTierMultiplier(cost, rules);
  const computed = round2(cost * multiplier);
  // Never free: a tiny multiplier that rounds to 0 becomes 0.01.
  const price = computed > 0 ? computed : 0.01;
  const stock = Math.max(0, Math.trunc(input.stock));
  const hidden = stock <= rules.stockThreshold;

  return {
    regularPrice: price,
    salePrice: null,
    effectivePrice: price,
    onSale: false,
    stock,
    stockStatus: hidden || stock <= 0 ? "outofstock" : "instock",
    hidden,
  };
}

export function resolveRules(
  global: { multiplier: number; stockThreshold: number; maxRrpRatio: number; priceTiers: PriceTier[] },
  vendor: { priceMultiplier: number | null; minVisibleStock: number | null; fxRate: number; vatRate?: number },
): PricingRules {
  // Explicit per-vendor override wins over tiers; clear the list so computePricing uses multiplier.
  const hasVendorOverride = vendor.priceMultiplier != null;
  return {
    multiplier: vendor.priceMultiplier ?? global.multiplier,
    priceTiers: hasVendorOverride ? [] : global.priceTiers,
    fxRate: vendor.fxRate,
    vatRate: vendor.vatRate ?? 0,
    stockThreshold: vendor.minVisibleStock ?? global.stockThreshold,
    maxRrpRatio: global.maxRrpRatio,
  };
}
