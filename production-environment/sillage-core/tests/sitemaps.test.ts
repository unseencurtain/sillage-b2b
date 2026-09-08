import { describe, expect, test } from "bun:test";
import {
  chunk,
  escapeXml,
  lastmodDate,
  productUrl,
  renderIndex,
  renderRobots,
  renderUrlset,
  SITEMAP_PAGE_SIZE,
} from "../src/sync/sitemapsXml.ts";

describe("static product sitemaps", () => {
  test("escapes XML in slugs", () => {
    expect(escapeXml("a&b<c>")).toBe("a&amp;b&lt;c&gt;");
  });

  test("product URL matches the shop permalink", () => {
    expect(productUrl("https://prinscosmetic.eu/", "chanel-no-5")).toBe(
      "https://prinscosmetic.eu/product/chanel-no-5/",
    );
  });

  test("lastmod is a date, not a datetime (no 30-min churn)", () => {
    expect(lastmodDate("2026-09-03 14:22:01")).toBe("2026-09-03");
  });

  test("urlset contains loc + lastmod only (no price, no stock)", () => {
    const xml = renderUrlset("https://prinscosmetic.eu", [
      { slug: "nivea-cream", lastmod: "2026-08-01 00:00:00" },
    ]);
    expect(xml).toContain("https://prinscosmetic.eu/product/nivea-cream/");
    expect(xml).toContain("<lastmod>2026-08-01</lastmod>");
    expect(xml).not.toContain("price");
    expect(xml).not.toContain("availability");
  });

  test("index lists WP-shaped product sitemap names", () => {
    const xml = renderIndex("https://prinscosmetic.eu", 2, "2026-09-03");
    expect(xml).toContain("/wp-sitemap-posts-product-1.xml");
    expect(xml).toContain("/wp-sitemap-posts-product-2.xml");
  });

  test("robots points at the static index", () => {
    expect(renderRobots("https://prinscosmetic.eu")).toContain(
      "Sitemap: https://prinscosmetic.eu/wp-sitemap.xml",
    );
  });

  test("page size matches WordPress core", () => {
    expect(SITEMAP_PAGE_SIZE).toBe(2000);
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});
