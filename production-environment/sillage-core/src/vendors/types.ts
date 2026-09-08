/**
 * Where a connector reads its feed from.
 * - `live` — vendor API, subject to the per-vendor call interval; blocked (no silent cache) when cooling
 * - `cache` — on-disk feed from the last successful live download (never hits the vendor)
 * - `local` — checked-in fixtures under `.feedscratch` (offline tests)
 */
export type FeedSource = "live" | "local" | "cache";

/**
 * The vendor-agnostic product shape. Nothing vendor-specific may leak past a connector — that is
 * what makes onboarding vendor #3 a single new file.
 */
export interface NormalizedProduct {
  vendorSlug: string;
  /** BTS: String(id). BeautyFort: StockCode. */
  vendorProductId: string;
  /** `{PREFIX}-{vendorProductId}`. Unique across vendors by construction. */
  sku: string;
  /** Always an array, always strings. BeautyFort rows carry up to 26; leading zeros matter. */
  eans: string[];
  name: string;
  /** Empty on 100% of records from both vendors today. Kept so `description_mode` can fill it. */
  description: string;
  brand: string | null;
  /** Keys into the connector's category node set. BTS: numeric ids. BeautyFort: full path. */
  categoryRefs: string[];
  /** Attribute slug -> human label, e.g. `{ gender: 'Women', type: 'Eau de Parfum' }`. */
  attributes: Record<string, string>;
  vendorPrice: number;
  vendorRecommendedPrice: number | null;
  stock: number;
  imageUrl: string | null;
  galleryUrls: string[];
  /** Vendor extras retained for later phases: flammable, lead time, collection, size. */
  extra: Record<string, unknown>;
}

/**
 * A node in a vendor's category tree, flattened. Both a numeric ID tree (BTS) and a
 * `>`-delimited text path (BeautyFort) reduce to this, so one resolver handles both.
 */
export interface VendorCategoryNode {
  /** Stable key referenced by `NormalizedProduct.categoryRefs`. */
  key: string;
  /** Display name for this node alone, not the full path. */
  name: string;
  parentKey: string | null;
}

/** A price/stock-only update, used by the 30-minute fast sync. */
export interface PriceStockUpdate {
  vendorProductId: string;
  /** Vendor SKU / EAN when the delta endpoint provides one (BTS `product_sku`). */
  sku?: string;
  price: number;
  recommendedPrice: number | null;
  stock: number;
}

export interface FetchStats {
  fetched: number;
  skipped: number;
  durationMs: number;
}

export type ProgressFn = (message: string) => void;
