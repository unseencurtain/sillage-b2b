import { sil } from "../config/env.ts";
import { execute, query, transaction, type PoolConnection, type RowDataPacket } from "../db/pool.ts";
import type { GlobalSettings, Vendor } from "../db/settings.ts";
import { offerChecksum } from "../lib/checksum.ts";
import { logger } from "../lib/log.ts";
import type { NormalizedProduct } from "../vendors/types.ts";

const log = logger("diff");

export interface DiffResult {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  vanished: number;
}

interface ExistingRow extends RowDataPacket {
  id: number;
  vendor_product_id: string;
  checksum: string;
  vanished_at: string | null;
}

/** Rows per multi-row statement. Offers are wide, so this stays well under max_allowed_packet. */
const UPSERT_BATCH = 400;

/**
 * Reconcile a vendor's normalized feed against `sil_offers`.
 *
 * Runs in three passes: upsert what the feed contains, mark what it no longer contains as
 * vanished, then resolve offers to storefront products.
 */
export async function diffOffers(
  vendor: Vendor,
  products: NormalizedProduct[],
  runId: number,
  options?: { vanish?: boolean },
): Promise<DiffResult> {
  const existing = new Map<string, ExistingRow>();
  for (const row of await query<ExistingRow>(
    `SELECT id, vendor_product_id, checksum, vanished_at FROM ${sil("sil_offers")} WHERE vendor_id = ?`,
    [vendor.id],
  )) {
    existing.set(row.vendor_product_id, row);
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  const toWrite: Array<{ product: NormalizedProduct; checksum: string; isNew: boolean }> = [];
  const touchOnly: number[] = [];

  const seen = new Set<string>();
  for (const product of products) {
    // A vendor feed can repeat an id; first occurrence wins so the run stays deterministic.
    if (seen.has(product.vendorProductId)) continue;
    seen.add(product.vendorProductId);

    const checksum = offerChecksum(product);
    const prior = existing.get(product.vendorProductId);

    if (!prior) {
      toWrite.push({ product, checksum, isNew: true });
      created++;
    } else if (prior.checksum !== checksum || prior.vanished_at !== null) {
      // A product that reappears after vanishing counts as an update, and clears vanished_at.
      toWrite.push({ product, checksum, isNew: false });
      updated++;
    } else {
      touchOnly.push(prior.id);
      unchanged++;
    }
  }

  for (let i = 0; i < toWrite.length; i += UPSERT_BATCH) {
    const slice = toWrite.slice(i, i + UPSERT_BATCH);
    await transaction((conn) => upsertOffers(conn, vendor.id, runId, slice));
  }

  // Unchanged rows still need their run marker bumped, or the sweep below would delist them.
  for (let i = 0; i < touchOnly.length; i += 2000) {
    const ids = touchOnly.slice(i, i + 2000);
    await execute(
      `UPDATE ${sil("sil_offers")} SET last_seen_at = NOW(), last_seen_run_id = ?
        WHERE id IN (${ids.map(() => "?").join(",")})`,
      [runId, ...ids],
    );
  }

  const vanished = options?.vanish === false ? 0 : await markVanished(vendor.id, runId);

  log.info(
    `${vendor.slug}: ${products.length} fetched, ${created} new, ${updated} updated, ` +
      `${unchanged} unchanged, ${vanished} vanished`,
  );

  return { fetched: products.length, created, updated, unchanged, vanished };
}

async function upsertOffers(
  conn: PoolConnection,
  vendorId: number,
  runId: number,
  rows: Array<{ product: NormalizedProduct; checksum: string }>,
): Promise<void> {
  const placeholders: string[] = [];
  const params: unknown[] = [];

  for (const { product: p, checksum } of rows) {
    placeholders.push("(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW(),?)");
    params.push(
      vendorId,
      p.vendorProductId,
      p.sku,
      p.eans[0] ?? null,
      JSON.stringify(p.eans),
      p.name.slice(0, 500),
      p.description || null,
      p.brand?.slice(0, 191) ?? null,
      JSON.stringify(p.categoryRefs),
      JSON.stringify(p.attributes),
      p.vendorPrice,
      p.vendorRecommendedPrice,
      p.stock,
      p.imageUrl?.slice(0, 1000) ?? null,
      JSON.stringify(p.galleryUrls),
      JSON.stringify(p.extra),
      checksum,
      runId,
    );
  }

  await conn.query(
    `INSERT INTO ${sil("sil_offers")}
       (vendor_id, vendor_product_id, sku, primary_ean, eans, name, description, brand,
        category_refs, attributes, vendor_price, vendor_recommended_price, stock,
        image_url, gallery_urls, extra, checksum, first_seen_at, last_seen_at, last_seen_run_id)
     VALUES ${placeholders.join(",")}
     ON DUPLICATE KEY UPDATE
       sku = VALUES(sku),
       primary_ean = VALUES(primary_ean),
       eans = VALUES(eans),
       name = VALUES(name),
       description = VALUES(description),
       brand = VALUES(brand),
       category_refs = VALUES(category_refs),
       attributes = VALUES(attributes),
       vendor_price = VALUES(vendor_price),
       vendor_recommended_price = VALUES(vendor_recommended_price),
       stock = VALUES(stock),
       image_url = VALUES(image_url),
       gallery_urls = VALUES(gallery_urls),
       extra = VALUES(extra),
       checksum = VALUES(checksum),
       status = 'pending',
       last_error = NULL,
       vanished_at = NULL,
       last_seen_at = NOW(),
       last_seen_run_id = VALUES(last_seen_run_id)`,
    params,
  );
}

/**
 * Anything not touched by this run has left the feed. Soft-hide it by zeroing stock rather than
 * deleting, so order history is never orphaned. It then flows through the ordinary
 * stock-threshold visibility rule with no separate code path.
 */
async function markVanished(vendorId: number, runId: number): Promise<number> {
  const result = await execute(
    `UPDATE ${sil("sil_offers")}
        SET stock = 0, vanished_at = NOW(), status = 'pending'
      WHERE vendor_id = ?
        AND (last_seen_run_id IS NULL OR last_seen_run_id <> ?)
        AND vanished_at IS NULL`,
    [vendorId, runId],
  );
  return result.affectedRows;
}

/**
 * Attach every offer to a `sil_products` row.
 *
 * With dedupe on, offers sharing an EAN collapse into one storefront product — 2,646 EANs appear
 * in both vendor feeds, so without this the catalogue carries that many duplicate listings.
 */
export async function resolveProductIdentities(settings: GlobalSettings): Promise<number> {
  // Materialise the identity key onto each offer first. Doing this in a set-based UPDATE keeps it
  // to one pass, and makes the join below an indexed column-to-column comparison rather than a
  // nested loop over an unindexable expression.
  const identityExpr = settings.dedupeByEan
    ? `CASE WHEN o.primary_ean IS NOT NULL AND o.primary_ean <> ''
              THEN CONCAT('ean:', o.primary_ean)
              ELSE CONCAT(v.slug, ':', o.vendor_product_id) END`
    : `CONCAT(v.slug, ':', o.vendor_product_id)`;

  // Recomputed for every offer, not just pending ones, so toggling dedupe_by_ean in the dashboard
  // re-keys the whole catalogue on the next full sync.
  await execute(
    `UPDATE ${sil("sil_offers")} o
       JOIN ${sil("sil_vendors")} v ON v.id = o.vendor_id
        SET o.identity_key = ${identityExpr}
      WHERE o.identity_key IS NULL OR o.identity_key <> ${identityExpr}`,
  );

  // Create any missing product shell. INSERT IGNORE relies on the unique key on identity_key.
  await execute(
    `INSERT IGNORE INTO ${sil("sil_products")} (identity_key)
     SELECT DISTINCT o.identity_key
       FROM ${sil("sil_offers")} o
      WHERE o.identity_key IS NOT NULL`,
  );

  const linked = await execute(
    `UPDATE ${sil("sil_offers")} o
       JOIN ${sil("sil_products")} p ON p.identity_key = o.identity_key
        SET o.product_id = p.id
      WHERE o.product_id IS NULL OR o.product_id <> p.id`,
  );

  return linked.affectedRows;
}

/**
 * Choose which offer represents each product.
 *
 * Only offers that are in stock, from an active vendor, count as candidates. Vendor shipping
 * coverage is deliberately *not* applied here: coverage depends on the customer's destination,
 * which is unknown at sync time. The order dispatcher re-picks per destination.
 */
export async function selectPrimaryOffers(settings: GlobalSettings): Promise<number> {
  const order =
    settings.primaryOfferStrategy === "most_stock"
      ? "o.stock DESC, o.vendor_price ASC, o.id ASC"
      : "o.vendor_price ASC, o.stock DESC, o.id ASC";

  // Rank in-stock offers per product, falling back to any offer when everything is out of stock
  // so the product still exists (hidden) rather than disappearing.
  const result = await execute(
    `UPDATE ${sil("sil_products")} p
       JOIN (
         SELECT product_id, offer_id FROM (
           SELECT o.product_id,
                  o.id AS offer_id,
                  ROW_NUMBER() OVER (
                    PARTITION BY o.product_id
                    ORDER BY (o.stock > 0) DESC, ${order}
                  ) AS rn
             FROM ${sil("sil_offers")} o
             JOIN ${sil("sil_vendors")} v ON v.id = o.vendor_id AND v.active = 1
            WHERE o.product_id IS NOT NULL
         ) ranked WHERE rn = 1
       ) best ON best.product_id = p.id
        SET p.primary_offer_id = best.offer_id,
            p.needs_content_write = 1,
            p.needs_price_write = 1
      WHERE p.primary_offer_id IS NULL OR p.primary_offer_id <> best.offer_id`,
  );

  return result.affectedRows;
}

/**
 * Flag products whose winning offer changed in this run, so the writer knows what to touch.
 * Products whose offers were all unchanged stay clean and cost nothing.
 */
export async function markDirtyFromPendingOffers(): Promise<number> {
  const result = await execute(
    `UPDATE ${sil("sil_products")} p
       JOIN ${sil("sil_offers")} o ON o.product_id = p.id AND o.status = 'pending'
        SET p.needs_content_write = 1, p.needs_price_write = 1`,
  );
  return result.affectedRows;
}

/** Fast path: push pending offer price/stock to WooCommerce without a content rewrite. */
export async function markPriceDirtyFromPendingOffers(): Promise<number> {
  const result = await execute(
    `UPDATE ${sil("sil_products")} p
       JOIN ${sil("sil_offers")} o ON o.product_id = p.id AND o.status = 'pending'
        SET p.needs_price_write = 1`,
  );
  return result.affectedRows;
}

/** Share of non-vanished offers whose last_seen_at is older than `olderThanHours`. */
export async function staleOfferRatio(vendorId: number, olderThanHours: number): Promise<number> {
  const hours = Math.max(1, Math.trunc(olderThanHours));
  const [row] = await query<RowDataPacket & { stale: number; total: number }>(
    `SELECT
        SUM(CASE WHEN last_seen_at < DATE_SUB(NOW(), INTERVAL ${hours} HOUR) THEN 1 ELSE 0 END) AS stale,
        COUNT(*) AS total
       FROM ${sil("sil_offers")}
      WHERE vendor_id = ? AND vanished_at IS NULL`,
    [vendorId],
  );
  if (!row || !row.total) return 0;
  return Number(row.stale) / Number(row.total);
}

export async function existingVendorProductIds(
  vendorId: number,
  ids: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    const rows = await query<RowDataPacket & { vendor_product_id: string }>(
      `SELECT vendor_product_id FROM ${sil("sil_offers")}
        WHERE vendor_id = ? AND vendor_product_id IN (${slice.map(() => "?").join(",")})`,
      [vendorId, ...slice],
    );
    for (const r of rows) found.add(r.vendor_product_id);
  }
  return found;
}

/** Fast-sync path: apply a price/stock delta straight onto offers, skipping the full feed. */
export async function applyPriceStockDelta(
  vendorId: number,
  updates: Array<{ vendorProductId: string; price: number; recommendedPrice: number | null; stock: number }>,
): Promise<number> {
  if (updates.length === 0) return 0;

  let changed = 0;
  for (let i = 0; i < updates.length; i += 500) {
    const slice = updates.slice(i, i + 500);
    await transaction(async (conn) => {
      for (const u of slice) {
        const [res] = await conn.query(
          `UPDATE ${sil("sil_offers")}
              SET vendor_price = ?, vendor_recommended_price = ?, stock = ?,
                  status = 'pending', last_seen_at = NOW(), vanished_at = NULL
            WHERE vendor_id = ? AND vendor_product_id = ?
              AND (vendor_price <> ? OR stock <> ?
                   OR NOT (vendor_recommended_price <=> ?))`,
          [
            u.price,
            u.recommendedPrice,
            u.stock,
            vendorId,
            u.vendorProductId,
            u.price,
            u.stock,
            u.recommendedPrice,
          ],
        );
        changed += (res as { affectedRows: number }).affectedRows;
      }
    });
  }
  return changed;
}
