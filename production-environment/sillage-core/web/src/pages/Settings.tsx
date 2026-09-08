import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, emptyCompanyBilling, type CompanyBillingAddress } from "@/lib/api";
import { Toggle } from "@/components/Toggle";
import { useToast } from "@/components/Toast";
import { watchSyncUntilIdle } from "@/lib/watchSync";
import { cn } from "@/lib/utils";
import { COMMON_TIMEZONES, resolveTimeZone, utcClockForLocalHour } from "@/lib/timezone";

const BILLING_FIELDS: Array<{ key: keyof CompanyBillingAddress; label: string; wide?: boolean }> = [
  { key: "company", label: "Company", wide: true },
  { key: "vat", label: "VAT / BTW", wide: true },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "address1", label: "Address line 1", wide: true },
  { key: "address2", label: "Address line 2", wide: true },
  { key: "city", label: "City" },
  { key: "state", label: "State / region" },
  { key: "postcode", label: "Postcode" },
  { key: "country", label: "Country (ISO)" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
];

interface TierRow {
  maxCost: string;
  multiplier: string;
  unbounded: boolean;
}

function isTruthy(v: string | undefined) {
  return v === "1" || v === "true";
}

function parseBilling(raw: string | undefined): CompanyBillingAddress {
  if (!raw) return emptyCompanyBilling();
  try {
    return { ...emptyCompanyBilling(), ...JSON.parse(raw) };
  } catch {
    return emptyCompanyBilling();
  }
}

function parseTiers(raw: string | undefined): TierRow[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as Array<{ maxCost: number | null; multiplier: number }>;
    if (!Array.isArray(list) || list.length === 0) return [];
    return list.map((t, i) => ({
      maxCost: t.maxCost === null || t.maxCost === undefined ? "" : String(t.maxCost),
      multiplier: String(t.multiplier ?? ""),
      unbounded: t.maxCost === null || t.maxCost === undefined || i === list.length - 1,
    }));
  } catch {
    return [];
  }
}

function serializeTiers(rows: TierRow[]): string {
  if (rows.length === 0) return "[]";
  const out = rows.map((r, i) => {
    const last = i === rows.length - 1;
    return {
      maxCost: last || r.unbounded ? null : Number(r.maxCost),
      multiplier: Number(r.multiplier),
    };
  });
  return JSON.stringify(out);
}

function Section({
  title,
  help,
  children,
}: {
  title: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-xl border border-line bg-panel p-5 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-sm text-muted">{help}</p>
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink">{label}</span>
      <div className="mt-1.5">{children}</div>
      <span className="mt-1 block text-xs text-muted">{help}</span>
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:opacity-60";

export function Settings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const cancelWatch = useRef<(() => void) | null>(null);
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [form, setForm] = useState<Record<string, string>>({});
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [wpfBilling, setWpfBilling] = useState<CompanyBillingAddress>(emptyCompanyBilling());

  useEffect(() => {
    if (!data) return;
    setForm(data);
    setTiers(parseTiers(data.price_tiers));
    setWpfBilling(parseBilling(data.company_billing_wholesale_perfumes));
  }, [data]);

  useEffect(() => () => cancelWatch.current?.(), []);

  const save = useMutation({
    mutationFn: () =>
      api.saveSettings({
        ...form,
        price_tiers: serializeTiers(tiers),
        company_billing_wholesale_perfumes: JSON.stringify(wpfBilling),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
      toast("Settings saved", "ok");
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
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const set = (key: string, value: string) => setForm((prev) => ({ ...prev, [key]: value }));
  const setBool = (key: string, v: boolean) => set(key, v ? "1" : "0");
  const busy = save.isPending;

  const updateTier = (index: number, patch: Partial<TierRow>) => {
    setTiers((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const addTier = () => {
    setTiers((prev) => {
      if (prev.length === 0) return [{ maxCost: "", multiplier: "1.5", unbounded: true }];
      const next = prev.map((r, i) =>
        i === prev.length - 1 ? { ...r, unbounded: false, maxCost: r.maxCost || "80" } : r,
      );
      return [...next, { maxCost: "", multiplier: "1.5", unbounded: true }];
    });
  };

  const removeTier = (index: number) => {
    setTiers((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) return [];
      return next.map((r, i) => ({ ...r, unbounded: i === next.length - 1 }));
    });
  };

  const dryRunOff = !isTruthy(form.orders_dry_run);
  const autoOn = isTruthy(form.orders_auto_dispatch);
  const wholesale = form.sillage_profile === "wholesale";
  const sandboxLocked = wholesale || isTruthy(form.orders_sandbox_locked);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted">
            {wholesale
              ? "Wholesale shop (wholesale-perfumes) — pricing, schedule, €300 minimum order, sandbox dispatch. Vendor API keys live on "
              : "BeautyFort + BTS retail shop — pricing, schedule, cart fee, order safety. Vendor API keys live on "}
            <Link to="/secrets" className="font-medium text-accent hover:underline">
              Secrets
            </Link>
            .
          </p>
        </div>
        <button
          type="button"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-60"
          disabled={busy}
          onClick={() => save.mutate()}
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
      </header>

      <div className="rounded-xl border border-teal-200 bg-gradient-to-br from-teal-50 to-panel px-4 py-3 text-sm">
        <strong className="font-semibold text-ink">First-time path:</strong>{" "}
        <Link to="/secrets" className="font-medium text-accent hover:underline">
          Secrets
        </Link>{" "}
        → fill {wholesale ? "wholesale-perfumes keys" : "BeautyFort + BTS"} →{" "}
        <Link to="/sync" className="font-medium text-accent hover:underline">
          Sync → Rebuild catalogue
        </Link>{" "}
        → check{" "}
        <Link to="/products" className="font-medium text-accent hover:underline">
          Products
        </Link>
        . Catalogue only — never places vendor orders.
      </div>

      {dryRunOff ? (
        <div className="rounded-xl border border-danger/40 bg-red-50 px-4 py-3 text-sm text-danger">
          <strong>Orders dry-run is OFF.</strong> Auto-dispatch and CLI can spend real money. Keep
          dry-run on unless you intend live spend.
          {autoOn ? " Auto-dispatch is also ON — cron will submit without a click." : null}
        </div>
      ) : null}

      <Section
        title="Shop URLs"
        help="Public hosts used by the dashboard and tooling. Compose/env is the bootstrap default; change here after login without redeploying."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label="Shop URL"
            help="Public WooCommerce origin (https://shop…). Used for “Open in WooCommerce” links and customer tracking pushes. In-Docker sync still talks to http://ecom."
          >
            <input
              className={inputClass}
              placeholder="https://shop.example.com"
              value={form.wp_base_url ?? ""}
              disabled={busy}
              onChange={(e) => set("wp_base_url", e.target.value)}
            />
          </Field>
          <Field
            label="Image CDN base URL"
            help="Public origin for product images (https://images…). Tools writing image_overrides.json use this. Saving alone does not rewrite existing product URLs — regenerate overrides then rewrite sync."
          >
            <input
              className={inputClass}
              placeholder="https://images.example.com"
              value={form.image_cdn_base_url ?? ""}
              disabled={busy}
              onChange={(e) => set("image_cdn_base_url", e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Pricing & catalogue"
        help="Retail is written into WooCommerce (_price / _regular_price) so cart, sorting, and filters work. Cost stays in sil_offers; Save on multiplier / tiers / stock / hide-without-image marks products dirty and starts a rewrite-only sync from stored offers (no live vendor download). Per-vendor markup on Vendors does the same."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label="Price multiplier"
            help="Fallback markup when no tier matches (or tiers are empty). Sell = cost × this. Per-vendor multiplier on Vendors disables tiers for that supplier."
          >
            <input
              type="number"
              step="0.01"
              className={inputClass}
              value={form.global_price_multiplier ?? ""}
              disabled={busy}
              onChange={(e) => set("global_price_multiplier", e.target.value)}
            />
          </Field>
          <Field
            label="Stock threshold"
            help="Global floor when a vendor’s min visible stock is empty. Stock ≤ threshold → hidden from catalog + out of stock."
          >
            <input
              type="number"
              step="1"
              className={inputClass}
              value={form.global_stock_threshold ?? ""}
              disabled={busy}
              onChange={(e) => set("global_stock_threshold", e.target.value)}
            />
          </Field>
          <div className="rounded-lg border border-line/70 bg-canvas/40 px-4 py-3 md:col-span-2">
            <Toggle
              label="Hide products without image"
              hint="On: products stay in WooCommerce (and on Products here) but are excluded from the shop catalogue and search. Stock can still be 1."
              checked={isTruthy(form.hide_products_without_image)}
              disabled={busy}
              onChange={(v) => setBool("hide_products_without_image", v)}
            />
            <p className="mt-2 text-xs text-muted">
              After sync, each product’s image is resolved in order: a curated override, then another
              vendor’s photo for the same EAN, then the winning offer’s URL. If that is still empty, a
              placeholder, BTS <span className="font-mono">no_image</span>, or a tiny BeautyFort{" "}
              <span className="font-mono">/pic/</span> thumb, the product gets{" "}
              <span className="font-mono">exclude-from-catalog</span> +{" "}
              <span className="font-mono">exclude-from-search</span> (same terms as the stock
              threshold). Turning this off and saving rewrites visibility so weak thumbs show on the
              shop. Products → Shop column shows Hidden · no image when this rule is why a listing is
              missing from the store.
            </p>
          </div>
        </div>

        <div className="space-y-3 border-t border-line pt-4">
          <div>
            <h3 className="text-sm font-semibold">Price tiers</h3>
            <p className="text-xs text-muted">
              Cost bands (vendor price × FX). First matching max cost wins; the last row is
              unbounded. Empty list → global multiplier only.
            </p>
          </div>
          <div className="space-y-2">
            {tiers.length === 0 ? (
              <p className="text-sm text-muted">No tiers — global multiplier only.</p>
            ) : (
              tiers.map((row, i) => (
                <div key={i} className="flex flex-wrap items-end gap-3">
                  <label className="block text-sm">
                    <span className="text-xs text-muted">Max cost (EUR)</span>
                    <input
                      type="number"
                      step="0.01"
                      className="mt-1 w-36 rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-sm disabled:opacity-50"
                      placeholder={row.unbounded ? "∞" : "80"}
                      value={row.unbounded ? "" : row.maxCost}
                      disabled={busy || row.unbounded}
                      onChange={(e) => updateTier(i, { maxCost: e.target.value })}
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="text-xs text-muted">Multiplier</span>
                    <input
                      type="number"
                      step="0.01"
                      className="mt-1 w-28 rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-sm"
                      value={row.multiplier}
                      disabled={busy}
                      onChange={(e) => updateTier(i, { multiplier: e.target.value })}
                    />
                  </label>
                  <span className="pb-2 text-xs text-muted">{row.unbounded ? "unbounded (last)" : null}</span>
                  <button
                    type="button"
                    className="mb-0.5 rounded-lg border border-line px-2.5 py-1.5 text-xs disabled:opacity-40"
                    disabled={busy}
                    onClick={() => removeTier(i)}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>
          <button
            type="button"
            className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-40"
            disabled={busy}
            onClick={addTier}
          >
            Add tier
          </button>
        </div>
      </Section>

      <Section
        title="Cart minimum (storefront fee)"
        help="Optional small-order fee on the shop cart. Independent of per-vendor MOQ (Vendors → Min order value), which hard-blocks checkout."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-line/70 bg-canvas/40 px-4 py-3 md:col-span-2">
            <Toggle
              label="Small-order fee"
              hint="When on, charge the fee once if cart subtotal is under the floor. Off by default."
              checked={isTruthy(form.cart_min_enabled)}
              disabled={busy}
              onChange={(v) => setBool("cart_min_enabled", v)}
            />
          </div>
          <Field
            label="Cart minimum (EUR)"
            help="Global subtotal floor. Below this, the fee is added (when enabled)."
          >
            <input
              type="number"
              step="0.01"
              className={inputClass}
              value={form.cart_min_subtotal_eur ?? ""}
              disabled={busy}
              onChange={(e) => set("cart_min_subtotal_eur", e.target.value)}
            />
          </Field>
          <Field label="Small-order fee (EUR)" help="Charged once when under the floor — never stacked.">
            <input
              type="number"
              step="0.01"
              className={inputClass}
              value={form.cart_min_fee_eur ?? ""}
              disabled={busy}
              onChange={(e) => set("cart_min_fee_eur", e.target.value)}
            />
          </Field>
          <Field label="Fee label" help="Cart line-item text. Blank → “Small order fee”.">
            <input
              className={inputClass}
              value={form.cart_min_fee_label ?? ""}
              disabled={busy}
              onChange={(e) => set("cart_min_fee_label", e.target.value)}
            />
          </Field>
          <Field
            label="Fee message"
            help="Shown on cart/checkout. Must include {remaining} (WooCommerce formats the amount)."
          >
            <input
              className={inputClass}
              value={form.cart_min_message ?? ""}
              disabled={busy}
              onChange={(e) => set("cart_min_message", e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Schedule"
        help={
          wholesale
            ? "Minutes between syncs is the incremental store XML (price/stock). Daily full rebuild re-downloads the wholesale-perfumes catalogue."
            : "The schedule clock is shared. Minutes between syncs is the incremental check (BeautyFort stock file / BTS daily change batch). Daily full rebuild is the routine catalogue refresh (new products, categories in WordPress). The 25%/7-day BTS pull is emergency recovery only."
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-line/70 bg-canvas/40 px-4 py-3">
            <Toggle
              label="Sync enabled"
              hint="On → the schedule owns price/stock updates. Stop on Sync turns this off. A manual Update does not turn it back on."
              checked={isTruthy(form.sync_enabled)}
              disabled={busy}
              onChange={(v) => setBool("sync_enabled", v)}
            />
          </div>
          <Field
            label="Operator timezone"
            help="IANA zone for dashboard clocks and the daily full-rebuild hour. Does not change the shop for customers."
          >
            <select
              className={inputClass}
              value={resolveTimeZone(form.schedule_timezone)}
              disabled={busy}
              onChange={(e) => set("schedule_timezone", e.target.value)}
            >
              {(() => {
                const current = resolveTimeZone(form.schedule_timezone);
                const known = COMMON_TIMEZONES as readonly string[];
                const list = known.includes(current) ? [...known] : [current, ...known];
                return list.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ));
              })()}
            </select>
          </Field>
          <Field
            label="Minutes between syncs"
            help={
              wholesale
                ? "Not “30 minutes a day” — this is the incremental store (price/stock) check. Daily full rebuild is a separate control below."
                : "Not “30 minutes a day” — this is the incremental check (every 30 / 35 / 120 minutes). Same clock for BeautyFort and BTS; they cool down independently. Daily full rebuild is a separate control below."
            }
          >
            <input
              type="number"
              step="1"
              min={1}
              className={inputClass}
              value={form.live_feed_min_minutes ?? form.fast_sync_minutes ?? ""}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value;
                set("live_feed_min_minutes", v);
                set("fast_sync_minutes", v);
              }}
            />
          </Field>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2 rounded-lg border border-line/70 bg-canvas/40 px-4 py-3">
          <div className="rounded-lg border border-line/70 bg-panel px-4 py-3">
            <Toggle
              label="Daily full catalogue rebuild"
              hint={
                wholesale
                  ? "Routine refresh once per day after the hour below: full wholesale-perfumes catalogue, new products, and WordPress categories. Incremental store checks stay on. Manual Rebuild on Sync still works."
                  : "Routine refresh once per day after the hour below: full BeautyFort + BTS catalogues, new products, and WordPress categories. Incremental 30-minute checks stay on. BTS 25%/7-day recovery stays as emergency backup. Manual Rebuild on Sync still works."
              }
              checked={isTruthy(form.full_sync_enabled)}
              disabled={busy}
              onChange={(v) => setBool("full_sync_enabled", v)}
            />
          </div>
          <Field
            label={`Daily rebuild hour (${resolveTimeZone(form.schedule_timezone)})`}
            help={`0–23 in your operator timezone. ≈ ${utcClockForLocalHour(
              resolveTimeZone(form.schedule_timezone),
              Math.min(23, Math.max(0, Math.trunc(Number(form.full_sync_hour ?? 0)) || 0)),
            )} UTC today. One attempt after this hour; a failure is not retried every tick. Do not enter 30 — that belongs in Minutes between syncs.`}
          >
            <input
              type="number"
              step="1"
              min={0}
              max={23}
              className={inputClass}
              value={form.full_sync_hour ?? ""}
              disabled={busy || !isTruthy(form.full_sync_enabled)}
              onChange={(e) => set("full_sync_hour", e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Order safety"
        help={
          sandboxLocked
            ? "This wholesale instance is sandbox-locked: dry-run stays on and auto-dispatch stays off. Live vendor spend is disabled in code, not only in this toggle."
            : "Fail-closed defaults: dry-run on, auto-dispatch off. Dashboard Dry-run / Live buttons ignore this dry-run flag — they always set their own mode."
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div
            className={cn(
              "rounded-lg border px-4 py-3",
              dryRunOff ? "border-danger/40 bg-red-50" : "border-line/70 bg-canvas/40",
            )}
          >
            <Toggle
              label="Orders dry-run"
              hint={
                sandboxLocked
                  ? "Locked on for this wholesale instance. Dispatch records the payload and never calls the vendor cart/submit APIs."
                  : "When on, auto-dispatch and CLI never spend money. Turn off only when you intend live spend."
              }
              checked={isTruthy(form.orders_dry_run)}
              disabled={busy || sandboxLocked}
              onChange={(v) => setBool("orders_dry_run", v)}
            />
          </div>
          <div className="rounded-lg border border-line/70 bg-canvas/40 px-4 py-3">
            <Toggle
              label="Auto-dispatch"
              hint={
                sandboxLocked
                  ? "Locked off for this wholesale instance until live dispatch is deliberately enabled in code."
                  : "Off = human Approve / Dry-run / Live. On = cron submits due rows using the dry-run flag above."
              }
              checked={isTruthy(form.orders_auto_dispatch)}
              disabled={busy || sandboxLocked}
              onChange={(v) => setBool("orders_auto_dispatch", v)}
            />
          </div>
          <Field label="Max order value (EUR)" help="Blocks approve/dispatch when items cost more than this.">
            <input
              type="number"
              step="0.01"
              className={inputClass}
              value={form.orders_max_value_eur ?? ""}
              disabled={busy}
              onChange={(e) => set("orders_max_value_eur", e.target.value)}
            />
          </Field>
          <Field label="Daily spend cap (EUR)" help="Rolling 24h live spend ceiling across vendors.">
            <input
              type="number"
              step="0.01"
              className={inputClass}
              value={form.orders_daily_cap_eur ?? ""}
              disabled={busy}
              onChange={(e) => set("orders_daily_cap_eur", e.target.value)}
            />
          </Field>
          <Field
            label="Tracking poll minutes"
            help="How often live vendor orders are polled for tracking (minimum 5)."
          >
            <input
              type="number"
              step="1"
              className={inputClass}
              value={form.orders_poll_minutes ?? ""}
              disabled={busy}
              onChange={(e) => set("orders_poll_minutes", e.target.value)}
            />
          </Field>
          <div className="rounded-lg border border-line/70 bg-canvas/40 px-4 py-3">
            <Toggle
              label="Notify customer on tracking"
              hint="Email flag into the WooCommerce bridge when tracking is pushed."
              checked={isTruthy(form.orders_notify_customer)}
              disabled={busy}
              onChange={(v) => setBool("orders_notify_customer", v)}
            />
          </div>
        </div>
      </Section>

      <details className="rounded-xl border border-line bg-panel p-5 shadow-sm open:shadow-sm">
        <summary className="cursor-pointer text-lg font-semibold tracking-tight">
          Advanced
          <span className="ml-2 text-sm font-normal text-muted">
            volume filter, descriptions, company billing
          </span>
        </summary>
        <div className="mt-4 space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Volume filter"
              help="ranges = bucketed ml facets · exact = every ml term · off = hide volume facet."
            >
              <select
                className={inputClass}
                value={form.volume_filter_mode ?? "ranges"}
                disabled={busy}
                onChange={(e) => set("volume_filter_mode", e.target.value)}
              >
                <option value="ranges">ranges</option>
                <option value="exact">exact</option>
                <option value="off">off</option>
              </select>
            </Field>
            <Field
              label="Description mode"
              help="none = title wrapped in &lt;p&gt; · template = brand/type/size blurb. Changing this starts a full/cache sync."
            >
              <select
                className={inputClass}
                value={form.description_mode ?? "none"}
                disabled={busy}
                onChange={(e) => set("description_mode", e.target.value)}
              >
                <option value="none">none</option>
                <option value="template">template</option>
              </select>
            </Field>
          </div>

          <div>
              <h3 className="text-sm font-semibold">Company billing profile</h3>
              <p className="mt-1 text-xs text-muted">
                Invoice / company address sent on wholesale-perfumes dry-run payloads. Live submit
                stays locked until an operator enables it in code.
              </p>
              <div className="mt-3">
                <BillingEditor
                  title="wholesale-perfumes"
                  value={wpfBilling}
                  disabled={busy}
                  onChange={setWpfBilling}
                />
              </div>
            </div>
        </div>
      </details>
    </div>
  );
}

function BillingEditor({
  title,
  value,
  onChange,
  disabled,
}: {
  title: string;
  value: CompanyBillingAddress;
  onChange: (v: CompanyBillingAddress) => void;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-lg border border-line/70 bg-canvas/30 p-4">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {BILLING_FIELDS.map((f) => (
          <label key={f.key} className={cn("block text-sm", f.wide && "sm:col-span-2")}>
            <span className="text-xs text-muted">{f.label}</span>
            <input
              className="mt-1 w-full rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              value={value[f.key]}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
