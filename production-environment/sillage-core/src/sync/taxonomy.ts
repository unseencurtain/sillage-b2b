import { env, sil, wp } from "../config/env.ts";
import { execute, query, transaction, type PoolConnection, type RowDataPacket } from "../db/pool.ts";
import { logger } from "../lib/log.ts";
import { foldKey, slugify, uniqueTermSlug } from "../lib/slugify.ts";
import type { VendorCategoryNode } from "../vendors/types.ts";

const log = logger("taxonomy");

export interface TermRef {
  termId: number;
  ttId: number;
}

/** Attribute key in NormalizedProduct.attributes -> WooCommerce global attribute taxonomy. */
export const ATTRIBUTE_TAXONOMIES: Record<string, string> = {
  gender: "pa_gender",
  // Slugged `item-type`, not `type`: WordPress reserves `type` as a public query variable, so
  // wc_create_attribute() rejects it and the attribute never gets registered at all.
  type: "pa_item-type",
  volume: "pa_volume",
  // vendor / pa_vendor is intentionally absent — LPS labels must not appear on the product page.
  // Retail vendor identity is `_sillage_vendor` postmeta only (see Decision 28).
};

/**
 * Legacy global attribute formerly used for storefront vendor facets (LPS01/LPS02).
 * Kept as a named constant so the writer can clear leftover assignments and sync can purge them.
 * Never assign new product terms to this taxonomy.
 */
export const LEGACY_VENDOR_ATTRIBUTE_TAXONOMY = "pa_vendor";

/**
 * Singular. WooCommerce registers `product_brand` — see `get_taxonomy( 'product_brand' )` in
 * `class-wc-brands.php`. Terms written to `product_brands` are stored happily and read by nothing.
 */
export const BRAND_TAXONOMY = "product_brand";
export const CATEGORY_TAXONOMY = "product_cat";

const B2B_VENDOR_SLUG = "wholesale-perfumes";
const B2B_PAGE_SLUG = "b2b-wholesale";

interface TermRow extends RowDataPacket {
  term_id: number;
  term_taxonomy_id: number;
  slug: string;
  name: string;
  parent: number;
}

interface MapRow extends RowDataPacket {
  vendor_category_key: string;
  wp_term_id: number;
  wp_term_taxonomy_id: number;
}

interface SimpleMapRow extends RowDataPacket {
  source_key: string;
  wp_term_id: number;
  wp_term_taxonomy_id: number;
}

interface SlugRow extends RowDataPacket {
  slug: string;
}

/** Every slug already in wp_terms. WordPress expects term slugs to be globally unique. */
async function loadTakenSlugs(): Promise<Set<string>> {
  const rows = await query<SlugRow>(`SELECT slug FROM ${wp("terms")}`);
  return new Set(rows.map((r) => r.slug));
}

async function insertTerm(
  conn: PoolConnection,
  name: string,
  slug: string,
  taxonomy: string,
  parentTermId: number,
): Promise<TermRef> {
  const [termResult] = await conn.query(
    `INSERT INTO ${wp("terms")} (name, slug, term_group) VALUES (?, ?, 0)`,
    [name.slice(0, 200), slug.slice(0, 200)],
  );
  const termId = (termResult as { insertId: number }).insertId;

  const [ttResult] = await conn.query(
    `INSERT INTO ${wp("term_taxonomy")} (term_id, taxonomy, description, parent, count)
     VALUES (?, ?, '', ?, 0)`,
    [termId, taxonomy, parentTermId],
  );
  const ttId = (ttResult as { insertId: number }).insertId;

  return { termId, ttId };
}

/**
 * Create the WordPress `product_cat` terms a vendor's feed needs.
 *
 * Only categories actually referenced by products, plus their ancestors, are created — BTS
 * publishes 4,103 nodes but products reference only 1,834 of them, and the rest would be
 * permanently empty terms cluttering the storefront.
 */
export async function syncCategories(
  vendorId: number,
  nodes: VendorCategoryNode[],
  referencedKeys: Set<string>,
): Promise<{ map: Map<string, TermRef>; created: number }> {
  const byKey = new Map(nodes.map((n) => [n.key, n]));

  // Expand to the ancestor closure so no term is created without its parent.
  const needed = new Set<string>();
  for (const key of referencedKeys) {
    let cursor: string | null = key;
    let guard = 0;
    while (cursor && !needed.has(cursor) && guard++ < 32) {
      const node: VendorCategoryNode | undefined = byKey.get(cursor);
      if (!node) break;
      needed.add(cursor);
      cursor = node.parentKey;
    }
  }

  const map = new Map<string, TermRef>();
  for (const row of await query<MapRow>(
    `SELECT vendor_category_key, wp_term_id, wp_term_taxonomy_id
       FROM ${sil("sil_category_map")} WHERE vendor_id = ?`,
    [vendorId],
  )) {
    map.set(row.vendor_category_key, { termId: row.wp_term_id, ttId: row.wp_term_taxonomy_id });
  }

  // Adopt terms an operator may have created by hand, matching on slug within product_cat.
  const existingBySlug = new Map<string, TermRow>();
  for (const row of await query<TermRow>(
    `SELECT t.term_id, tt.term_taxonomy_id, t.slug, t.name, tt.parent
       FROM ${wp("terms")} t
       JOIN ${wp("term_taxonomy")} tt ON tt.term_id = t.term_id
      WHERE tt.taxonomy = ?`,
    [CATEGORY_TAXONOMY],
  )) {
    existingBySlug.set(row.slug, row);
  }

  const missing = [...needed].filter((k) => !map.has(k));
  if (missing.length === 0) return { map, created: 0 };

  // Depth order guarantees a parent is resolved before its children. The live BTS tree is only
  // four deep and acyclic, but this is computed rather than assumed.
  const depthOf = (key: string): number => {
    let d = 0;
    let cursor: string | null = key;
    let guard = 0;
    while (cursor && guard++ < 32) {
      const node: VendorCategoryNode | undefined = byKey.get(cursor);
      if (!node?.parentKey) break;
      cursor = node.parentKey;
      d++;
    }
    return d;
  };
  missing.sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));

  const takenSlugs = await loadTakenSlugs();
  let created = 0;

  await transaction(async (conn) => {
    const pending: Array<[string, TermRef, number, boolean]> = [];

    for (const key of missing) {
      const node = byKey.get(key);
      if (!node) continue;

      const parentTermId = node.parentKey ? (map.get(node.parentKey)?.termId ?? 0) : 0;

      // A term with this slug may already exist from a previous vendor or a manual edit; reuse it
      // rather than creating a near-duplicate category.
      const baseSlug = slugify(node.name) || `cat-${key}`;
      const adoptable = existingBySlug.get(baseSlug);

      let ref: TermRef;
      if (adoptable && adoptable.parent === parentTermId) {
        ref = { termId: adoptable.term_id, ttId: adoptable.term_taxonomy_id };
      } else {
        const slug = uniqueTermSlug(node.name, takenSlugs, `cat-${key}`);
        ref = await insertTerm(conn, node.name, slug, CATEGORY_TAXONOMY, parentTermId);
        existingBySlug.set(slug, {
          term_id: ref.termId,
          term_taxonomy_id: ref.ttId,
          slug,
          name: node.name,
          parent: parentTermId,
        } as TermRow);
        created++;
      }

      map.set(key, ref);
      const isLeaf = !nodes.some((n) => n.parentKey === key && needed.has(n.key));
      pending.push([key, ref, depthOf(key), isLeaf]);
    }

    for (let i = 0; i < pending.length; i += 500) {
      const slice = pending.slice(i, i + 500);
      await conn.query(
        `INSERT INTO ${sil("sil_category_map")}
           (vendor_id, vendor_category_key, wp_term_id, wp_term_taxonomy_id, depth, is_leaf)
         VALUES ${slice.map(() => "(?,?,?,?,?,?)").join(",")}
         ON DUPLICATE KEY UPDATE
           wp_term_id = VALUES(wp_term_id),
           wp_term_taxonomy_id = VALUES(wp_term_taxonomy_id),
           depth = VALUES(depth),
           is_leaf = VALUES(is_leaf)`,
        slice.flatMap(([key, ref, depth, isLeaf]) => [
          vendorId,
          key,
          ref.termId,
          ref.ttId,
          depth,
          isLeaf ? 1 : 0,
        ]),
      );
    }
  });

  log.info(`vendor ${vendorId}: ${created} product_cat terms created, ${map.size} mapped`);
  return { map, created };
}

/**
 * Strip legacy `pa_vendor` (LPS01/LPS02) from every product so Additional information and layered
 * nav never show storefront vendor labels. Retail code uses `_sillage_vendor` postmeta only.
 *
 * Safe to run repeatedly. Does not remove the WooCommerce attribute definition (PHP-owned).
 */
export async function purgeVendorProductAttributes(): Promise<{
  metaUpdated: number;
  relationshipsDeleted: number;
  termsDeleted: number;
}> {
  const { serialize, unserialize } = await import("php-serialize");
  const taxonomy = LEGACY_VENDOR_ATTRIBUTE_TAXONOMY;

  // 1. Strip pa_vendor from PHP-serialized `_product_attributes` (drives Additional information).
  const metaRows = await query<RowDataPacket & { meta_id: number; meta_value: string }>(
    `SELECT meta_id, meta_value FROM ${wp("postmeta")}
      WHERE meta_key = '_product_attributes' AND meta_value LIKE ?`,
    [`%${taxonomy}%`],
  );
  let metaUpdated = 0;
  for (const row of metaRows) {
    let attrs: Record<string, unknown>;
    try {
      attrs = unserialize(row.meta_value) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!attrs || typeof attrs !== "object" || !(taxonomy in attrs)) continue;
    delete attrs[taxonomy];
    // Re-pack positions so WooCommerce's attribute UI stays contiguous.
    let position = 0;
    for (const key of Object.keys(attrs)) {
      const entry = attrs[key];
      if (entry && typeof entry === "object" && "position" in entry) {
        (entry as { position: number }).position = position++;
      }
    }
    await execute(`UPDATE ${wp("postmeta")} SET meta_value = ? WHERE meta_id = ?`, [
      serialize(attrs),
      row.meta_id,
    ]);
    metaUpdated++;
  }

  // 2. Drop term relationships + layered-nav lookup rows.
  const relResult = await execute(
    `DELETE FROM ${wp("term_relationships")}
      WHERE term_taxonomy_id IN (
            SELECT term_taxonomy_id FROM ${wp("term_taxonomy")} WHERE taxonomy = ?
          )`,
    [taxonomy],
  );
  await execute(`DELETE FROM ${wp("wc_product_attributes_lookup")} WHERE taxonomy = ?`, [taxonomy]);

  // 3. Remove the LPS* attribute terms themselves (and our map rows).
  const termRows = await query<RowDataPacket & { term_id: number }>(
    `SELECT term_id FROM ${wp("term_taxonomy")} WHERE taxonomy = ?`,
    [taxonomy],
  );
  const termIds = termRows.map((r) => r.term_id);
  if (termIds.length > 0) {
    const idPh = termIds.map(() => "?").join(",");
    await execute(`DELETE FROM ${wp("termmeta")} WHERE term_id IN (${idPh})`, termIds);
    await execute(`DELETE FROM ${wp("term_taxonomy")} WHERE taxonomy = ? AND term_id IN (${idPh})`, [
      taxonomy,
      ...termIds,
    ]);
    await execute(`DELETE FROM ${wp("terms")} WHERE term_id IN (${idPh})`, termIds);
  }
  await execute(`DELETE FROM ${sil("sil_term_map")} WHERE taxonomy = ?`, [taxonomy]);

  const out = {
    metaUpdated,
    relationshipsDeleted: relResult.affectedRows,
    termsDeleted: termIds.length,
  };
  if (out.metaUpdated > 0 || out.relationshipsDeleted > 0 || out.termsDeleted > 0) {
    log.info(
      `purged pa_vendor: meta=${out.metaUpdated} rels=${out.relationshipsDeleted} terms=${out.termsDeleted}`,
    );
  }
  return out;
}

/**
 * Vendor lanes (LPS01 / LPS02 / LPS03) must NOT live in `product_cat` — marketplaces treat that
 * taxonomy as browse categories. Vendor identity is `_sillage_vendor` postmeta only (never
 * customer-facing `pa_vendor` / LPS labels on the product page).
 *
 * This removes any leftover vendor `product_cat` terms (and their sil_term_map rows) from earlier
 * mistaken lane wiring. Feed browse categories are left alone.
 */
export async function purgeVendorProductCatLanes(
  vendors: Array<{ slug: string; name: string; storefrontLabel?: string }>,
  labels: Record<string, string>,
): Promise<{ deleted: number }> {
  const termIds = new Set<number>();

  for (const row of await query<SimpleMapRow>(
    `SELECT source_key, wp_term_id, wp_term_taxonomy_id FROM ${sil("sil_term_map")}
      WHERE taxonomy = ? AND source_key LIKE 'vendor:%'`,
    [CATEGORY_TAXONOMY],
  )) {
    termIds.add(row.wp_term_id);
  }

  const nameGuesses = new Set<string>(["LPS01", "LPS02", "LPS03", "lps01", "lps02", "lps03"]);
  for (const v of vendors) {
    const label = (labels[v.slug] ?? v.storefrontLabel ?? "").trim();
    if (label) nameGuesses.add(label);
    nameGuesses.add(v.name);
  }

  const placeholders = [...nameGuesses].map(() => "?").join(",");
  if (placeholders) {
    for (const row of await query<TermRow>(
      `SELECT t.term_id, tt.term_taxonomy_id, t.slug, t.name, tt.parent
         FROM ${wp("terms")} t
         JOIN ${wp("term_taxonomy")} tt ON tt.term_id = t.term_id
        WHERE tt.taxonomy = ?
          AND (t.slug IN (${placeholders}) OR t.name IN (${placeholders}))`,
      [CATEGORY_TAXONOMY, ...nameGuesses, ...nameGuesses],
    )) {
      // Only purge top-level LPS-style lanes — never a nested feed category that happens to share a name.
      if (row.parent === 0 || /^lps0[123]$/i.test(row.slug) || /^lps0[123]$/i.test(row.name)) {
        termIds.add(row.term_id);
      }
    }
  }

  if (termIds.size === 0) {
    await execute(
      `DELETE FROM ${sil("sil_term_map")} WHERE taxonomy = ? AND source_key LIKE 'vendor:%'`,
      [CATEGORY_TAXONOMY],
    );
    return { deleted: 0 };
  }

  const ids = [...termIds];
  const idPh = ids.map(() => "?").join(",");

  // Subquery form — multi-table DELETE aliases break when the pool has no default schema.
  await execute(
    `DELETE FROM ${wp("term_relationships")}
      WHERE term_taxonomy_id IN (
            SELECT term_taxonomy_id FROM ${wp("term_taxonomy")}
             WHERE taxonomy = ? AND term_id IN (${idPh})
          )`,
    [CATEGORY_TAXONOMY, ...ids],
  );
  await execute(`DELETE FROM ${wp("termmeta")} WHERE term_id IN (${idPh})`, ids);
  await execute(
    `DELETE FROM ${wp("term_taxonomy")} WHERE taxonomy = ? AND term_id IN (${idPh})`,
    [CATEGORY_TAXONOMY, ...ids],
  );
  // No alias — MariaDB rejects `DELETE t FROM db.table t` when the pool has no default schema.
  await execute(`DELETE FROM ${wp("terms")} WHERE term_id IN (${idPh})`, ids);
  await execute(
    `DELETE FROM ${sil("sil_term_map")} WHERE taxonomy = ? AND source_key LIKE 'vendor:%'`,
    [CATEGORY_TAXONOMY],
  );
  await execute(
    `DELETE FROM ${wp("wc_category_lookup")}
      WHERE category_tree_id IN (${idPh}) OR category_id IN (${idPh})`,
    [...ids, ...ids],
  );

  log.info(`purged ${ids.length} vendor product_cat lane term(s)`);
  return { deleted: ids.length };
}

/**
 * Remove mistaken brand→product_cat wiring for wholesale-perfumes.
 *
 * Older connector versions nested `brand:{id}` under type in `product_cat`, which flooded the
 * B2B sidebar with an A–Z brand list. Brands belong on `product_brand` only; browse cats are types.
 */
export async function purgeWholesalePerfumesBrandProductCats(): Promise<{
  mapRowsDeleted: number;
  relationshipsRemoved: number;
  termsDeleted: number;
}> {
  const vendorRows = await query<RowDataPacket & { id: number }>(
    `SELECT id FROM ${sil("sil_vendors")} WHERE slug = ? LIMIT 1`,
    [B2B_VENDOR_SLUG],
  );
  const vendorId = vendorRows[0]?.id;
  if (!vendorId) {
    return { mapRowsDeleted: 0, relationshipsRemoved: 0, termsDeleted: 0 };
  }

  const brandMaps = await query<MapRow>(
    `SELECT vendor_category_key, wp_term_id, wp_term_taxonomy_id
       FROM ${sil("sil_category_map")}
      WHERE vendor_id = ? AND vendor_category_key LIKE 'brand:%'`,
    [vendorId],
  );
  if (brandMaps.length === 0) {
    return { mapRowsDeleted: 0, relationshipsRemoved: 0, termsDeleted: 0 };
  }

  const ttIds = [...new Set(brandMaps.map((r) => r.wp_term_taxonomy_id))];
  const termIds = [...new Set(brandMaps.map((r) => r.wp_term_id))];
  const ttPh = ttIds.map(() => "?").join(",");

  // Drop only relationships on wholesale-perfumes products — never strip a shared BF/BTS term.
  // Subquery form — multi-table DELETE aliases break when the pool has no default schema.
  const relResult = await execute(
    `DELETE FROM ${wp("term_relationships")}
      WHERE term_taxonomy_id IN (${ttPh})
        AND object_id IN (
          SELECT post_id FROM ${wp("postmeta")}
           WHERE meta_key = '_sillage_vendor' AND meta_value = ?
        )`,
    [...ttIds, B2B_VENDOR_SLUG],
  );

  const mapResult = await execute(
    `DELETE FROM ${sil("sil_category_map")}
      WHERE vendor_id = ? AND vendor_category_key LIKE 'brand:%'`,
    [vendorId],
  );

  // Delete orphan terms that no longer appear in any sil_category_map and have no relationships.
  let termsDeleted = 0;
  const idPh = termIds.map(() => "?").join(",");
  const stillMapped = new Set(
    (
      await query<RowDataPacket & { wp_term_id: number }>(
        `SELECT DISTINCT wp_term_id FROM ${sil("sil_category_map")} WHERE wp_term_id IN (${idPh})`,
        termIds,
      )
    ).map((r) => r.wp_term_id),
  );
  const orphans = termIds.filter((id) => !stillMapped.has(id));
  if (orphans.length > 0) {
    const orphanPh = orphans.map(() => "?").join(",");
    const withRels = new Set(
      (
        await query<RowDataPacket & { term_id: number }>(
          `SELECT DISTINCT tt.term_id
             FROM ${wp("term_taxonomy")} tt
             INNER JOIN ${wp("term_relationships")} tr
               ON tr.term_taxonomy_id = tt.term_taxonomy_id
            WHERE tt.taxonomy = ? AND tt.term_id IN (${orphanPh})`,
          [CATEGORY_TAXONOMY, ...orphans],
        )
      ).map((r) => r.term_id),
    );
    const deletable = orphans.filter((id) => !withRels.has(id));
    if (deletable.length > 0) {
      const delPh = deletable.map(() => "?").join(",");
      await execute(
        `DELETE FROM ${wp("term_relationships")}
          WHERE term_taxonomy_id IN (
                SELECT term_taxonomy_id FROM ${wp("term_taxonomy")}
                 WHERE taxonomy = ? AND term_id IN (${delPh})
              )`,
        [CATEGORY_TAXONOMY, ...deletable],
      );
      await execute(`DELETE FROM ${wp("termmeta")} WHERE term_id IN (${delPh})`, deletable);
      await execute(
        `DELETE FROM ${wp("term_taxonomy")} WHERE taxonomy = ? AND term_id IN (${delPh})`,
        [CATEGORY_TAXONOMY, ...deletable],
      );
      await execute(`DELETE FROM ${wp("terms")} WHERE term_id IN (${delPh})`, deletable);
      await execute(
        `DELETE FROM ${wp("wc_category_lookup")}
          WHERE category_tree_id IN (${delPh}) OR category_id IN (${delPh})`,
        [...deletable, ...deletable],
      );
      termsDeleted = deletable.length;
    }
  }

  log.info(
    `purged WPF brand product_cat: map=${mapResult.affectedRows} rels=${relResult.affectedRows} terms=${termsDeleted}`,
  );
  return {
    mapRowsDeleted: mapResult.affectedRows,
    relationshipsRemoved: relResult.affectedRows,
    termsDeleted,
  };
}

/**
 * Reload vendor feed → product_cat maps from `sil_category_map` without fetching a feed.
 * Used by rewrite-only syncs so content rewrites cannot wipe categories with empty maps.
 */
export async function loadCategoryMapsFromDb(
  vendorIds: Iterable<number>,
): Promise<Map<number, Map<string, TermRef>>> {
  const out = new Map<number, Map<string, TermRef>>();
  for (const vendorId of vendorIds) {
    const map = new Map<string, TermRef>();
    for (const row of await query<MapRow>(
      `SELECT vendor_category_key, wp_term_id, wp_term_taxonomy_id
         FROM ${sil("sil_category_map")} WHERE vendor_id = ?`,
      [vendorId],
    )) {
      map.set(row.vendor_category_key, { termId: row.wp_term_id, ttId: row.wp_term_taxonomy_id });
    }
    out.set(vendorId, map);
  }
  return out;
}

/**
 * Reload a flat taxonomy map (brands / pa_*) from `sil_term_map`, keyed by foldKey like syncFlatTerms.
 */
export async function loadFlatTermMapFromDb(taxonomy: string): Promise<Map<string, TermRef>> {
  const map = new Map<string, TermRef>();
  for (const row of await query<SimpleMapRow>(
    `SELECT source_key, wp_term_id, wp_term_taxonomy_id FROM ${sil("sil_term_map")} WHERE taxonomy = ?`,
    [taxonomy],
  )) {
    map.set(foldKey(row.source_key), { termId: row.wp_term_id, ttId: row.wp_term_taxonomy_id });
  }
  return map;
}

/**
 * Park wholesale-perfumes on this (LPS retail) storefront: force vendor inactive, unpublish
 * `/b2b-wholesale/`, and exclude WPF products from catalog + search via product_visibility.
 *
 * B2B lives on a future separate site — see repo `b2b-wholesale/`. Idempotent; safe every sync.
 */
export async function parkWholesalePerfumesFromMainStorefront(): Promise<{
  vendorDeactivated: boolean;
  pagesUnpublished: number;
  productsHidden: number;
}> {
  const vendorResult = await execute(
    `UPDATE ${sil("sil_vendors")} SET active = 0 WHERE slug = ? AND active <> 0`,
    [B2B_VENDOR_SLUG],
  );

  const pageResult = await execute(
    `UPDATE ${wp("posts")}
        SET post_status = 'draft',
            post_modified = NOW(),
            post_modified_gmt = UTC_TIMESTAMP()
      WHERE post_type = 'page'
        AND post_name = ?
        AND post_status IN ('publish','private')`,
    [B2B_PAGE_SLUG],
  );

  const visibility = await loadVisibilityTerms();
  const catalogTt = visibility["exclude-from-catalog"]!.ttId;
  const searchTt = visibility["exclude-from-search"]!.ttId;

  // Hide every published WPF product from shop + search (singular URLs may still resolve).
  const hideResult = await execute(
    `INSERT IGNORE INTO ${wp("term_relationships")} (object_id, term_taxonomy_id, term_order)
     SELECT p.ID, vis.tt_id, 0
       FROM ${wp("posts")} p
       INNER JOIN ${wp("postmeta")} pm
         ON pm.post_id = p.ID
        AND pm.meta_key = '_sillage_vendor'
        AND pm.meta_value = ?
       CROSS JOIN (
         SELECT ? AS tt_id UNION ALL SELECT ?
       ) vis
      WHERE p.post_type = 'product'
        AND p.post_status = 'publish'`,
    [B2B_VENDOR_SLUG, catalogTt, searchTt],
  );

  // Keep _visibility meta aligned for admin lists / some theme paths.
  await execute(
    `INSERT INTO ${wp("postmeta")} (post_id, meta_key, meta_value)
     SELECT p.ID, '_visibility', 'hidden'
       FROM ${wp("posts")} p
       INNER JOIN ${wp("postmeta")} pm
         ON pm.post_id = p.ID
        AND pm.meta_key = '_sillage_vendor'
        AND pm.meta_value = ?
      WHERE p.post_type = 'product'
        AND p.post_status = 'publish'
        AND NOT EXISTS (
          SELECT 1 FROM ${wp("postmeta")} existing
           WHERE existing.post_id = p.ID AND existing.meta_key = '_visibility'
        )`,
    [B2B_VENDOR_SLUG],
  );
  await execute(
    `UPDATE ${wp("postmeta")} pm
       INNER JOIN ${wp("postmeta")} vendor
         ON vendor.post_id = pm.post_id
        AND vendor.meta_key = '_sillage_vendor'
        AND vendor.meta_value = ?
        SET pm.meta_value = 'hidden'
      WHERE pm.meta_key = '_visibility'
        AND pm.meta_value <> 'hidden'`,
    [B2B_VENDOR_SLUG],
  );

  const out = {
    vendorDeactivated: vendorResult.affectedRows > 0,
    pagesUnpublished: pageResult.affectedRows,
    productsHidden: hideResult.affectedRows,
  };
  if (out.vendorDeactivated || out.pagesUnpublished > 0 || out.productsHidden > 0) {
    log.info(
      `parked wholesale-perfumes from main storefront: ` +
        `vendorOff=${out.vendorDeactivated} pages=${out.pagesUnpublished} hideRels=${out.productsHidden}`,
    );
  }
  return out;
}

const RETAIL_VENDOR_SLUGS = ["beautyfort", "bts"] as const;

/**
 * Park BeautyFort + BTS on the wholesale storefront: force inactive and hide any leftover
 * products from catalog + search. Idempotent; safe every sync.
 */
export async function parkRetailVendorsFromWholesaleStorefront(): Promise<{
  vendorsDeactivated: number;
  productsHidden: number;
}> {
  const vendorResult = await execute(
    `UPDATE ${sil("sil_vendors")} SET active = 0 WHERE slug IN (?, ?) AND active <> 0`,
    [...RETAIL_VENDOR_SLUGS],
  );

  const visibility = await loadVisibilityTerms();
  const catalogTt = visibility["exclude-from-catalog"]!.ttId;
  const searchTt = visibility["exclude-from-search"]!.ttId;

  const hideResult = await execute(
    `INSERT IGNORE INTO ${wp("term_relationships")} (object_id, term_taxonomy_id, term_order)
     SELECT p.ID, vis.tt_id, 0
       FROM ${wp("posts")} p
       INNER JOIN ${wp("postmeta")} pm
         ON pm.post_id = p.ID
        AND pm.meta_key = '_sillage_vendor'
        AND pm.meta_value IN (?, ?)
       CROSS JOIN (
         SELECT ? AS tt_id UNION ALL SELECT ?
       ) vis
      WHERE p.post_type = 'product'
        AND p.post_status = 'publish'`,
    [RETAIL_VENDOR_SLUGS[0], RETAIL_VENDOR_SLUGS[1], catalogTt, searchTt],
  );

  await execute(
    `INSERT INTO ${wp("postmeta")} (post_id, meta_key, meta_value)
     SELECT p.ID, '_visibility', 'hidden'
       FROM ${wp("posts")} p
       INNER JOIN ${wp("postmeta")} pm
         ON pm.post_id = p.ID
        AND pm.meta_key = '_sillage_vendor'
        AND pm.meta_value IN (?, ?)
      WHERE p.post_type = 'product'
        AND p.post_status = 'publish'
        AND NOT EXISTS (
          SELECT 1 FROM ${wp("postmeta")} existing
           WHERE existing.post_id = p.ID AND existing.meta_key = '_visibility'
        )`,
    [...RETAIL_VENDOR_SLUGS],
  );
  await execute(
    `UPDATE ${wp("postmeta")} pm
       INNER JOIN ${wp("postmeta")} vendor
         ON vendor.post_id = pm.post_id
        AND vendor.meta_key = '_sillage_vendor'
        AND vendor.meta_value IN (?, ?)
        SET pm.meta_value = 'hidden'
      WHERE pm.meta_key = '_visibility'
        AND pm.meta_value <> 'hidden'`,
    [...RETAIL_VENDOR_SLUGS],
  );

  const out = {
    vendorsDeactivated: Number(vendorResult.affectedRows ?? 0),
    productsHidden: Number(hideResult.affectedRows ?? 0),
  };
  if (out.vendorsDeactivated > 0 || out.productsHidden > 0) {
    log.info(
      `parked BeautyFort/BTS from wholesale storefront: vendorOff=${out.vendorsDeactivated} hideRels=${out.productsHidden}`,
    );
  }
  return out;
}

/** Profile-aware park: WPF off the retail shop, BF/BTS off the wholesale shop. */
export async function parkForeignVendorsFromStorefront(): Promise<void> {
  if (env.sillageProfile === "wholesale") {
    await parkRetailVendorsFromWholesaleStorefront();
    return;
  }
  await parkWholesalePerfumesFromMainStorefront();
}

/**
 * Create flat terms for a non-hierarchical taxonomy — brands and the `pa_*` attributes.
 *
 * Keyed by `foldKey`, which matches how the database's own collation compares strings, so "DIOR",
 * "Dior" and "Diór" all resolve to a single term instead of fighting each other run after run.
 */
export async function syncFlatTerms(
  taxonomy: string,
  values: Iterable<string>,
): Promise<{ map: Map<string, TermRef>; created: number }> {
  const map = new Map<string, TermRef>();
  for (const row of await query<SimpleMapRow>(
    `SELECT source_key, wp_term_id, wp_term_taxonomy_id FROM ${sil("sil_term_map")} WHERE taxonomy = ?`,
    [taxonomy],
  )) {
    map.set(foldKey(row.source_key), { termId: row.wp_term_id, ttId: row.wp_term_taxonomy_id });
  }

  // Existing WordPress terms, indexed both by folded name and by slug so a term created by an
  // operator, an earlier vendor, or an older version of this code is adopted rather than
  // duplicated.
  const existingByFold = new Map<string, TermRow>();
  const existingBySlug = new Map<string, TermRow>();
  for (const row of await query<TermRow>(
    `SELECT t.term_id, tt.term_taxonomy_id, t.slug, t.name, tt.parent
       FROM ${wp("terms")} t
       JOIN ${wp("term_taxonomy")} tt ON tt.term_id = t.term_id
      WHERE tt.taxonomy = ?`,
    [taxonomy],
  )) {
    existingBySlug.set(row.slug, row);
    const folded = foldKey(row.name);
    if (!existingByFold.has(folded)) existingByFold.set(folded, row);
  }

  const wanted = new Map<string, string>();
  for (const raw of values) {
    const label = String(raw ?? "").trim();
    if (!label) continue;
    const key = foldKey(label);
    if (!key) continue;
    // Deterministic winner when two spellings fold together, so the chosen label does not flip
    // between runs depending on feed order.
    const existing = wanted.get(key);
    if (existing === undefined || label < existing) wanted.set(key, label);
  }

  const missing = [...wanted].filter(([key]) => !map.has(key));
  if (missing.length === 0) return { map, created: 0 };

  const takenSlugs = await loadTakenSlugs();
  let created = 0;

  await transaction(async (conn) => {
    const pending: Array<[string, string, TermRef]> = [];

    for (const [key, label] of missing) {
      const adoptable = existingByFold.get(key) ?? existingBySlug.get(slugify(label));

      let ref: TermRef;
      if (adoptable) {
        ref = { termId: adoptable.term_id, ttId: adoptable.term_taxonomy_id };
      } else {
        const slug = uniqueTermSlug(label, takenSlugs, "term");
        ref = await insertTerm(conn, label, slug, taxonomy, 0);
        const row = {
          term_id: ref.termId,
          term_taxonomy_id: ref.ttId,
          slug,
          name: label,
          parent: 0,
        } as TermRow;
        existingBySlug.set(slug, row);
        existingByFold.set(key, row);
        created++;
      }

      map.set(key, ref);
      pending.push([key, label, ref]);
    }

    for (let i = 0; i < pending.length; i += 500) {
      const slice = pending.slice(i, i + 500);
      await conn.query(
        `INSERT INTO ${sil("sil_term_map")}
           (taxonomy, source_key, wp_term_id, wp_term_taxonomy_id, label)
         VALUES ${slice.map(() => "(?,?,?,?,?)").join(",")}
         ON DUPLICATE KEY UPDATE
           -- Rewrite source_key too. The collation can match a row whose stored key is a
           -- different spelling of the same word; without this the row never converges on the
           -- folded form and the lookup misses again next run.
           source_key = VALUES(source_key),
           wp_term_id = VALUES(wp_term_id),
           wp_term_taxonomy_id = VALUES(wp_term_taxonomy_id),
           label = VALUES(label)`,
        slice.flatMap(([key, label, ref]) => [taxonomy, key, ref.termId, ref.ttId, label.slice(0, 200)]),
      );
    }
  });

  log.info(`${taxonomy}: ${created} terms created, ${map.size} mapped`);
  return { map, created };
}

/**
 * The install's `product_visibility` term ids. These are per-install and must never be hardcoded,
 * even though they happen to be 6-9 here.
 */
export async function loadVisibilityTerms(): Promise<Record<string, TermRef>> {
  const rows = await query<TermRow>(
    `SELECT t.term_id, tt.term_taxonomy_id, t.slug, t.name, tt.parent
       FROM ${wp("terms")} t
       JOIN ${wp("term_taxonomy")} tt ON tt.term_id = t.term_id
      WHERE tt.taxonomy = 'product_visibility'`,
  );
  const out: Record<string, TermRef> = {};
  for (const row of rows) out[row.slug] = { termId: row.term_id, ttId: row.term_taxonomy_id };

  for (const required of ["exclude-from-catalog", "exclude-from-search", "outofstock"]) {
    if (!out[required]) {
      throw new Error(
        `product_visibility term "${required}" is missing — is WooCommerce fully installed?`,
      );
    }
  }
  return out;
}

/** WooCommerce's `product_type` terms, needed so products register as simple products. */
export async function loadProductTypeTerm(type = "simple"): Promise<TermRef> {
  const rows = await query<TermRow>(
    `SELECT t.term_id, tt.term_taxonomy_id, t.slug, t.name, tt.parent
       FROM ${wp("terms")} t
       JOIN ${wp("term_taxonomy")} tt ON tt.term_id = t.term_id
      WHERE tt.taxonomy = 'product_type' AND t.slug = ?`,
    [type],
  );
  const row = rows[0];
  if (!row) throw new Error(`product_type term "${type}" is missing — is WooCommerce installed?`);
  return { termId: row.term_id, ttId: row.term_taxonomy_id };
}

/** True when the WooCommerce global attribute taxonomy has been registered by the plugin. */
export async function attributeTaxonomyExists(taxonomy: string): Promise<boolean> {
  const name = taxonomy.replace(/^pa_/, "");
  const rows = await query<RowDataPacket>(
    `SELECT 1 FROM ${wp("woocommerce_attribute_taxonomies")} WHERE attribute_name = ? LIMIT 1`,
    [name],
  );
  return rows.length > 0;
}

/**
 * Recount terms once per run rather than per row.
 *
 * WooCommerce counts only published products, and the storefront hides products carrying
 * `exclude-from-catalog`, so those are excluded here too — otherwise category counts overstate
 * what a shopper can actually see. Parked WPF products get that visibility term via
 * `parkWholesalePerfumesFromMainStorefront`, so BF/BTS sidebar counts stay honest without a
 * vendor-meta carve-out.
 */
export async function recountTerms(taxonomies: string[]): Promise<void> {
  if (taxonomies.length === 0) return;

  const excluded = await query<RowDataPacket & { term_taxonomy_id: number }>(
    `SELECT tt.term_taxonomy_id FROM ${wp("term_taxonomy")} tt
       JOIN ${wp("terms")} t ON t.term_id = tt.term_id
      WHERE tt.taxonomy = 'product_visibility' AND t.slug = 'exclude-from-catalog'`,
  );
  const hiddenTtId = excluded[0]?.term_taxonomy_id ?? 0;

  const placeholders = taxonomies.map(() => "?").join(",");
  await execute(
    `UPDATE ${wp("term_taxonomy")} tt
        SET tt.count = (
          SELECT COUNT(DISTINCT p.ID)
            FROM ${wp("term_relationships")} tr
            JOIN ${wp("posts")} p ON p.ID = tr.object_id
           WHERE tr.term_taxonomy_id = tt.term_taxonomy_id
             AND p.post_type = 'product'
             AND p.post_status = 'publish'
             AND NOT EXISTS (
               SELECT 1 FROM ${wp("term_relationships")} hidden
                WHERE hidden.object_id = p.ID AND hidden.term_taxonomy_id = ?
             )
        )
      WHERE tt.taxonomy IN (${placeholders})`,
    [hiddenTtId, ...taxonomies],
  );

  log.info(`recounted ${taxonomies.join(", ")}`);
}

/**
 * Rebuild `wp_wc_category_lookup`, WooCommerce's product_cat closure table. Without it category
 * filtering and counts silently return wrong results, because nothing else maintains it when the
 * CRUD layer is bypassed.
 */
export async function rebuildCategoryLookup(): Promise<number> {
  await execute(`DELETE FROM ${wp("wc_category_lookup")}`);
  const result = await execute(
    `INSERT INTO ${wp("wc_category_lookup")} (category_tree_id, category_id)
     WITH RECURSIVE tree AS (
       SELECT tt.term_id AS root_id, tt.term_id AS node_id
         FROM ${wp("term_taxonomy")} tt
        WHERE tt.taxonomy = 'product_cat'
       UNION ALL
       SELECT tree.root_id, child.term_id
         FROM tree
         JOIN ${wp("term_taxonomy")} child
           ON child.parent = tree.node_id AND child.taxonomy = 'product_cat'
     )
     SELECT DISTINCT root_id, node_id FROM tree`,
  );
  log.info(`rebuilt wc_category_lookup (${result.affectedRows} rows)`);
  return result.affectedRows;
}
