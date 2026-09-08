/** Pure sitemap XML helpers. No database — keep this importable from tests. */

export const SITEMAP_PAGE_SIZE = 2000;

export interface SitemapProduct {
  slug: string;
  lastmod: string;
}

export function productUrl(base: string, slug: string): string {
  const origin = base.replace(/\/$/, "");
  return `${origin}/product/${slug}/`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function lastmodDate(mysqlUtc: string): string {
  const d = mysqlUtc.trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(d)) {
    return d.slice(0, 10);
  }
  return mysqlUtc.slice(0, 10);
}

export function renderUrlset(base: string, rows: SitemapProduct[]): string {
  const urls = rows
    .map((row) => {
      const loc = escapeXml(productUrl(base, row.slug));
      const lastmod = escapeXml(lastmodDate(row.lastmod));
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function renderIndex(base: string, pageCount: number, lastmod: string): string {
  const origin = base.replace(/\/$/, "");
  const day = escapeXml(lastmodDate(lastmod));
  const items: string[] = [];
  for (let i = 1; i <= pageCount; i++) {
    items.push(
      `  <sitemap>\n    <loc>${escapeXml(`${origin}/wp-sitemap-posts-product-${i}.xml`)}</loc>\n    <lastmod>${day}</lastmod>\n  </sitemap>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items.join("\n")}\n</sitemapindex>\n`;
}

export function renderRobots(base: string): string {
  const origin = base.replace(/\/$/, "");
  return `User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n\nSitemap: ${origin}/wp-sitemap.xml\n`;
}

export function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
