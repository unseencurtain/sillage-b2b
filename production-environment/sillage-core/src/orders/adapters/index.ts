import type { VendorOrderAdapter } from "../adapter.ts";
import { WholesalePerfumesOrderAdapter } from "./wholesale-perfumes.ts";

export function createOrderAdapters(): VendorOrderAdapter[] {
  return [new WholesalePerfumesOrderAdapter()];
}

export function createOrderAdapter(slug: string): VendorOrderAdapter {
  const found = createOrderAdapters().find((a) => a.slug === slug);
  if (!found) throw new Error(`No order adapter for vendor "${slug}"`);
  return found;
}
