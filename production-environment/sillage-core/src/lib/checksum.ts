import { createHash } from "node:crypto";
import type { NormalizedProduct } from "../vendors/types.ts";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Fingerprint of everything we persist for an offer. Any change flips the offer to `pending`.
 * Field order is fixed so the hash is stable across runs and process restarts.
 */
export function offerChecksum(p: NormalizedProduct): string {
  return sha256(
    JSON.stringify([
      p.vendorProductId,
      p.name,
      p.description,
      p.brand,
      [...p.eans].sort(),
      [...p.categoryRefs].sort(),
      Object.entries(p.attributes).sort(([a], [b]) => a.localeCompare(b)),
      p.vendorPrice,
      p.vendorRecommendedPrice,
      p.stock,
      p.imageUrl,
      p.galleryUrls,
    ]),
  );
}

/**
 * Fingerprint of the fields a *content* write touches — post title, body, slug, terms, images.
 * Deliberately excludes price and stock so a price change does not trigger a full rewrite.
 */
export function contentHash(input: {
  name: string;
  description: string;
  slug: string;
  brand: string | null;
  categoryTtIds: number[];
  attributeTtIds: number[];
  imageUrl: string | null;
  galleryUrls: string[];
  sku: string;
  eans: string[];
}): string {
  return sha256(
    JSON.stringify([
      input.name,
      input.description,
      input.slug,
      input.brand,
      [...input.categoryTtIds].sort((a, b) => a - b),
      [...input.attributeTtIds].sort((a, b) => a - b),
      input.imageUrl,
      input.galleryUrls,
      input.sku,
      [...input.eans].sort(),
    ]),
  );
}

/** Fingerprint of the fields the 30-minute fast sync touches. */
export function priceHash(input: {
  regularPrice: number;
  salePrice: number | null;
  effectivePrice: number;
  stock: number;
  stockStatus: string;
  hidden: boolean;
}): string {
  return sha256(
    JSON.stringify([
      input.regularPrice,
      input.salePrice,
      input.effectivePrice,
      input.stock,
      input.stockStatus,
      input.hidden,
    ]),
  );
}

export { sha256 };
