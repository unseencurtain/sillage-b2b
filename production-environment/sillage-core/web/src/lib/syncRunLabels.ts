/** Labels for sil_sync_runs on Overview + Sync. Keep in sync with CLIENT-GUIDE. */

export function fetchedLabel(r: {
  products_fetched?: number | null;
  fetched_by_vendor?: Record<string, number> | null;
  skipped_vendors?: string[] | null;
  bts_delta?: boolean;
}): string {
  const by = r.fetched_by_vendor;
  const skipped = new Set(r.skipped_vendors ?? []);
  if (by && by["wholesale-perfumes"] != null) {
    return `WPF ${Number(by["wholesale-perfumes"]).toLocaleString()}`;
  }
  if (by && (by.beautyfort != null || by.bts != null)) {
    const bf = skipped.has("beautyfort")
      ? "BF skipped"
      : by.beautyfort != null
        ? `BF ${Number(by.beautyfort).toLocaleString()}`
        : "BF —";
    const bts = skipped.has("bts")
      ? "BTS skipped"
      : by.bts != null
        ? `BTS ${Number(by.bts).toLocaleString()}${r.bts_delta ? " Δ" : ""}`
        : "BTS —";
    return `${bf} · ${bts}`;
  }
  return r.products_fetched == null ? "—" : Number(r.products_fetched).toLocaleString();
}
