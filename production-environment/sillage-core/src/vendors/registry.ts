import { WholesalePerfumesConnector } from "./wholesale-perfumes/connector.ts";
import type { VendorConnector } from "./VendorConnector.ts";

/** This wholesale shop syncs wholesale-perfumes only. */
export const STOREFRONT_VENDOR_SLUGS = ["wholesale-perfumes"] as const;

export function storefrontVendorSlugs(): string[] {
  return [...STOREFRONT_VENDOR_SLUGS];
}

export function isParkedVendor(slug: string): boolean {
  return slug !== "wholesale-perfumes";
}

export function vendorSelectableForSync(slug: string, _explicit: boolean): boolean {
  return slug === "wholesale-perfumes";
}

export function createConnectors(): VendorConnector[] {
  return [new WholesalePerfumesConnector()];
}

export function createConnector(slug: string): VendorConnector {
  const found = createConnectors().find((c) => c.slug === slug);
  if (!found) throw new Error(`Unknown vendor "${slug}"`);
  return found;
}
