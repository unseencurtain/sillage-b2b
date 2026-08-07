import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../../config/env.ts";
import { logger } from "../../lib/log.ts";
import {
  feedCacheProducts,
  feedCacheStore,
  readFeedCache,
  writeFeedCache,
} from "../feedCache.ts";
import {
  checkWholesalePerfumesStoreGate,
  recordLiveFetch,
  recordWholesalePerfumesStoreFetch,
  resolveLiveOrCache,
} from "../liveGate.ts";
import { VendorConnector } from "../VendorConnector.ts";
import type {
  FeedSource,
  NormalizedProduct,
  PriceStockUpdate,
  ProgressFn,
  VendorCategoryNode,
} from "../types.ts";
import {
  WholesalePerfumesClient,
  parseCatalogXml,
  parseStoreXml,
  type WholesalePerfumesCatalogProduct,
  type WholesalePerfumesStoreProduct,
} from "./WholesalePerfumesClient.ts";

const log = logger("wholesale-perfumes");

const GENDER_MAP: Record<string, string> = {
  m: "Men",
  man: "Men",
  men: "Men",
  male: "Men",
  f: "Women",
  w: "Women",
  woman: "Women",
  women: "Women",
  female: "Women",
  u: "Unisex",
  unisex: "Unisex",
  kids: "Kids",
  kid: "Kids",
  children: "Kids",
};

/** Joined catalog+store row passed through normalize. */
export interface WholesalePerfumesJoinedRaw extends WholesalePerfumesCatalogProduct {
  priceNoVat: number;
  quantity: number;
}

export function composeWholesalePerfumesName(p: Pick<WholesalePerfumesCatalogProduct, "brand" | "series" | "model" | "nameAddon">): string {
  return [p.brand, p.series, p.model, p.nameAddon]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatWholesalePerfumesVolume(volume: string | null, unit: string | null): string | null {
  if (!volume) return null;
  const n = volume.trim();
  if (!n) return null;
  const u = (unit ?? "ml").trim() || "ml";
  return `${n} ${u}`;
}

export function mapWholesalePerfumesGender(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  return GENDER_MAP[raw.trim().toLowerCase()];
}

export function joinCatalogAndStore(
  catalog: WholesalePerfumesCatalogProduct[],
  store: WholesalePerfumesStoreProduct[],
): WholesalePerfumesJoinedRaw[] {
  const byId = new Map(store.map((s) => [s.id, s]));
  const out: WholesalePerfumesJoinedRaw[] = [];
  for (const c of catalog) {
    const s = byId.get(c.id);
    out.push({
      ...c,
      priceNoVat: s?.priceNoVat ?? c.priceNoVat ?? 0,
      quantity: s?.quantity ?? c.quantity ?? 0,
    });
  }
  return out;
}

export class WholesalePerfumesConnector extends VendorConnector {
  readonly slug = "wholesale-perfumes";
  /** Unused by BF / BTS; storefront label LPS03 is separate. */
  readonly skuPrefix = "WPF";

  private categoryNodes = new Map<string, VendorCategoryNode>();

  async prepare(_source: FeedSource, _progress?: ProgressFn): Promise<void> {
    this.categoryNodes.clear();
  }

  async fetchRaw(source: FeedSource, progress?: ProgressFn): Promise<unknown[]> {
    if (source === "local") {
      const catalogPath = join(env.fixturesDir, "wholesale_perfumes_catalog.xml");
      const storePath = join(env.fixturesDir, "wholesale_perfumes_store.xml");
      const bundledCatalog = join(env.rootDir, "tests/fixtures/wholesale_perfumes_catalog.xml");
      const bundledStore = join(env.rootDir, "tests/fixtures/wholesale_perfumes_store.xml");
      progress?.(`reading wholesale-perfumes fixtures`);
      let catalogXml: string;
      try {
        catalogXml = await readFile(catalogPath, "utf8");
      } catch {
        catalogXml = await readFile(bundledCatalog, "utf8");
        progress?.(`fixturesDir miss — using bundled sample ${bundledCatalog}`);
      }
      const catalog = parseCatalogXml(catalogXml);
      let store: WholesalePerfumesStoreProduct[] = [];
      try {
        store = parseStoreXml(await readFile(storePath, "utf8"));
      } catch {
        try {
          store = parseStoreXml(await readFile(bundledStore, "utf8"));
        } catch {
          log.warn("wholesale_perfumes_store.xml missing — catalog rows will have zero price/stock");
        }
      }
      const joined = joinCatalogAndStore(catalog, store);
      log.info(`loaded ${joined.length} wholesale-perfumes products from fixtures`);
      return joined;
    }

    if (source === "cache") {
      const cached = await readFeedCache("wholesale-perfumes");
      if (!cached) throw new Error("no wholesale-perfumes feed cache — run one live sync first");
      const catalog = feedCacheProducts(cached) as WholesalePerfumesCatalogProduct[];
      const store = (feedCacheStore(cached) as WholesalePerfumesStoreProduct[] | null) ?? [];
      progress?.(`using cached wholesale-perfumes feed (${catalog.length} catalog, ${store.length} store)`);
      return joinCatalogAndStore(catalog, store);
    }

    const resolved = await resolveLiveOrCache("wholesale-perfumes", "live");
    if (resolved.mode === "cache") {
      const cached = await readFeedCache("wholesale-perfumes");
      if (cached) {
        const catalog = feedCacheProducts(cached) as WholesalePerfumesCatalogProduct[];
        const store = (feedCacheStore(cached) as WholesalePerfumesStoreProduct[] | null) ?? [];
        progress?.(
          `live gated (${resolved.gate?.reason ?? "rate limit"}) — cache (${catalog.length} rows)`,
        );
        return joinCatalogAndStore(catalog, store);
      }
      log.warn("live gated and no cache — forcing one wholesale-perfumes catalog download");
    }

    progress?.("downloading wholesale-perfumes catalog XML (daily)");
    const client = this.client();
    const catalog = await client.fetchCatalog();
    progress?.("downloading wholesale-perfumes store XML (price/stock)");
    const store = await client.fetchStore();
    log.info(`downloaded wholesale-perfumes catalog=${catalog.length} store=${store.length}`);
    await writeFeedCache("wholesale-perfumes", { products: catalog, store });
    await recordLiveFetch("wholesale-perfumes");
    await recordWholesalePerfumesStoreFetch();
    return joinCatalogAndStore(catalog, store);
  }

  normalize(raw: unknown): NormalizedProduct | null {
    const r = raw as WholesalePerfumesJoinedRaw;
    const vendorProductId = String(r.id ?? "").trim();
    if (!vendorProductId) return null;

    const name = composeWholesalePerfumesName(r);
    if (!name) return null;

    const vendorPrice = Number(r.priceNoVat);
    if (!Number.isFinite(vendorPrice) || vendorPrice <= 0) return null;

    const eans = [...new Set((r.allEans ?? []).map((e) => String(e).trim()).filter((e) => /^\d+$/.test(e)))];

    // Browse categories = product type only (Eau de Parfum, Blush, …). Brands already map to
    // WooCommerce `product_brand` via `brand` below — nesting them under product_cat produced the
    // A–Z brand dump in the /b2b-wholesale/ sidebar.
    const categoryRefs: string[] = [];
    if (r.typeId || r.typeName) {
      const key = r.typeId ? `type:${r.typeId}` : `type:${r.typeName}`;
      const label = (r.typeName ?? r.typeId ?? "").trim() || key;
      this.ensureCategory(key, label, null);
      categoryRefs.push(key);
    }

    const attributes: Record<string, string> = {};
    const typeLabel = (r.typeName ?? "").trim();
    if (typeLabel) attributes["type"] = typeLabel;
    const volume = formatWholesalePerfumesVolume(r.volume, r.volumeUnit);
    if (volume) attributes["volume"] = volume;
    const gender = mapWholesalePerfumesGender(r.gender);
    if (gender) attributes["gender"] = gender;

    const imageUrl = (r.flaskFront ?? "").trim() || null;
    const stock = Number(r.quantity);

    return {
      vendorSlug: this.slug,
      vendorProductId,
      sku: this.makeSku(vendorProductId),
      eans,
      name,
      description: (r.setComposition ?? "").trim(),
      brand: (r.brand ?? "").trim() || null,
      categoryRefs,
      attributes,
      vendorPrice,
      vendorRecommendedPrice: null,
      stock: Number.isFinite(stock) ? Math.max(0, Math.trunc(stock)) : 0,
      imageUrl,
      galleryUrls: [],
      extra: {
        typeInfo: r.typeInfo,
        series: r.series,
        model: r.model,
        nameAddon: r.nameAddon,
        scents: r.scents,
        params: r.params,
      },
    };
  }

  categories(): VendorCategoryNode[] {
    return [...this.categoryNodes.values()];
  }

  /**
   * Hourly store feed alone — genuine cheap delta. Uses its own live gate (not the catalog
   * once-per-day cap). Never hits the network when source is local (caller only invokes on live).
   */
  override async fetchPriceStock(_since: Date, progress?: ProgressFn): Promise<PriceStockUpdate[] | null> {
    const gate = await checkWholesalePerfumesStoreGate();
    if (!gate.allow) {
      progress?.(`store gated: ${gate.reason}`);
      const cached = await readFeedCache("wholesale-perfumes");
      const store = cached ? feedCacheStore(cached) : null;
      if (Array.isArray(store) && store.length > 0) {
        progress?.(`using cached store feed (${store.length} rows)`);
        return (store as WholesalePerfumesStoreProduct[]).map((s) => ({
          vendorProductId: s.id,
          price: s.priceNoVat,
          recommendedPrice: null,
          stock: s.quantity,
        }));
      }
      return null;
    }

    progress?.("downloading wholesale-perfumes store XML");
    const store = await this.client().fetchStore();
    const cached = await readFeedCache("wholesale-perfumes");
    const catalog = cached ? feedCacheProducts(cached) : [];
    await writeFeedCache("wholesale-perfumes", {
      products: Array.isArray(catalog) ? catalog : [],
      store,
    });
    await recordWholesalePerfumesStoreFetch();
    log.info(`wholesale-perfumes store delta: ${store.length} rows`);

    return store.map((s) => ({
      vendorProductId: s.id,
      price: s.priceNoVat,
      recommendedPrice: null,
      stock: s.quantity,
    }));
  }

  private ensureCategory(key: string, name: string, parentKey: string | null): void {
    if (this.categoryNodes.has(key)) return;
    this.categoryNodes.set(key, { key, name, parentKey });
  }

  private client(): WholesalePerfumesClient {
    return new WholesalePerfumesClient({
      user: env.wholesalePerfumes.user,
      token: env.wholesalePerfumes.token,
      catalogUrl: env.wholesalePerfumes.catalogUrl,
      storeUrl: env.wholesalePerfumes.storeUrl,
      apiBaseUrl: env.wholesalePerfumes.apiBaseUrl,
    });
  }
}
