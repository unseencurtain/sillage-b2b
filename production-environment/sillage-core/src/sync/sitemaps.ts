/**
 * Static product sitemaps — written by Bun, served by Caddy as files.
 *
 * Google only needs URLs of shop-visible products. It does not need live prices
 * or stock. Fast sync (dashboard **Minutes between syncs**) must not rebuild
 * these files: that would make Google recrawl the catalogue through PHP.
 *
 * Rebuild on full / content rewrite (and when new posts were created). A few
 * seconds of SQL + disk, zero Apache workers.
 */

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env, wp } from "../config/env.ts";
import { query, type RowDataPacket } from "../db/pool.ts";
import { logger } from "../lib/log.ts";
import {
  SITEMAP_PAGE_SIZE,
  chunk,
  renderIndex,
  renderRobots,
  renderUrlset,
  type SitemapProduct,
} from "./sitemapsXml.ts";

const log = logger("sitemaps");

export function sitemapDir(): string {
  return (process.env.SITEMAP_DIR || "").trim() || join(env.rootDir, "data/sitemaps");
}

export {
  SITEMAP_PAGE_SIZE,
  chunk,
  escapeXml,
  lastmodDate,
  productUrl,
  renderIndex,
  renderRobots,
  renderUrlset,
  type SitemapProduct,
} from "./sitemapsXml.ts";

interface ProductRow extends RowDataPacket {
  post_name: string;
  post_modified_gmt: string;
}

/** Shop-visible published products. Hidden (no image / stock / pin) stay out. */
export async function loadVisibleProducts(): Promise<SitemapProduct[]> {
  const rows = await query<ProductRow>(
    `SELECT p.post_name, p.post_modified_gmt
       FROM ${wp("posts")} p
      WHERE p.post_type = 'product'
        AND p.post_status = 'publish'
        AND p.post_name <> ''
        AND p.ID NOT IN (
          SELECT tr.object_id
            FROM ${wp("term_relationships")} tr
            JOIN ${wp("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
            JOIN ${wp("terms")} t ON t.term_id = tt.term_id
           WHERE tt.taxonomy = 'product_visibility'
             AND t.slug IN ('exclude-from-catalog', 'exclude-from-search')
        )
      ORDER BY p.ID`,
  );
  return rows.map((r) => ({
    slug: String(r.post_name),
    lastmod: String(r.post_modified_gmt ?? ""),
  }));
}

export async function writeProductSitemaps(opts?: {
  dir?: string;
  baseUrl?: string;
}): Promise<{ urls: number; pages: number; dir: string }> {
  const dir = opts?.dir || sitemapDir();
  const base = (opts?.baseUrl || env.wordpress.baseUrl).replace(/\/$/, "");
  const products = await loadVisibleProducts();
  const pages = chunk(products, SITEMAP_PAGE_SIZE);
  const pageCount = Math.max(1, pages.length);
  let newest = "";
  for (const p of products) {
    if (p.lastmod > newest) newest = p.lastmod;
  }
  if (!newest) newest = new Date().toISOString().slice(0, 10);
  const tmp = `${dir}.tmp-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await writeFile(join(tmp, "robots.txt"), renderRobots(base), "utf8");
  await writeFile(join(tmp, "wp-sitemap.xml"), renderIndex(base, pageCount, newest), "utf8");
  if (pages.length === 0) {
    await writeFile(join(tmp, "wp-sitemap-posts-product-1.xml"), renderUrlset(base, []), "utf8");
  } else {
    for (let i = 0; i < pages.length; i++) {
      await writeFile(
        join(tmp, `wp-sitemap-posts-product-${i + 1}.xml`),
        renderUrlset(base, pages[i]!),
        "utf8",
      );
    }
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, ".."), { recursive: true });
  await rename(tmp, dir);
  log.info(`wrote ${products.length} URLs in ${pageCount} sitemap page(s) → ${dir}`);
  return { urls: products.length, pages: pageCount, dir };
}
