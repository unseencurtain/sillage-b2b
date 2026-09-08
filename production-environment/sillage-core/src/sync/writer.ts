import { serialize } from "php-serialize";
import { env, sil, wp } from "../config/env.ts";
import { bulkInsert, deleteByIds } from "../db/bulk.ts";
import { execute, query, transaction, type PoolConnection, type RowDataPacket } from "../db/pool.ts";
import type { GlobalSettings, Vendor } from "../db/settings.ts";
import { contentHash, priceHash } from "../lib/checksum.ts";
import { logger } from "../lib/log.ts";
import { foldKey, productSlug } from "../lib/slugify.ts";
import { throwIfSyncAborted } from "./abort.ts";
import {
  buildImageLookup,
  shouldHideForMissingImage,
  thumbsNeedWrite,
  type ImageLookup,
} from "./images.ts";
import { computePricing, resolveRules, type PricingResult } from "./pricing.ts";
import {
  ATTRIBUTE_TAXONOMIES,
  BRAND_TAXONOMY,
  LEGACY_VENDOR_ATTRIBUTE_TAXONOMY,
  loadProductTypeTerm,
  loadVisibilityTerms,
  type TermRef,
} from "./taxonomy.ts";
import { normalizeVolume } from "./volume.ts";

const log = logger("writer");

/**
 * Meta keys this writer owns.
 *
 * `wp_postmeta` has no unique key on (post_id, meta_key), so ON DUPLICATE KEY UPDATE is not
 * available and adding an index to a WordPress core table is off-limits. Instead we delete exactly
 * these keys for the batch and re-insert, which leaves any other plugin's meta untouched.
 *
 * `_thumbnail_id` is deliberately absent: there are no attachments, images are external URLs.
 */
const MANAGED_META_KEYS = [
  "_sku",
  "_global_unique_id",
  "_regular_price",
  "_sale_price",
  "_price",
  "_stock",
  "_stock_status",
  "_manage_stock",
  "_backorders",
  "_tax_status",
  "_tax_class",
  "_virtual",
  "_downloadable",
  "_sold_individually",
  "_weight",
  "_length",
  "_width",
  "_height",
  "_product_attributes",
  "_product_version",
  "_wc_review_count",
  "_wc_average_rating",
  "_sillage_vendor",
  "_sillage_vendor_product_id",
  "_sillage_offer_id",
  "_sillage_ship_countries",
  "_external_thumbnail_url",
  "_external_gallery_urls",
] as const;

/** The subset the 30-minute fast sync rewrites (includes image so cross-vendor fill can land). */
const PRICE_META_KEYS = [
  "_regular_price",
  "_sale_price",
  "_price",
  "_stock",
  "_stock_status",
  "_external_thumbnail_url",
] as const;

/** Taxonomies the writer owns. A term outside this list is never removed from a product. */
const OWNED_TAXONOMIES = [
  "product_cat",
  "product_type",
  BRAND_TAXONOMY,
  "product_visibility",
  ...Object.values(ATTRIBUTE_TAXONOMIES),
  // Clear leftover LPS lane terms; never re-assigned (see purgeVendorProductAttributes).
  LEGACY_VENDOR_ATTRIBUTE_TAXONOMY,
];

export type WriteMode = "full" | "fast";

export interface WriteContext {
  settings: GlobalSettings;
  vendorsById: Map<number, Vendor>;
  categoryMaps: Map<number, Map<string, TermRef>>;
  brandMap: Map<string, TermRef>;
  attributeMaps: Map<string, Map<string, TermRef>>;
  visibility: Record<string, TermRef>;
  productType: TermRef;
  /** Global attribute taxonomies the plugin has actually registered in WooCommerce. */
  activeAttributeTaxonomies: Set<string>;
  images: ImageLookup;
}

export interface WriteResult {
  postsCreated: number;
  postsUpdated: number;
  pricesUpdated: number;
  skipped: number;
  errors: number;
  /** Products excluded from catalog/search because the resolved image was still unusable. */
  hiddenNoImage: number;
}

interface PendingRow extends RowDataPacket {
  product_id: number;
  identity_key: string;
  wp_post_id: number | null;
  applied_content_hash: string | null;
  applied_price_hash: string | null;
  offer_id: number;
  vendor_id: number;
  vendor_product_id: string;
  sku: string;
  eans: string | string[];
  name: string;
  description: string | null;
  brand: string | null;
  category_refs: string | string[];
  attributes: string | Record<string, string>;
  extra: string | Record<string, unknown> | null;
  vendor_price: string;
  vendor_recommended_price: string | null;
  stock: number;
  image_url: string | null;
  gallery_urls: string | string[];
  /** Woo `_external_thumbnail_url` — what the shop actually renders. */
  wp_thumb_url: string | null;
  /** Dashboard “Keep hidden” pin — survives the next rewrite. */
  operator_hidden: number;
}

interface PreparedProduct {
  productId: number;
  identityKey: string;
  postId: number | null;
  offerId: number;
  vendorSlug: string;
  vendorProductId: string;
  sku: string;
  name: string;
  description: string;
  slug: string;
  eans: string[];
  imageUrl: string | null;
  galleryUrls: string[];
  categoryTtIds: number[];
  attributeTerms: Array<{ taxonomy: string; termId: number; ttId: number }>;
  brandTtId: number | null;
  /** ISO country codes this vendor can ship to — used by checkout country filter. */
  shipCountries: string[];
  pricing: PricingResult;
  /** True when hidden solely (or also) because the resolved image is missing/placeholder. */
  hiddenNoImage: boolean;
  contentHash: string | null;
  priceHash: string;
  /** Rewrite title, body, slug, terms, images. Always true for a product being created. */
  writeContent: boolean;
  /** Rewrite price, stock and visibility. */
  writePrice: boolean;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/**
 * WooCommerce's `_product_attributes` is a PHP-serialized associative array, not JSON. Getting the
 * shape wrong leaves the wp-admin attributes tab blank while the storefront still renders, which
 * is a very quiet failure.
 */
function serializeProductAttributes(terms: Array<{ taxonomy: string }>): string {
  const attributes: Record<string, Record<string, string | number>> = {};
  let position = 0;
  for (const term of terms) {
    if (attributes[term.taxonomy]) continue;
    attributes[term.taxonomy] = {
      name: term.taxonomy,
      // Empty for taxonomy-backed attributes — the assigned terms carry the values.
      value: "",
      position: position++,
      is_visible: 1,
      is_variation: 0,
      is_taxonomy: 1,
    };
  }
  return serialize(attributes);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Vendor feeds ship empty descriptions. Default: duplicate the title into the body so the product
 * page is never blank. `template` still builds a short structured paragraph when enabled.
 */
function buildDescription(input: {
  name: string;
  brand: string | null;
  attributes: Record<string, string>;
  extra: Record<string, unknown>;
  mode: GlobalSettings["descriptionMode"];
  existing: string;
}): string {
  // Always prefer a non-empty title mirror over leaving WooCommerce blank.
  if (input.mode === "none" || input.mode !== "template") {
    return `<p>${escapeHtml(input.name)}</p>`;
  }

  const type = input.attributes["type"];
  const volume = input.attributes["volume"];
  const gender = input.attributes["gender"];
  const collection = typeof input.extra["collection"] === "string" ? input.extra["collection"] : null;
  const lead = [input.brand, collection && collection !== input.brand ? collection : null]
    .filter(Boolean)
    .join(" ");

  return (
    `<p><strong>${escapeHtml(input.name)}</strong>` +
    (lead ? ` by ${escapeHtml(lead)}` : "") +
    (type ? `, a ${escapeHtml(type.toLowerCase())}` : "") +
    (volume ? ` in a ${escapeHtml(volume)} size` : "") +
    (gender ? `, created for ${escapeHtml(gender.toLowerCase())}` : "") +
    ".</p>\n<p>Genuine product, sourced directly from an authorised European distributor.</p>"
  );
}

export async function buildWriteContext(
  settings: GlobalSettings,
  vendors: Vendor[],
  categoryMaps: Map<number, Map<string, TermRef>>,
  brandMap: Map<string, TermRef>,
  attributeMaps: Map<string, Map<string, TermRef>>,
): Promise<WriteContext> {
  const active = new Set<string>();
  for (const row of await query<RowDataPacket & { attribute_name: string }>(
    `SELECT attribute_name FROM ${wp("woocommerce_attribute_taxonomies")}`,
  )) {
    active.add(`pa_${row.attribute_name}`);
  }

  return {
    settings,
    vendorsById: new Map(vendors.map((v) => [v.id, v])),
    categoryMaps,
    brandMap,
    attributeMaps,
    visibility: await loadVisibilityTerms(),
    productType: await loadProductTypeTerm("simple"),
    activeAttributeTaxonomies: active,
    images: await buildImageLookup(),
  };
}

/**
 * Write every dirty product into WooCommerce, one transaction per batch.
 *
 * A batch that throws is rolled back and its rows are marked, leaving every earlier batch
 * committed — one malformed product must not cost a 50,000-product import.
 */
export async function writePendingProducts(
  ctx: WriteContext,
  mode: WriteMode,
  onProgress?: (done: number, total: number) => void,
  options?: { unpostedOnly?: boolean },
): Promise<WriteResult> {
  const result: WriteResult = {
    postsCreated: 0,
    postsUpdated: 0,
    pricesUpdated: 0,
    skipped: 0,
    errors: 0,
    hiddenNoImage: 0,
  };

  // Fast sync never creates products; that is the nightly full sync's job.
  // Also pick up catalogue-visible posts whose Woo thumb is junk even when hashes
  // already match — otherwise skip-write leaves a placeholder on the shop.
  const visiblePlaceholderHole = `(
    p.wp_post_id IS NOT NULL
    AND (
      thumb.meta_value IS NULL
      OR TRIM(thumb.meta_value) = ''
      OR LOWER(TRIM(thumb.meta_value)) IN ('none', 'null')
      OR LOWER(TRIM(thumb.meta_value)) NOT REGEXP '^https?://'
      OR LOWER(thumb.meta_value) LIKE '%no_image%'
      OR LOWER(thumb.meta_value) LIKE '%placeholder%'
      OR LOWER(thumb.meta_value) LIKE '%beautyfort.com/pic/%'
    )
    AND NOT EXISTS (
      SELECT 1
        FROM ${wp("term_relationships")} vis
        JOIN ${wp("term_taxonomy")} vtt ON vtt.term_taxonomy_id = vis.term_taxonomy_id
        JOIN ${wp("terms")} vt ON vt.term_id = vtt.term_id
       WHERE vis.object_id = p.wp_post_id
         AND vtt.taxonomy = 'product_visibility'
         AND vt.slug = 'exclude-from-catalog'
    )
  )`;
  let where =
    mode === "fast"
      ? `((p.needs_price_write = 1 AND p.wp_post_id IS NOT NULL) OR ${visiblePlaceholderHole})`
      : `((p.needs_content_write = 1 OR p.needs_price_write = 1) OR ${visiblePlaceholderHole})`;
  if (options?.unpostedOnly) {
    where = `(${where}) AND p.wp_post_id IS NULL`;
  }

  const thumbJoin = `LEFT JOIN (
         SELECT post_id, MIN(meta_value) AS meta_value
           FROM ${wp("postmeta")}
          WHERE meta_key = '_external_thumbnail_url'
          GROUP BY post_id
       ) thumb ON thumb.post_id = p.wp_post_id`;

  const [{ total = 0 } = {}] = await query<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM ${sil("sil_products")} p
       JOIN ${sil("sil_offers")} o ON o.id = p.primary_offer_id
       ${thumbJoin}
      WHERE ${where}`,
  );
  if (total === 0) {
    log.info(`${mode} write: nothing to do`);
    return result;
  }
  log.info(`${mode} write: ${total} products dirty`);

  const batchSize = ctx.settings.writeBatchSize;
  let done = 0;
  let lastId = 0;

  for (;;) {
    // Keyset pagination on product id — OFFSET would drift as rows are cleaned during the run.
    const rows = await query<PendingRow>(
      `SELECT p.id AS product_id, p.identity_key, p.wp_post_id,
              p.applied_content_hash, p.applied_price_hash,
              o.id AS offer_id, o.vendor_id, o.vendor_product_id, o.sku, o.eans, o.name,
              o.description, o.brand, o.category_refs, o.attributes, o.extra, o.vendor_price,
              o.vendor_recommended_price, o.stock, o.image_url, o.gallery_urls,
              thumb.meta_value AS wp_thumb_url, p.operator_hidden
         FROM ${sil("sil_products")} p
         JOIN ${sil("sil_offers")} o ON o.id = p.primary_offer_id
         ${thumbJoin}
        WHERE ${where} AND p.id > ?
        ORDER BY p.id
        LIMIT ?`,
      [lastId, batchSize],
    );
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1]!.product_id;
    await throwIfSyncAborted();

    try {
      const batch = rows.map((row) => prepare(row, ctx, mode));
      const written = await transaction((conn) => writeBatch(conn, batch, ctx, mode));
      result.postsCreated += written.postsCreated;
      result.postsUpdated += written.postsUpdated;
      result.pricesUpdated += written.pricesUpdated;
      result.skipped += written.skipped;
      result.hiddenNoImage += written.hiddenNoImage;
    } catch (err) {
      result.errors += rows.length;
      log.error(`batch ending at product ${lastId} failed`, String(err));
      // Clear the dirty flags so the run terminates; the error stays on the row for the dashboard.
      await execute(
        `UPDATE ${sil("sil_products")}
            SET last_error = ?, needs_content_write = 0, needs_price_write = 0
          WHERE id IN (${rows.map(() => "?").join(",")})`,
        [String(err).slice(0, 2000), ...rows.map((r) => r.product_id)],
      );
    }

    done += rows.length;
    onProgress?.(done, total);
  }

  return result;
}

function prepare(row: PendingRow, ctx: WriteContext, mode: WriteMode): PreparedProduct {
  const vendor = ctx.vendorsById.get(row.vendor_id);
  if (!vendor) throw new Error(`offer ${row.offer_id} references unknown vendor ${row.vendor_id}`);

  const eans = parseJson<string[]>(row.eans, []);
  // Cross-vendor / override fill on every path — not only BeautyFort thumbs and not only full sync.
  const imageUrl = ctx.images.resolve(eans, row.image_url);

  const pricing = computePricing(
    {
      vendorPrice: Number(row.vendor_price),
      vendorRecommendedPrice:
        row.vendor_recommended_price === null ? null : Number(row.vendor_recommended_price),
      stock: row.stock,
    },
    resolveRules(
      {
        multiplier: ctx.settings.priceMultiplier,
        stockThreshold: ctx.settings.stockThreshold,
        maxRrpRatio: ctx.settings.maxRrpRatio,
        priceTiers: ctx.settings.priceTiers,
      },
      vendor,
    ),
  );

  const hiddenNoImage = shouldHideForMissingImage(imageUrl, ctx.settings.hideProductsWithoutImage);
  const operatorHidden = Number(row.operator_hidden) === 1;
  // Stock hide, missing-image hide, and the Products “Keep hidden” pin OR together.
  const effectivePricing: PricingResult =
    hiddenNoImage || operatorHidden ? { ...pricing, hidden: true } : pricing;

  const pHash = priceHash(effectivePricing);
  const isNew = row.wp_post_id === null;
  const thumbOutOfSync = thumbsNeedWrite(row.wp_thumb_url, imageUrl);
  // Hashes can match while Woo still holds "" / "None" — force the write that skip-write missed.
  const writePrice = isNew || pHash !== row.applied_price_hash || thumbOutOfSync;

  const base = {
    productId: row.product_id,
    identityKey: row.identity_key,
    postId: row.wp_post_id,
    offerId: row.offer_id,
    vendorSlug: vendor.slug,
    vendorProductId: row.vendor_product_id,
    sku: row.sku,
    shipCountries: vendor.serviceableCountries,
    pricing: effectivePricing,
    hiddenNoImage,
    priceHash: pHash,
    writePrice,
  };

  // The fast path deliberately does not resolve terms or rebuild the content hash. It touches
  // price, stock, visibility and the external image URL only.
  if (mode === "fast") {
    return {
      ...base,
      name: row.name,
      description: "",
      slug: "",
      eans,
      imageUrl,
      galleryUrls: [],
      categoryTtIds: [],
      attributeTerms: [],
      brandTtId: null,
      contentHash: null,
      writeContent: false,
    };
  }

  const categoryRefs = parseJson<string[]>(row.category_refs, []);
  const attributes = parseJson<Record<string, string>>(row.attributes, {});
  const extra = parseJson<Record<string, unknown>>(row.extra, {});
  const galleryUrls = parseJson<string[]>(row.gallery_urls, []);

  const volume = normalizeVolume(attributes["volume"], ctx.settings.volumeFilterMode);
  if (volume) attributes["volume"] = volume;
  else delete attributes["volume"];

  // Feed browse categories only — never vendor lanes (LPS*) as product_cat or pa_vendor.
  // Vendor identity is `_sillage_vendor` postmeta only (not customer-facing).
  const categoryMap = ctx.categoryMaps.get(row.vendor_id);
  const categoryTtIds: number[] = [];
  for (const ref of categoryRefs) {
    // Leaf terms only. WooCommerce walks ancestors itself for archives and counts.
    const term = categoryMap?.get(ref);
    if (term) categoryTtIds.push(term.ttId);
  }

  const attributeTerms: PreparedProduct["attributeTerms"] = [];
  for (const [key, value] of Object.entries(attributes)) {
    const taxonomy = ATTRIBUTE_TAXONOMIES[key];
    // Skip an attribute whose global taxonomy the plugin has not registered — the terms would
    // exist but WooCommerce could not render them.
    if (!taxonomy || !ctx.activeAttributeTaxonomies.has(taxonomy)) continue;
    const term = ctx.attributeMaps.get(taxonomy)?.get(foldKey(String(value)));
    if (term) attributeTerms.push({ taxonomy, termId: term.termId, ttId: term.ttId });
  }

  const brandTerm = row.brand ? ctx.brandMap.get(foldKey(row.brand)) : undefined;
  const slug = productSlug(row.name, row.sku);
  const description = buildDescription({
    name: row.name,
    brand: row.brand,
    attributes,
    extra,
    mode: ctx.settings.descriptionMode,
    existing: row.description ?? "",
  });

  const cHash = contentHash({
    name: row.name,
    description,
    slug,
    brand: row.brand,
    categoryTtIds,
    attributeTtIds: attributeTerms.map((a) => a.ttId),
    imageUrl,
    galleryUrls,
    sku: row.sku,
    eans,
  });

  return {
    ...base,
    name: row.name,
    description,
    slug,
    eans,
    imageUrl,
    galleryUrls,
    categoryTtIds,
    attributeTerms,
    brandTtId: brandTerm?.ttId ?? null,
    contentHash: cHash,
    writeContent: isNew || cHash !== row.applied_content_hash || thumbOutOfSync,
  };
}

async function writeBatch(
  conn: PoolConnection,
  batch: PreparedProduct[],
  ctx: WriteContext,
  mode: WriteMode,
): Promise<WriteResult> {
  const result: WriteResult = {
    postsCreated: 0,
    postsUpdated: 0,
    pricesUpdated: 0,
    skipped: 0,
    errors: 0,
    hiddenNoImage: 0,
  };
  const maxBytes = ctx.settings.maxStatementBytes;

  const work = batch.filter((p) => p.writeContent || p.writePrice);
  result.skipped = batch.length - work.length;
  // Count every dirty product assessed this batch, not only rows that needed a write.
  result.hiddenNoImage = batch.filter((p) => p.hiddenNoImage).length;
  if (work.length === 0) {
    await clearDirtyFlags(conn, batch, mode);
    return result;
  }

  const created = new Set<PreparedProduct>();
  const contentWork = work.filter((p) => p.writeContent);

  // ── 1. wp_posts ───────────────────────────────────────────────────────────
  const newProducts = work.filter((p) => p.postId === null);
  if (newProducts.length > 0) {
    await bulkInsert(
      conn,
      `INSERT INTO ${wp("posts")}
         (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt,
          post_status, comment_status, ping_status, post_password, post_name,
          to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered,
          post_parent, guid, menu_order, post_type, post_mime_type, comment_count)`,
      // Every column here is NOT NULL in WordPress's schema and sql_mode includes
      // STRICT_TRANS_TABLES, so none of them may be omitted.
      "(1,NOW(),UTC_TIMESTAMP(),?,?,?,'publish','closed','closed','',?,'','',NOW(),UTC_TIMESTAMP(),'',0,'',0,'product','',0)",
      newProducts.map((p) => {
        const title = p.name.slice(0, 500);
        return [p.description || `<p>${title}</p>`, title, title, p.slug];
      }),
      "",
      maxBytes,
    );

    // innodb_autoinc_lock_mode is 2 on this server, so a multi-row INSERT does *not* guarantee a
    // contiguous id block. Read the ids back by slug, which is unique by construction.
    const slugs = newProducts.map((p) => p.slug);
    const idRows: Array<{ ID: number; post_name: string }> = [];
    for (let i = 0; i < slugs.length; i += 500) {
      const chunk = slugs.slice(i, i + 500);
      const [found] = await conn.query<Array<RowDataPacket & { ID: number; post_name: string }>>(
        `SELECT ID, post_name FROM ${wp("posts")}
          WHERE post_type = 'product' AND post_name IN (${chunk.map(() => "?").join(",")})`,
        chunk,
      );
      idRows.push(...found);
    }
    const idBySlug = new Map(idRows.map((r) => [r.post_name, r.ID]));

    for (const p of newProducts) {
      const id = idBySlug.get(p.slug);
      if (!id) throw new Error(`could not resolve a post id for slug "${p.slug}"`);
      p.postId = id;
      created.add(p);
    }

    // guid embeds the post id, so it can only be written on a second pass.
    for (let i = 0; i < newProducts.length; i += 500) {
      const chunk = newProducts.slice(i, i + 500);
      await conn.query(
        `UPDATE ${wp("posts")} SET guid = CONCAT(?, '/?post_type=product&p=', ID)
          WHERE ID IN (${chunk.map(() => "?").join(",")})`,
        [env.wordpress.baseUrl, ...chunk.map((p) => p.postId)],
      );
    }

    result.postsCreated = newProducts.length;
  }

  // Existing products whose content changed.
  const contentUpdates = contentWork.filter((p) => !created.has(p));
  for (const p of contentUpdates) {
    await conn.query(
      `UPDATE ${wp("posts")}
          SET post_title = ?, post_content = ?, post_excerpt = ?, post_name = ?,
              post_modified = NOW(), post_modified_gmt = UTC_TIMESTAMP()
        WHERE ID = ?`,
      [
        p.name.slice(0, 500),
        p.description || `<p>${p.name.slice(0, 500)}</p>`,
        p.name.slice(0, 500),
        p.slug,
        p.postId,
      ],
    );
  }
  result.postsUpdated = contentUpdates.length;

  const postIds = work.map((p) => p.postId!).filter((id): id is number => typeof id === "number");

  // ── 2. wp_postmeta ────────────────────────────────────────────────────────
  const metaKeys = mode === "fast" ? PRICE_META_KEYS : MANAGED_META_KEYS;
  for (let i = 0; i < postIds.length; i += 500) {
    const chunk = postIds.slice(i, i + 500);
    await conn.query(
      `DELETE FROM ${wp("postmeta")}
        WHERE post_id IN (${chunk.map(() => "?").join(",")})
          AND meta_key IN (${metaKeys.map(() => "?").join(",")})`,
      [...chunk, ...metaKeys],
    );
  }

  const metaRows: unknown[][] = [];
  for (const p of work) {
    if (p.postId === null) continue;
    for (const [key, value] of metaFor(p, metaKeys)) metaRows.push([p.postId, key, value]);
  }
  await bulkInsert(
    conn,
    `INSERT INTO ${wp("postmeta")} (post_id, meta_key, meta_value)`,
    "(?,?,?)",
    metaRows,
    "",
    maxBytes,
  );

  // ── 3. term relationships ─────────────────────────────────────────────────
  // Visibility depends on stock, so it is rewritten whenever price changes. Category, brand and
  // attribute terms are only rewritten when content changed.
  const taxonomiesToClear = mode === "fast" ? ["product_visibility"] : OWNED_TAXONOMIES;
  for (let i = 0; i < postIds.length; i += 500) {
    const chunk = postIds.slice(i, i + 500);
    // A multi-table `DELETE tr FROM ... JOIN ...` cannot be used here: MariaDB resolves the alias
    // in the delete list against the connection's default schema, and this pool deliberately has
    // none. The subquery form is single-table, so it needs no such resolution.
    await conn.query(
      `DELETE FROM ${wp("term_relationships")}
        WHERE object_id IN (${chunk.map(() => "?").join(",")})
          AND term_taxonomy_id IN (
                SELECT term_taxonomy_id FROM ${wp("term_taxonomy")}
                 WHERE taxonomy IN (${taxonomiesToClear.map(() => "?").join(",")})
              )`,
      [...chunk, ...taxonomiesToClear],
    );
  }

  const relRows: unknown[][] = [];
  for (const p of work) {
    if (p.postId === null) continue;
    const ttIds = new Set<number>();

    if (mode === "full") {
      // Without a product_type term WooCommerce does not treat the post as a product at all.
      ttIds.add(ctx.productType.ttId);
      for (const ttId of p.categoryTtIds) ttIds.add(ttId);
      if (p.brandTtId) ttIds.add(p.brandTtId);
      for (const attr of p.attributeTerms) ttIds.add(attr.ttId);
    }

    if (p.pricing.hidden) {
      ttIds.add(ctx.visibility["exclude-from-catalog"]!.ttId);
      ttIds.add(ctx.visibility["exclude-from-search"]!.ttId);
    }
    if (p.pricing.stockStatus === "outofstock") {
      ttIds.add(ctx.visibility["outofstock"]!.ttId);
    }

    for (const ttId of ttIds) relRows.push([p.postId, ttId, 0]);
  }
  await bulkInsert(
    conn,
    `INSERT IGNORE INTO ${wp("term_relationships")} (object_id, term_taxonomy_id, term_order)`,
    "(?,?,?)",
    relRows,
    "",
    maxBytes,
  );

  // ── 4. wp_wc_product_meta_lookup ──────────────────────────────────────────
  // A genuine upsert — product_id is the primary key. rating_count, average_rating and
  // total_sales belong to WooCommerce and are never overwritten on update.
  await bulkInsert(
    conn,
    `INSERT INTO ${wp("wc_product_meta_lookup")}
       (product_id, sku, global_unique_id, virtual, downloadable, min_price, max_price,
        onsale, stock_quantity, stock_status, rating_count, average_rating, total_sales,
        tax_status, tax_class)`,
    "(?,?,?,0,0,?,?,?,?,?,0,0.00,0,'taxable','')",
    work
      .filter((p) => p.postId !== null)
      .map((p) => [
        p.postId,
        p.sku,
        p.eans[0] ?? "",
        p.pricing.effectivePrice,
        p.pricing.effectivePrice,
        p.pricing.onSale ? 1 : 0,
        p.pricing.stock,
        p.pricing.stockStatus,
      ]),
    `ON DUPLICATE KEY UPDATE
       sku = VALUES(sku), global_unique_id = VALUES(global_unique_id),
       min_price = VALUES(min_price), max_price = VALUES(max_price),
       onsale = VALUES(onsale), stock_quantity = VALUES(stock_quantity),
       stock_status = VALUES(stock_status)`,
    maxBytes,
  );
  result.pricesUpdated = work.filter((p) => p.writePrice).length;

  // ── 5. wp_wc_product_attributes_lookup ────────────────────────────────────
  // Layered navigation reads only this table. Leave it stale and every attribute filter returns
  // nothing, with no error raised anywhere.
  if (mode === "full") {
    await deleteByIds(conn, wp("wc_product_attributes_lookup"), "product_id", postIds);

    const attrRows: unknown[][] = [];
    for (const p of work) {
      if (p.postId === null) continue;
      for (const attr of p.attributeTerms) {
        attrRows.push([
          p.postId,
          p.postId, // simple products only, so the parent is the product itself
          attr.taxonomy,
          attr.termId,
          0,
          p.pricing.stockStatus === "instock" ? 1 : 0,
        ]);
      }
    }
    await bulkInsert(
      conn,
      `INSERT IGNORE INTO ${wp("wc_product_attributes_lookup")}
         (product_id, product_or_parent_id, taxonomy, term_id, is_variation_attribute, in_stock)`,
      "(?,?,?,?,?,?)",
      attrRows,
      "",
      maxBytes,
    );
  } else {
    // Fast sync: the attribute rows themselves are unchanged, only their stock flag.
    const inStock = work.filter((p) => p.postId !== null && p.pricing.stockStatus === "instock");
    const outOfStock = work.filter((p) => p.postId !== null && p.pricing.stockStatus !== "instock");
    for (const [flag, group] of [
      [1, inStock],
      [0, outOfStock],
    ] as const) {
      for (let i = 0; i < group.length; i += 500) {
        const chunk = group.slice(i, i + 500);
        if (chunk.length === 0) continue;
        await conn.query(
          `UPDATE ${wp("wc_product_attributes_lookup")} SET in_stock = ?
            WHERE product_id IN (${chunk.map(() => "?").join(",")})`,
          [flag, ...chunk.map((p) => p.postId)],
        );
      }
    }
  }

  // ── 6. sil_ean_index ──────────────────────────────────────────────────────
  if (mode === "full" && contentWork.length > 0) {
    const eanPostIds = contentWork.map((p) => p.postId!).filter((id): id is number => typeof id === "number");
    await deleteByIds(conn, sil("sil_ean_index"), "wp_post_id", eanPostIds);

    const eanRows: unknown[][] = [];
    for (const p of contentWork) {
      if (p.postId === null) continue;
      for (const ean of p.eans) eanRows.push([ean, p.postId]);
    }
    await bulkInsert(conn, `INSERT IGNORE INTO ${sil("sil_ean_index")} (ean, wp_post_id)`, "(?,?)", eanRows, "", maxBytes);
  }

  // ── 7. bookkeeping ────────────────────────────────────────────────────────
  // Upsert keyed on the existing primary key, so this is an update in all but name. Both the PK
  // and identity_key resolve to the same row, so there is no ambiguity about which row is hit.
  await bulkInsert(
    conn,
    `INSERT INTO ${sil("sil_products")}
       (id, identity_key, wp_post_id, sku, slug, applied_content_hash, applied_price_hash,
        needs_content_write, needs_price_write, last_error)`,
    "(?,?,?,?,?,?,?,0,0,NULL)",
    work.map((p) => [
      p.productId,
      p.identityKey,
      p.postId,
      p.sku,
      p.slug || null,
      p.contentHash,
      p.priceHash,
    ]),
    `ON DUPLICATE KEY UPDATE
       wp_post_id = VALUES(wp_post_id),
       sku = VALUES(sku),
       slug = COALESCE(VALUES(slug), slug),
       -- In fast mode the content hash is NULL and must not clobber the stored value, or the
       -- next full sync would needlessly rewrite every product.
       applied_content_hash = COALESCE(VALUES(applied_content_hash), applied_content_hash),
       applied_price_hash = VALUES(applied_price_hash),
       needs_content_write = 0,
       needs_price_write = 0,
       last_error = NULL`,
    maxBytes,
  );

  for (let i = 0; i < work.length; i += 1000) {
    const chunk = work.slice(i, i + 1000);
    await conn.query(
      `UPDATE ${sil("sil_offers")} SET status = 'applied', last_error = NULL
        WHERE id IN (${chunk.map(() => "?").join(",")})`,
      chunk.map((p) => p.offerId),
    );
  }

  await clearDirtyFlags(conn, batch, mode);
  return result;
}

async function clearDirtyFlags(conn: PoolConnection, batch: PreparedProduct[], mode: WriteMode): Promise<void> {
  const ids = batch.map((p) => p.productId);
  if (ids.length === 0) return;
  const set = mode === "fast" ? "needs_price_write = 0" : "needs_content_write = 0, needs_price_write = 0";
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    await conn.query(
      `UPDATE ${sil("sil_products")} SET ${set} WHERE id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    );
  }
}

function metaFor(p: PreparedProduct, keys: readonly string[]): Array<[string, string]> {
  const all: Record<string, string | null> = {
    _sku: p.sku,
    _global_unique_id: p.eans[0] ?? "",
    _regular_price: String(p.pricing.regularPrice),
    // null means "not on sale": the row must be absent, not empty, or WooCommerce shows a
    // strikethrough price of nothing.
    _sale_price: p.pricing.salePrice === null ? null : String(p.pricing.salePrice),
    _price: String(p.pricing.effectivePrice),
    _stock: String(p.pricing.stock),
    _stock_status: p.pricing.stockStatus,
    _manage_stock: "yes",
    _backorders: "no",
    _tax_status: "taxable",
    _tax_class: "",
    _virtual: "no",
    _downloadable: "no",
    _sold_individually: "no",
    _weight: "",
    _length: "",
    _width: "",
    _height: "",
    _product_attributes: serializeProductAttributes(p.attributeTerms),
    _product_version: "11.0.0",
    _wc_review_count: "0",
    _wc_average_rating: "0",
    _sillage_vendor: p.vendorSlug,
    _sillage_vendor_product_id: p.vendorProductId,
    _sillage_offer_id: String(p.offerId),
    _sillage_ship_countries: JSON.stringify(p.shipCountries),
    // Rendered by sillage-bridge, byte-for-byte as the vendor supplied it. Nothing is downloaded
    // and no attachment is ever created.
    _external_thumbnail_url: p.imageUrl ?? "",
    _external_gallery_urls: p.galleryUrls.length > 0 ? JSON.stringify(p.galleryUrls) : "",
  };

  const out: Array<[string, string]> = [];
  for (const key of keys) {
    const value = all[key];
    if (value === null || value === undefined) continue;
    out.push([key, value]);
  }
  return out;
}
