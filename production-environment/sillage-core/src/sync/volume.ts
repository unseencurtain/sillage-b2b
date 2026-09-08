/** Map raw vendor volume strings onto storefront filter buckets. */

export type VolumeFilterMode = "exact" | "ranges" | "off";

export function parseMl(raw: string): number | null {
  const m = raw.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function volumeBucket(ml: number): string {
  if (ml <= 30) return "Up to 30 ml";
  if (ml <= 50) return "31–50 ml";
  if (ml <= 100) return "51–100 ml";
  if (ml <= 200) return "101–200 ml";
  return "Over 200 ml";
}

/** Returns null when the volume attribute should be omitted from the product. */
export function normalizeVolume(raw: string | undefined, mode: VolumeFilterMode): string | null {
  if (!raw || mode === "off") return null;
  if (mode === "exact") return raw;
  const ml = parseMl(raw);
  if (ml === null) return raw;
  return volumeBucket(ml);
}

/**
 * Fallback only when `sil_vendors.storefront_label` is unset (pre-migration). Prefer
 * `vendor.storefrontLabel` from the database everywhere storefront-facing copy is emitted.
 */
export const VENDOR_LABELS: Record<string, string> = {
  beautyfort: "LPS02",
  bts: "LPS01",
  "wholesale-perfumes": "LPS03",
};

export function vendorStorefrontLabel(vendor: { slug: string; storefrontLabel?: string; name: string }): string {
  if (vendor.storefrontLabel?.trim()) return vendor.storefrontLabel.trim();
  return VENDOR_LABELS[vendor.slug] ?? vendor.name;
}
