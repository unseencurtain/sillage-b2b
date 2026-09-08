import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDispatchDryRun, wholesaleMinOrderEur } from "../src/storefront/profile.ts";
import { storefrontVendorSlugs, vendorSelectableForSync } from "../src/vendors/registry.ts";

describe("wholesale storefront", () => {
  test("this process is wholesale-perfumes only", () => {
    expect(storefrontVendorSlugs()).toEqual(["wholesale-perfumes"]);
    expect(vendorSelectableForSync("wholesale-perfumes", false)).toBe(true);
    expect(vendorSelectableForSync("beautyfort", true)).toBe(false);
  });

  test("dispatch is always dry-run and MOQ is €300", () => {
    expect(resolveDispatchDryRun(false)).toBe(true);
    expect(wholesaleMinOrderEur()).toBe(300);
  });

  test("compose is a standalone wholesale stack", () => {
    const compose = readFileSync(join(import.meta.dir, "../../compose.yaml"), "utf8");
    expect(compose).toContain("container_name: wholesale-core");
    expect(compose).toContain("container_name: wholesale-db");
    expect(compose).toContain("wholesale-valkey");
    expect(compose).not.toContain("container_name: wholesale-media");
    expect(compose).not.toContain("container_name: lps-media");
    expect(compose).not.toContain("ecom_sites/data}/media");
    expect(compose).not.toContain("container_name: ecom-db");
    expect(compose).not.toContain("BeautyFort");
  });

  test("order adapter is wholesale-perfumes only", () => {
    const src = readFileSync(join(import.meta.dir, "../src/orders/adapters/index.ts"), "utf8");
    expect(src).toContain("WholesalePerfumesOrderAdapter");
    expect(src).not.toContain("BeautyfortOrderAdapter");
  });
});
