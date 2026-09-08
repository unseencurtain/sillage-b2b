import type {
  FeedSource,
  NormalizedProduct,
  PriceStockUpdate,
  ProgressFn,
  VendorCategoryNode,
} from "./types.ts";

/**
 * The extensibility point. A new vendor implements `prepare`, `fetchRaw`, `normalize` and
 * `categories` — and needs zero PHP changes and zero schema changes.
 */
export abstract class VendorConnector {
  abstract readonly slug: string;
  abstract readonly skuPrefix: string;

  /**
   * Load anything `normalize` depends on — most importantly the category tree.
   */
  abstract prepare(source: FeedSource, progress?: ProgressFn): Promise<void>;

  /** The raw vendor records, exactly as the API returned them. */
  abstract fetchRaw(source: FeedSource, progress?: ProgressFn): Promise<unknown[]>;

  /** Convert one raw record. Return null to skip a record that cannot be used. */
  abstract normalize(raw: unknown): NormalizedProduct | null;

  /** The flattened category tree, available after `prepare`. */
  abstract categories(): VendorCategoryNode[];

  /**
   * Cheap price/stock delta, when the vendor offers one. wholesale-perfumes uses the hourly store XML.
   */
  fetchPriceStock?(since: Date, progress?: ProgressFn): Promise<PriceStockUpdate[] | null>;

  /**
   * Hydrate a small set of SKUs into normalized products.
   * Used to import SKUs that appear in a store-feed delta but have no offer row yet.
   */
  fetchNormalizedBySkus?(skus: string[], progress?: ProgressFn): Promise<NormalizedProduct[]>;

  /** Recently published vendor product ids + SKUs, when the vendor exposes a new-arrivals feed. */
  fetchNewProductKeys?(
    days: number,
    progress?: ProgressFn,
  ): Promise<Array<{ vendorProductId: string; sku: string }>>;

  /** Countries this vendor will ship to, when discoverable from the API. */
  fetchServiceableCountries?(): Promise<string[]>;

  protected makeSku(vendorProductId: string): string {
    return `${this.skuPrefix}-${vendorProductId}`;
  }
}
