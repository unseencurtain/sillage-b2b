/**
 * Resolve better product images when a vendor (especially BeautyFort) ships placeholders.
 *
 * Priority for a given EAN:
 *   1. data/image_overrides.json (hand-curated + wholesale-perfumes/shopify/oceanfragrances matches from the prior enricher)
 *   2. Another vendor's offer image for the same EAN (usually BTS)
 *
 * Cross-vendor fill runs for every product whose current URL is missing, a placeholder, or a
 * weak BeautyFort thumb — on both full and fast sync paths (caller must invoke resolve()).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sil } from "../config/env.ts";
import { query, type RowDataPacket } from "../db/pool.ts";
import { logger } from "../lib/log.ts";
import { isUnusableImage, normalizeEan, resolveImageUrl, indexOfferImages } from "./imageRules.ts";

export {
  isPlaceholderImage,
  isUnusableImage,
  isWeakVendorThumb,
  normalizeEan,
  resolveImageUrl,
  shouldHideForMissingImage,
  shopImageKey,
  displayedShopImage,
  thumbsNeedWrite,
  indexOfferImages,
} from "./imageRules.ts";

const log = logger("images");

let overridesCache: Map<string, string> | null = null;

export function loadImageOverrides(root = process.cwd()): Map<string, string> {
  if (overridesCache) return overridesCache;
  const path = join(root, "data", "image_overrides.json");
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(raw)) {
      const ean = normalizeEan(k);
      if (!ean || isUnusableImage(v)) continue;
      map.set(ean, v);
    }
    overridesCache = map;
    log.info(`loaded ${map.size} image overrides from ${path}`);
    return map;
  } catch (err) {
    log.warn(`image overrides not loaded: ${String(err)}`);
    overridesCache = new Map();
    return overridesCache;
  }
}

/** Build EAN → image from non-vanished offers that already have a real URL.

  Indexes **every** barcode on the offer, not only `primary_ean`. A BeautyFort
  row whose extra EAN matches a BTS photo would otherwise stay hidden.
 */
export async function loadOfferImageIndex(): Promise<Map<string, string>> {
  const rows = await query<
    RowDataPacket & { primary_ean: string | null; eans: unknown; image_url: string | null }
  >(
    `SELECT primary_ean, eans, image_url FROM ${sil("sil_offers")}
      WHERE vanished_at IS NULL
        AND image_url IS NOT NULL AND image_url != ''`,
  );
  return indexOfferImages(rows);
}

export interface ImageLookup {
  resolve(eans: string[], current: string | null): string | null;
}

export async function buildImageLookup(root = process.cwd()): Promise<ImageLookup> {
  const overrides = loadImageOverrides(root);
  const fromOffers = await loadOfferImageIndex();
  return {
    resolve(eans, current) {
      return resolveImageUrl(eans, current, overrides, fromOffers);
    },
  };
}
