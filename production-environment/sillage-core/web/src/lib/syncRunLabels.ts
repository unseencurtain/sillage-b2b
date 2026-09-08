/** Labels for sil_sync_runs on Overview + Sync. Keep in sync with CLIENT-GUIDE. */

export function fetchedLabel(r: {
  products_fetched?: number | null;
  fetched_by_vendor?: Record<string, number> | null;
  skipped_vendors?: string[] | null;
}): string {
  const by = r.fetched_by_vendor;
  const skipped = new Set(r.skipped_vendors ?? []);
  if (by && by["wholesale-perfumes"] != null) {
    if (skipped.has("wholesale-perfumes")) return "WPF skipped";
    return `WPF ${Number(by["wholesale-perfumes"]).toLocaleString()}`;
  }
  return r.products_fetched == null ? "—" : Number(r.products_fetched).toLocaleString();
}
