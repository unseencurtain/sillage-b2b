import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Vendor, type VendorPatch } from "@/lib/api";
import { ConfirmPanel } from "@/components/ConfirmPanel";
import { Toggle } from "@/components/Toggle";
import { useToast } from "@/components/Toast";
import { watchSyncUntilIdle } from "@/lib/watchSync";

/** Parked supplier — not editable on this storefront. */

interface VendorForm {
  storefrontLabel: string;
  priceMultiplier: string;
  minVisibleStock: string;
  fxRate: string;
  vatRate: string;
  minOrderValueEur: string;
  serviceableCountries: string;
  active: boolean;
}

function toForm(v: Vendor): VendorForm {
  return {
    storefrontLabel: v.storefrontLabel,
    priceMultiplier: v.priceMultiplier === null || v.priceMultiplier === undefined ? "" : String(v.priceMultiplier),
    minVisibleStock: v.minVisibleStock === null || v.minVisibleStock === undefined ? "" : String(v.minVisibleStock),
    fxRate: String(v.fxRate),
    vatRate: String(v.vatRate),
    minOrderValueEur:
      v.minOrderValueEur === null || v.minOrderValueEur === undefined ? "" : String(v.minOrderValueEur),
    serviceableCountries: v.serviceableCountries.join(" "),
    active: v.active,
  };
}

function parseCountries(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

function countriesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((c, i) => c === sb[i]);
}

function emptyToNullNumber(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  return Number(t);
}

function buildPatch(form: VendorForm, original: Vendor): VendorPatch {
  const patch: VendorPatch = {};
  if (form.storefrontLabel.trim() !== original.storefrontLabel) {
    patch.storefrontLabel = form.storefrontLabel.trim();
  }

  const mult = emptyToNullNumber(form.priceMultiplier);
  if (mult !== original.priceMultiplier) patch.priceMultiplier = mult;

  const stock = emptyToNullNumber(form.minVisibleStock);
  const stockInt = stock === null ? null : Math.trunc(stock);
  if (stockInt !== original.minVisibleStock) patch.minVisibleStock = stockInt;

  const fx = Number(form.fxRate);
  if (fx !== original.fxRate) patch.fxRate = fx;

  const vat = Number(form.vatRate);
  if (vat !== original.vatRate) patch.vatRate = vat;

  const minOrder = emptyToNullNumber(form.minOrderValueEur);
  if (minOrder !== original.minOrderValueEur) patch.minOrderValueEur = minOrder;

  const countries = parseCountries(form.serviceableCountries);
  if (!countriesEqual(countries, original.serviceableCountries)) {
    patch.serviceableCountries = countries;
  }

  if (form.active !== original.active) patch.active = form.active;

  return patch;
}

function confirmDescription(original: Vendor, patch: VendorPatch): string {
  const parts: string[] = [];
  if (patch.active !== undefined) {
    parts.push(
      patch.active
        ? `Activate “${original.storefrontLabel || original.name}” (${original.slug}) — orders may dispatch to this supplier.`
        : `Deactivate “${original.storefrontLabel || original.name}” (${original.slug}) — this supplier will stop receiving dispatch.`,
    );
  }
  if (patch.serviceableCountries !== undefined) {
    const from = original.serviceableCountries.join(" ") || "(none)";
    const to = patch.serviceableCountries.join(" ") || "(none)";
    parts.push(`Change serviceable countries from ${from} to ${to}.`);
  }
  return parts.join(" ");
}

export function Vendors() {
  const { data, isLoading } = useQuery({ queryKey: ["vendors"], queryFn: api.vendors });
  const vendors = data?.vendors ?? [];
  const wholesale = data?.profile === "wholesale";
  const active = vendors.filter((v) => !v.parked);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Vendors</h1>
        <p className="text-sm text-muted">
          {wholesale
            ? "wholesale-perfumes only on this shop. Saving multiplier / FX / VAT / min stock recalculates shop prices from stored offers (no live vendor download). Credentials: "
            : "BeautyFort + BTS only. How often prices/stock move is on each card below — they are not the same. Saving multiplier / FX / VAT / min stock recalculates shop prices from stored offers (no live vendor download). Credentials: "}
          <Link to="/secrets" className="font-medium text-accent hover:underline">
            Secrets
          </Link>
          .
        </p>
      </header>

      {isLoading ? <p className="text-muted">Loading…</p> : null}

      <div className="grid gap-4 xl:grid-cols-1">
        {active.map((v) => (
          <VendorEditor
            key={v.id}
            vendor={v}
            globalPriceMultiplier={data?.globalPriceMultiplier ?? 1}
            globalStockThreshold={data?.globalStockThreshold ?? 0}
            callIntervalMinutes={data?.callIntervalMinutes ?? 30}
            lastLiveFetch={data?.lastLiveFetch?.[v.slug] ?? null}
          />
        ))}
      </div>
    </div>
  );
}

function VendorEditor({
  vendor,
  globalPriceMultiplier,
  globalStockThreshold,
  callIntervalMinutes,
  lastLiveFetch,
}: {
  vendor: Vendor;
  globalPriceMultiplier: number;
  globalStockThreshold: number;
  callIntervalMinutes: number;
  lastLiveFetch: string | null;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const cancelWatch = useRef<(() => void) | null>(null);
  const [form, setForm] = useState<VendorForm>(() => toForm(vendor));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingPatch, setPendingPatch] = useState<VendorPatch | null>(null);

  useEffect(() => {
    setForm(toForm(vendor));
    setConfirmOpen(false);
    setPendingPatch(null);
  }, [vendor]);

  useEffect(() => () => cancelWatch.current?.(), []);

  const save = useMutation({
    mutationFn: (patch: VendorPatch) => api.saveVendor(vendor.slug, patch),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["vendors"] });
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      toast("Vendor saved", "ok");
      if (res.syncStarted || res.syncQueued) {
        toast(
          res.syncQueued
            ? "Sync already running — your new prices will apply when it finishes"
            : "Recalculating prices…",
          "info",
        );
        cancelWatch.current?.();
        cancelWatch.current = watchSyncUntilIdle(qc, toast, { expectFollowUp: !!res.syncQueued });
      }
      setConfirmOpen(false);
      setPendingPatch(null);
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const set = <K extends keyof VendorForm>(key: K, value: VendorForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const requestSave = () => {
    const patch = buildPatch(form, vendor);
    if (Object.keys(patch).length === 0) {
      toast("No changes", "info");
      return;
    }
    const needsConfirm = patch.active !== undefined || patch.serviceableCountries !== undefined;
    if (needsConfirm) {
      setPendingPatch(patch);
      setConfirmOpen(true);
      return;
    }
    save.mutate(patch);
  };

  const inputClass =
    "mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:opacity-60";

  return (
    <article className="rounded-xl border border-line bg-panel p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{vendor.storefrontLabel || vendor.name}</h2>
          <div className="font-mono text-xs text-muted">
            {vendor.slug} · SKU {vendor.skuPrefix}-*
            {vendor.storefrontLabel && vendor.storefrontLabel !== vendor.name ? ` · internal ${vendor.name}` : ""}
          </div>
        </div>
        <span
          className={`rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
            form.active ? "bg-emerald-50 text-ok ring-emerald-200" : "bg-slate-100 text-slate-500 ring-slate-200"
          }`}
        >
          {form.active ? "active" : "inactive"}
        </span>
      </div>

      <CatalogueSyncPanel
        slug={vendor.slug}
        callIntervalMinutes={callIntervalMinutes}
        lastLiveFetch={lastLiveFetch}
      />

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium text-ink">Storefront label</span>
          <input
            className={inputClass}
            value={form.storefrontLabel}
            disabled={save.isPending}
            onChange={(e) => set("storefrontLabel", e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">Customer-facing section name (e.g. LPS01)</span>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-ink">Price multiplier</span>
          <input
            type="number"
            step="0.01"
            className={inputClass}
            placeholder={`Global ${globalPriceMultiplier}`}
            value={form.priceMultiplier}
            disabled={save.isPending}
            onChange={(e) => set("priceMultiplier", e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">
            Empty = fall back to global multiplier and price tiers. A value here disables tiered pricing for
            this vendor.
          </span>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-ink">Min visible stock</span>
          <input
            type="number"
            step="1"
            className={inputClass}
            placeholder={`Global ${globalStockThreshold}`}
            value={form.minVisibleStock}
            disabled={save.isPending}
            onChange={(e) => set("minVisibleStock", e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">
            Empty = fall back to the global stock threshold ({globalStockThreshold}).
          </span>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-ink">FX rate</span>
          <input
            type="number"
            step="0.000001"
            className={inputClass}
            value={form.fxRate}
            disabled={save.isPending}
            onChange={(e) => set("fxRate", e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">
            Converts vendor currency into EUR cost before markup (usually 1 for EUR vendors).
          </span>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-ink">VAT rate (fraction)</span>
          <input
            type="number"
            step="0.0001"
            className={inputClass}
            value={form.vatRate}
            disabled={save.isPending}
            onChange={(e) => set("vatRate", e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">
            Cost = vendor price × FX × (1 + VAT). Use 0.21 for 21%, not 21.
          </span>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-ink">Min order value (EUR)</span>
          <input
            type="number"
            step="0.01"
            className={inputClass}
            placeholder="none"
            value={form.minOrderValueEur}
            disabled={save.isPending}
            onChange={(e) => set("minOrderValueEur", e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">
            Stored in order_config.min_order_value_eur. Bridge hard-blocks cart/checkout under this
            floor (storefront-label message). Empty clears that key only. Independent of the global
            small-order fee toggle.
          </span>
        </label>

        <label className="block text-sm md:col-span-2">
          <span className="font-medium text-ink">Serviceable countries</span>
          <input
            className={inputClass}
            value={form.serviceableCountries}
            disabled={save.isPending}
            onChange={(e) => set("serviceableCountries", e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted">
            Space- or comma-separated ISO codes (e.g. BE DE NL). Changing this requires confirmation.
          </span>
        </label>

        <div className="rounded-lg border border-line/70 bg-canvas/40 px-4 py-3 md:col-span-2">
          <Toggle
            label="Active"
            hint="Inactive vendors are skipped by sync and cannot receive dispatch. Requires confirmation."
            checked={form.active}
            disabled={save.isPending}
            onChange={(v) => set("active", v)}
          />
        </div>
      </div>

      <p className="mt-4 text-sm text-muted">
        Changing the multiplier or VAT starts a cache rewrite-only sync after save. CLI{" "}
        <code className="font-mono text-xs">bun run sync -- --rewrite-all</code> is the escape hatch.
      </p>

      {confirmOpen && pendingPatch ? (
        <div className="mt-4">
          <ConfirmPanel
            title="Confirm vendor dispatch settings"
            description={confirmDescription(vendor, pendingPatch)}
            confirmLabel="Confirm and save"
            danger
            pending={save.isPending}
            onCancel={() => {
              setConfirmOpen(false);
              setPendingPatch(null);
            }}
            onConfirm={() => pendingPatch && save.mutate(pendingPatch)}
          />
        </div>
      ) : (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-60"
            disabled={save.isPending}
            onClick={requestSave}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </article>
  );
}

function CatalogueSyncPanel({
  slug,
  callIntervalMinutes,
  lastLiveFetch,
}: {
  slug: string;
  callIntervalMinutes: number;
  lastLiveFetch: string | null;
}) {
  const last = lastLiveFetch
    ? `${new Date(lastLiveFetch).toLocaleString("en-GB", { timeZone: "UTC", hour12: false })} UTC`
    : "never";
  const isBf = slug === "beautyfort";
  const isBts = slug === "bts";
  const isWpf = slug === "wholesale-perfumes";

  return (
    <div className="mt-4 rounded-lg border border-line bg-canvas/50 p-4">
      <h3 className="text-sm font-semibold">How often this vendor updates</h3>
      <p className="mt-1 text-xs text-muted">
        We are allowed to call them every {callIntervalMinutes} minutes (
        <Link to="/settings" className="font-medium text-accent hover:underline">
          Settings → Minutes between syncs
        </Link>
        ). That is a check interval, not “{callIntervalMinutes} minutes of work a day”.
      </p>
      {isBf ? (
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="font-medium text-ink">Prices and stock</dt>
            <dd className="text-muted">
              Every {callIntervalMinutes} minutes. BeautyFort has no “what changed” feed, so each check
              re-downloads their full stock file (~9k SKUs) and writes whatever moved.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink">Full catalogue rebuild</dt>
            <dd className="text-muted">
              Routine: Settings → Daily full catalogue rebuild (once per 24 hours after the chosen
              hour) — new products, prices/stock, and WordPress categories from the ~9k stock file.
              Manual: Sync → Rebuild catalogue.
            </dd>
          </div>
        </dl>
      ) : null}
      {isBts ? (
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="font-medium text-ink">Prices and stock</dt>
            <dd className="text-muted">
              About once a day on the shop. We check every {callIntervalMinutes} minutes, but BTS only
              publishes a change list roughly once per day. Empty checks in between are normal. When
              their daily batch appears, the next check applies it — usually within{" "}
              {callIntervalMinutes} minutes of them publishing.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink">Full catalogue rebuild (~45k products)</dt>
            <dd className="text-muted">
              Routine: Settings → Daily full catalogue rebuild downloads the full ~45k catalogue and
              creates/updates WordPress categories for every referenced BTS node. Emergency: if more
              than a quarter of BTS products have not been seen for 7 days, the next 30-minute check
              also pulls the full catalogue. Manual: Sync → Rebuild catalogue.
            </dd>
          </div>
        </dl>
      ) : null}
      {isWpf ? (
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="font-medium text-ink">Prices and stock</dt>
            <dd className="text-muted">
              Every {callIntervalMinutes} minutes from the hourly store XML. Many rows share one
              product id — Sillage collapses to unique SKUs. Fetched on Sync is those catalogue SKUs,
              not the raw line count.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink">Full catalogue rebuild</dt>
            <dd className="text-muted">
              Routine: Settings → Daily full catalogue rebuild (once per 24 hours after the chosen
              hour) — new products and WordPress categories from the daily catalog XML. Manual: Sync
              → Rebuild catalogue.
            </dd>
          </div>
        </dl>
      ) : null}
      {!isBf && !isBts && !isWpf ? (
        <p className="mt-2 text-sm text-ink">No live feed for this supplier.</p>
      ) : null}
      <p className="mt-2 text-xs text-muted">Last live fetch: {last}</p>
    </div>
  );
}
