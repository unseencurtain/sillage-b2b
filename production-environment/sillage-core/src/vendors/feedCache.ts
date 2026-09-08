/**
 * Persistent vendor feed cache.
 *
 * Live downloads are expensive (BeautyFort ~40 SOAP calls/day; BTS is heavily paginated).
 * Once a feed is fetched we keep it on disk and reuse it until the live gate allows a refresh.
 */
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../config/env.ts";
import { logger } from "../lib/log.ts";

const log = logger("feed-cache");

export type CacheVendor = "beautyfort" | "bts" | "wholesale-perfumes";

interface CacheMeta {
  vendor: CacheVendor;
  downloadedAt: string;
  rowCount: number;
}

function cacheDir(vendor: CacheVendor): string {
  return join(env.fixturesDir, "cache", vendor);
}

function dataPath(vendor: CacheVendor): string {
  return join(cacheDir(vendor), "feed.json");
}

function metaPath(vendor: CacheVendor): string {
  return join(cacheDir(vendor), "meta.json");
}

/** Optional envelope so BTS can persist categories and wholesale-perfumes can persist the store feed. */
export type FeedCachePayload =
  | unknown[]
  | { products: unknown[]; categories?: unknown[]; store?: unknown[] };

export async function writeFeedCache(vendor: CacheVendor, payload: FeedCachePayload): Promise<void> {
  await mkdir(cacheDir(vendor), { recursive: true });
  const rows = Array.isArray(payload) ? payload : payload.products;
  const meta: CacheMeta = {
    vendor,
    downloadedAt: new Date().toISOString(),
    rowCount: rows.length,
  };
  await writeFile(dataPath(vendor), JSON.stringify(payload));
  await writeFile(metaPath(vendor), JSON.stringify(meta, null, 2));
  log.info(`cached ${vendor} feed: ${rows.length} rows → ${dataPath(vendor)}`);
}

export async function readFeedCache(vendor: CacheVendor): Promise<FeedCachePayload | null> {
  try {
    const raw = await readFile(dataPath(vendor), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { products?: unknown }).products)
    ) {
      return parsed as { products: unknown[]; categories?: unknown[] };
    }
    return null;
  } catch {
    return null;
  }
}

export function feedCacheProducts(payload: FeedCachePayload): unknown[] {
  return Array.isArray(payload) ? payload : payload.products;
}

export function feedCacheCategories(payload: FeedCachePayload): unknown[] | null {
  if (Array.isArray(payload)) return null;
  return Array.isArray(payload.categories) ? payload.categories : null;
}

/** wholesale-perfumes hourly price/stock rows persisted beside the catalog. */
export function feedCacheStore(payload: FeedCachePayload): unknown[] | null {
  if (Array.isArray(payload)) return null;
  return Array.isArray(payload.store) ? payload.store : null;
}

export async function readFeedCacheMeta(vendor: CacheVendor): Promise<CacheMeta | null> {
  try {
    return JSON.parse(await readFile(metaPath(vendor), "utf8")) as CacheMeta;
  } catch {
    return null;
  }
}

/** Minutes since the cache file was written, or null when missing. */
export async function feedCacheAgeMinutes(vendor: CacheVendor): Promise<number | null> {
  try {
    const meta = await readFeedCacheMeta(vendor);
    if (meta?.downloadedAt) {
      const age = (Date.now() - new Date(meta.downloadedAt).getTime()) / 60_000;
      return Math.max(0, Math.floor(age));
    }
    const st = await stat(dataPath(vendor));
    return Math.max(0, Math.floor((Date.now() - st.mtimeMs) / 60_000));
  } catch {
    return null;
  }
}
