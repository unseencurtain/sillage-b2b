import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { fetchedLabel } from "@/lib/syncRunLabels";
import { KpiCard } from "@/components/KpiCard";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/Toast";
import { cn, useFmtDate } from "@/lib/utils";

function isRunActive(run: { status: string; finished_at?: string | null } | null | undefined) {
  if (!run) return false;
  if (run.status === "running") return true;
  return run.finished_at == null || run.finished_at === "";
}

export function Overview() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fmtDate = useFmtDate();
  const { data, isLoading, error } = useQuery({
    queryKey: ["overview"],
    queryFn: api.overview,
    refetchInterval: 15_000,
  });

  const live = useQuery({
    queryKey: ["live-status"],
    queryFn: api.liveStatus,
    refetchInterval: 15_000,
  });

  const syncRunning = isRunActive(data?.lastSync);
  const scheduleOn = Boolean(data?.settings.syncEnabled);
  const onCooldown = Boolean(live.data && !(live.data.anyAllow ?? live.data.allow));
  const cooldownMin = live.data?.retryInMinutes ?? 0;
  const intervalMin = live.data?.cooldownMinutes ?? 30;
  const run = useMutation({
    mutationFn: () => api.runSync("fast", { source: "live" }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["overview"] });
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
      qc.invalidateQueries({ queryKey: ["live-status"] });
      if (res.alreadyRunning || res.started === false) {
        toast(
          res.detail ??
            (res.queued
              ? "Rebuild queued for the next scheduled sync."
              : res.scheduleOwnsSync
                ? "Automatic sync is on — use Settings to turn it off for a one-off."
                : res.cooldown
                  ? `Wait ${res.retryInMinutes ?? "…"} min before the next sync.`
                  : "Sync already running — watch progress on Sync."),
          "info",
        );
        return;
      }
      toast("Price & stock sync started — open Sync for progress.", "ok");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  if (isLoading) return <p className="text-muted">Loading overview…</p>;
  if (error || !data) return <p className="text-danger">Failed to load overview</p>;

  const orderTotal = Object.values(data.ordersByStatus).reduce((a, b) => a + b, 0);
  const catalogVisible = data.catalogVisible ?? data.published;
  const hiddenFromCatalog = data.hiddenFromCatalog ?? Math.max(0, data.published - catalogVisible);
  const hiddenNoImage = data.hiddenNoImage ?? 0;
  const hiddenStock = data.hiddenStock ?? 0;
  const hiddenOperator = data.hiddenOperator ?? 0;
  const outOfStock = data.outOfStock ?? 0;
  // Hide reasons are exclusive — one per product — so they have to account for every hidden
  // product. Surface any shortfall rather than letting the tiles quietly disagree with their own
  // total.
  const unattributedHidden = Math.max(0, hiddenFromCatalog - hiddenNoImage - hiddenStock - hiddenOperator);
  // Out of stock counts every such product; the hidden breakdown counts a photo-less one under
  // "no photo" instead. The difference is the overlap, which is worth naming on the tile.
  const alsoNoPhotoAndOos = Math.max(0, outOfStock - hiddenStock);
  const busy = run.isPending || syncRunning;
  const secretsReady = data.secrets?.ready !== false;
  const missingSecrets = data.secrets?.missing ?? [];
  const actionsDisabled = busy || onCooldown || !secretsReady || scheduleOn;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted">
            Secrets → Rebuild catalogue (empty shop or queued) → scheduled prices &amp; stock. Never
            places vendor orders.{" "}
            <Link to="/sync" className="font-medium text-accent hover:underline">
              Sync
            </Link>
          </p>
        </div>
        <button
          type="button"
          aria-busy={busy}
          title={
            scheduleOn
              ? `Scheduled every ${intervalMin} min — turn Sync enabled off for a one-off`
              : onCooldown
                ? `Available in ${cooldownMin} min`
                : "One-off Update prices & stock for this shop’s vendors. Not orders."
          }
          className={cn(
            "inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink disabled:cursor-not-allowed disabled:opacity-50",
            syncRunning && "ring-2 ring-accent/30 ring-offset-2",
          )}
          disabled={actionsDisabled}
          onClick={() => run.mutate()}
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          {syncRunning
            ? "Syncing…"
            : run.isPending
              ? "Starting…"
              : scheduleOn
              ? `Scheduled (${intervalMin}m)`
              : onCooldown
                ? `Update in ${cooldownMin}m`
                : "Update prices & stock"}
        </button>
      </header>

      {!secretsReady ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Set vendor secrets first.</strong> Missing {missingSecrets.join(", ") || "vendor keys"}.{" "}
          <Link to="/secrets" className="font-medium underline underline-offset-2">
            Open Secrets
          </Link>{" "}
          then open Sync and Rebuild catalogue.
        </div>
      ) : (
        <div className="rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3 text-sm text-muted">
          <strong className="text-ink">Path:</strong> Secrets set →{" "}
          <Link to="/sync" className="font-medium text-accent hover:underline">
            Sync
          </Link>{" "}
          → Rebuild catalogue, then leave Sync enabled on for the call interval →{" "}
          <Link to="/products" className="font-medium text-accent hover:underline">
            Products
          </Link>
          .
        </div>
      )}

      {!data.settings.dryRun ? (
        <div className="rounded-xl border border-danger/40 bg-red-50 px-4 py-3 text-sm text-danger">
          <strong>Orders dry-run is OFF</strong> — auto-dispatch / CLI can spend real money. Keep
          dry-run on in Settings unless you intend live spend.
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Visible in shop"
          value={catalogVisible.toLocaleString()}
          hint="customers can browse these — hide-without-image and out-of-stock stay published but off the loop"
          accent
        />
        <KpiCard
          label="Published in WP"
          value={data.published.toLocaleString()}
          hint={
            hiddenFromCatalog > 0
              ? `${hiddenFromCatalog.toLocaleString()} hidden from catalog`
              : "all catalog-visible"
          }
        />
        <KpiCard label="Sillage products" value={data.products.toLocaleString()} />
        <KpiCard
          label="Sync"
          value={data.settings.syncEnabled ? "on" : "off"}
          hint={data.settings.dryRun ? "orders: dry-run" : "orders: LIVE"}
          accent={!data.settings.dryRun}
        />
      </div>

      <section className="rounded-xl border border-line bg-panel p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Catalogue visibility</h2>
          <span className="font-mono text-xs tabular-nums text-muted">
            {data.offers.toLocaleString()} active offers
          </span>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <VisibilityStat label="Visible in shop" value={catalogVisible} />
          <VisibilityStat label="Published (WP)" value={data.published} />
          <VisibilityStat
            label="Hidden from catalog"
            value={hiddenFromCatalog}
            hint={
              hiddenFromCatalog > 0
                ? [
                    hiddenNoImage > 0 ? `${hiddenNoImage.toLocaleString()} no photo` : null,
                    hiddenStock > 0 ? `${hiddenStock.toLocaleString()} out of stock (has a photo)` : null,
                    hiddenOperator > 0 ? `${hiddenOperator.toLocaleString()} pinned` : null,
                    // One reason per product, so these must total the tile above. When they do not,
                    // say so here: a silent shortfall is how a bad hide-reason query survived a
                    // rebuild on the retail shop, reporting 675 photo-less products out of 12,003
                    // while 9,129 hidden products sat in no bucket at all.
                    unattributedHidden > 0
                      ? `${unattributedHidden.toLocaleString()} unattributed — please report this`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : undefined
            }
          />
          <VisibilityStat
            label="Out of stock"
            value={outOfStock}
            hint={[
              // Every out-of-stock product, including those also missing a photo — so this is
              // deliberately larger than the "out of stock" share of Hidden from catalog, which
              // counts a product once under its first reason.
              alsoNoPhotoAndOos > 0
                ? `${alsoNoPhotoAndOos.toLocaleString()} of these also have no photo`
                : null,
              data.settings.hideProductsWithoutImage
                ? `Woo outofstock term · hide without image on · threshold ${data.settings.stockThreshold ?? 0}`
                : `Woo outofstock term · threshold ${data.settings.stockThreshold ?? 0}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        </div>
        <p className="mt-3 font-mono text-xs tabular-nums text-muted">
          {catalogVisible.toLocaleString()} visible + {hiddenFromCatalog.toLocaleString()} hidden ={" "}
          {data.published.toLocaleString()} published
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Last sync</h2>
            {data.lastSync ? <StatusBadge status={data.lastSync.status} /> : null}
          </div>
          {data.lastSync ? (
            <div className="mt-3 space-y-2 text-sm">
              <div className="font-mono text-muted">
                #{data.lastSync.id} · {data.lastSync.mode} · {data.lastSync.source}
              </div>
              <div className="text-muted">{fmtDate(data.lastSync.started_at)}</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs tabular-nums sm:grid-cols-3">
                <span>{fetchedLabel(data.lastSync)}</span>
                <span>created {data.lastSync.posts_created}</span>
                <span>updated {data.lastSync.posts_updated}</span>
                <span>repriced {data.lastSync.prices_updated}</span>
                <span className={data.lastSync.errors ? "text-danger" : ""}>errors {data.lastSync.errors}</span>
                <span>{(data.lastSync.duration_ms / 1000).toFixed(1)}s</span>
              </div>
              <Link to="/sync" className="inline-block text-xs font-medium text-accent hover:underline">
                Open Sync for progress →
              </Link>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">No sync runs yet</p>
          )}
        </section>

        <section className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Vendor orders</h2>
            {orderTotal > 0 ? (
              <span className="font-mono text-xs tabular-nums text-muted">{orderTotal} total</span>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.keys(data.ordersByStatus).length === 0 ? (
              <p className="text-sm text-muted">No orders ingested yet</p>
            ) : (
              Object.entries(data.ordersByStatus).map(([status, n]) => (
                <div
                  key={status}
                  className="flex items-center gap-2 rounded-lg border border-line bg-canvas/40 px-3 py-2"
                >
                  <StatusBadge status={status} />
                  <span className="font-mono text-sm tabular-nums">{n}</span>
                </div>
              ))
            )}
          </div>
          <div className="mt-4 flex flex-wrap gap-3 border-t border-line pt-3 text-xs text-muted">
            <span>
              auto-dispatch{" "}
              <strong className={data.settings.autoDispatch ? "text-warn" : "text-ink"}>
                {data.settings.autoDispatch ? "on" : "off"}
              </strong>
            </span>
            <span>
              dry-run{" "}
              <strong className={data.settings.dryRun ? "text-ok" : "text-danger"}>
                {data.settings.dryRun ? "on" : "OFF"}
              </strong>
            </span>
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-line bg-panel p-5 shadow-sm">
        <h2 className="text-sm font-semibold">Syncs · last 7 days</h2>
        <div className="mt-4 h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.syncsLast7Days}>
              <XAxis dataKey="day" tick={{ fontSize: 12, fill: "#5b6b7c" }} axisLine={{ stroke: "#e2e8ef" }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: "#5b6b7c" }} axisLine={{ stroke: "#e2e8ef" }} />
              <Tooltip
                contentStyle={{
                  borderRadius: 8,
                  border: "1px solid #e2e8ef",
                  fontSize: 12,
                }}
              />
              <Bar dataKey="n" fill="#0f766e" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}

function VisibilityStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-canvas/40 px-3 py-2.5">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-ink">
        {value.toLocaleString()}
      </div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}
