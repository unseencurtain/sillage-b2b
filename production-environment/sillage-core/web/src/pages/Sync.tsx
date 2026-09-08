import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Play, RefreshCw, Square } from "lucide-react";
import { api, type SyncRun } from "@/lib/api";
import { fetchedLabel } from "@/lib/syncRunLabels";
import { Pagination } from "@/components/Pagination";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/Toast";
import { cn, useFmtDate } from "@/lib/utils";

function isRunActive(run: SyncRun | undefined) {
  if (!run) return false;
  if (run.status === "running") return true;
  return run.finished_at == null || run.finished_at === "";
}

function isRunFinished(run: SyncRun) {
  if (run.finished_at) return true;
  return ["success", "partial", "error"].includes(run.status);
}

function writesLabel(r: Pick<SyncRun, "posts_created" | "posts_updated" | "prices_updated" | "errors">) {
  const parts = [
    `New ${Number(r.posts_created ?? 0).toLocaleString()}`,
    `Updated ${Number(r.posts_updated ?? 0).toLocaleString()}`,
    `Prices ${Number(r.prices_updated ?? 0).toLocaleString()}`,
  ];
  if (r.errors) parts.push(`Errors ${Number(r.errors).toLocaleString()}`);
  return parts.join(" · ");
}

function modeLabel(mode: string, source: string) {
  if (source === "cache" && mode === "fast") return "Price rewrite";
  if (source === "cache" && mode === "full") return "Content rewrite";
  if (mode === "full") return "Rebuild catalogue";
  if (mode === "fast") return "Prices & stock";
  return `${mode}/${source}`;
}

export function Sync() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fmtDate = useFmtDate();
  const [page, setPage] = useState(1);
  const watchingRunId = useRef<number | null>(null);

  const latest = useQuery({
    queryKey: ["sync-runs", 1],
    queryFn: () => api.syncRuns(1),
    refetchInterval: (query) => {
      const newest = query.state.data?.runs?.[0];
      return isRunActive(newest) ? 2_000 : 5_000;
    },
  });
  const list = useQuery({
    queryKey: ["sync-runs", page],
    queryFn: () => api.syncRuns(page),
  });

  const live = useQuery({
    queryKey: ["live-status"],
    queryFn: api.liveStatus,
    refetchInterval: 15_000,
  });

  const secrets = useQuery({
    queryKey: ["secrets"],
    queryFn: api.secrets,
  });

  const data = list.data;
  const isLoading = list.isLoading;
  const runs = data?.runs ?? [];
  const newest = latest.data?.runs?.[0];
  const syncRunning = isRunActive(newest);
  const secretsMissing = (secrets.data?.secrets ?? []).filter((s) => !s.set);
  const cooldownMin = live.data?.retryInMinutes ?? 0;
  const onCooldown = Boolean(live.data && !(live.data.anyAllow ?? live.data.allow));
  const scheduleOn = live.data?.syncEnabled === true;
  const pendingRebuild = live.data?.pendingRebuild === true;
  const catalogueReady = live.data?.catalogueReady !== false;
  const intervalMin = live.data?.cooldownMinutes ?? 30;
  const vendorPair = "wholesale-perfumes";

  const run = useMutation({
    mutationFn: (opts: { mode: "fast" | "full" }) =>
      api.runSync(opts.mode, { source: "live" }),
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      qc.invalidateQueries({ queryKey: ["live-status"] });
      if (res.queued) {
        toast(res.detail ?? "Catalogue rebuild queued for the next scheduled sync.", "ok");
        return;
      }
      if (res.alreadyRunning || res.started === false) {
        toast(
          res.detail ??
            (res.scheduleOwnsSync
              ? "Automatic sync is on — turn Sync enabled off for a one-off update."
              : res.cooldown
                ? `Wait ${res.retryInMinutes ?? "…"} min before the next vendor call.`
                : "Sync already running — watch progress below."),
          "info",
        );
        return;
      }
      toast(
        vars.mode === "full"
          ? "Rebuild started — creating/updating the full catalogue from this shop’s vendor."
          : "Price & stock sync started — updating changed offers only.",
        "ok",
      );
      watchingRunId.current = -1;
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const stop = useMutation({
    mutationFn: () => api.stopSync(),
    onSuccess: (res) => {
      watchingRunId.current = null;
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast(res.detail ?? "Sync stopped — Sync enabled is off until you Run again", "info");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const starting = run.isPending;
  const busy = starting || syncRunning;
  const secretsBlock = secretsMissing.length > 0;
  const fastDisabled = busy || secretsBlock || scheduleOn || onCooldown;
  const rebuildDisabled = busy || secretsBlock || (pendingRebuild && scheduleOn && catalogueReady);

  useEffect(() => {
    if (watchingRunId.current === -1 && newest && isRunActive(newest)) {
      watchingRunId.current = newest.id;
      return;
    }
    if (watchingRunId.current == null || watchingRunId.current < 0) return;
    if (!newest || newest.id !== watchingRunId.current) return;
    if (!isRunFinished(newest)) return;

    const id = watchingRunId.current;
    watchingRunId.current = null;
    qc.invalidateQueries({ queryKey: ["live-status"] });
    if (newest.status === "success" || newest.status === "partial") {
      toast(
        `Sync #${id} finished (${newest.status}) — ${writesLabel(newest)}`,
        "ok",
      );
    } else {
      toast(`Sync #${id} failed (${newest.status})`, "error");
    }
  }, [newest, toast, qc]);

  const lastRunSummary = useMemo(() => {
    if (!newest) return null;
    return {
      id: newest.id,
      status: newest.status,
      mode: newest.mode,
      source: newest.source,
      finished: isRunFinished(newest),
    };
  }, [newest]);

  const stopEnabled = syncRunning && !stop.isPending;
  const stopTitle = syncRunning
    ? "Abort the active run between batches and turn Sync enabled off until you Run again"
    : "No sync running";

  const cooldownHint = scheduleOn
    ? `Automatic price & stock every ${intervalMin} min. Update is a one-off only when Sync enabled is off.`
    : onCooldown
      ? `Next vendor call in ${cooldownMin} min.`
      : `Call interval ${intervalMin} min after each live fetch (no daily download cap).`;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Sync</h1>
        <p className="text-sm text-muted">
          <strong className="font-medium text-ink">Rebuild catalogue</strong> queues a full {vendorPair}{" "}
          import for the next scheduled call (or runs now if the shop is empty / sync is off).{" "}
          <strong className="font-medium text-ink">Update prices &amp; stock</strong> is a one-off —
          hide it while the schedule is on.
        </p>
      </header>

      {secretsMissing.length > 0 ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Vendor secrets incomplete.</strong> Missing{" "}
          {secretsMissing.map((s) => s.key).join(", ")}.{" "}
          <Link to="/secrets" className="font-medium underline underline-offset-2">
            Open Secrets
          </Link>{" "}
          before a live sync will succeed.
        </div>
      ) : null}

      <section className="rounded-xl border border-teal-200 bg-gradient-to-br from-teal-50 to-panel px-5 py-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl space-y-2">
            <h2 className="text-lg font-semibold tracking-tight text-ink">Catalogue actions</h2>
            <p className="text-sm text-muted">
              Empty shop → Rebuild now. After that, leave Sync enabled on and the cadence calls each
              wholesaler API on the interval. Rebuild while scheduled: next call becomes a catalogue
              rebuild, not an immediate extra download.
            </p>
            <p className={cn("text-xs", scheduleOn || onCooldown ? "font-medium text-amber-800" : "text-muted")}>
              {cooldownHint}
            </p>
            {live.data ? (
              <p className="font-mono text-xs text-muted">
                {`WPF ${
                  live.data.wholesalePerfumes?.allow ?? live.data.allow
                    ? "ready"
                    : `wait ${live.data.wholesalePerfumes?.retryInMinutes ?? live.data.retryInMinutes}m`
                }`}
                {pendingRebuild ? " · rebuild queued" : ""}
                {scheduleOn ? " · schedule on" : " · schedule off"}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col items-stretch gap-2 sm:items-end">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-busy={busy && run.variables?.mode === "fast"}
                className={cn(
                  "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-base font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50",
                  syncRunning
                    ? "bg-accent text-accent-ink opacity-95 ring-2 ring-accent/30 ring-offset-2 ring-offset-panel"
                    : "bg-accent text-accent-ink hover:opacity-95",
                )}
                disabled={fastDisabled}
                title={
                  scheduleOn
                    ? `Schedule is on — it will call ${vendorPair} on the interval. Turn Sync enabled off for a one-off.`
                    : onCooldown
                      ? cooldownHint
                      : `One-off live price/stock for ${vendorPair}`
                }
                onClick={() => run.mutate({ mode: "fast" })}
              >
                {busy && run.variables?.mode === "fast" ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <Play size={18} />
                )}
                {syncRunning
                  ? "Syncing…"
                  : scheduleOn
                    ? `Scheduled (${intervalMin}m)`
                    : onCooldown
                      ? `Update in ${cooldownMin}m`
                      : "Update prices & stock"}
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-panel px-4 py-3 text-sm font-semibold transition hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
                disabled={rebuildDisabled}
                title={
                  pendingRebuild
                    ? "Already queued — the next scheduled call will rebuild the catalogue"
                    : scheduleOn && catalogueReady
                      ? `Queue a full ${vendorPair} rebuild for the next scheduled call`
                      : "Full catalogue rebuild now — taxonomy, new products, vanish"
                }
                onClick={() => run.mutate({ mode: "full" })}
              >
                <RefreshCw size={16} />
                {pendingRebuild ? "Rebuild queued" : "Rebuild catalogue"}
              </button>
              <button
                type="button"
                title={stopTitle}
                aria-disabled={!stopEnabled}
                className={cn(
                  "inline-flex items-center justify-center gap-1.5 rounded-xl border px-4 py-3 text-sm font-medium transition disabled:cursor-not-allowed",
                  syncRunning
                    ? "border-danger/50 bg-red-50 text-danger hover:bg-red-100"
                    : "border-line bg-canvas text-muted opacity-60",
                )}
                disabled={!stopEnabled}
                onClick={() => stop.mutate()}
              >
                {stop.isPending ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
                {stop.isPending ? "Stopping…" : "Stop"}
              </button>
            </div>
            <p className="max-w-sm text-right text-xs text-muted">
              {syncRunning
                ? "Stop aborts between batches and turns Sync enabled off until you toggle it back on."
                : "Minutes between syncs is under Settings. Daily download caps are off — only the call interval applies."}
            </p>
          </div>
        </div>
      </section>

      {syncRunning ? (
        <div className="flex items-center gap-3 rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-3 text-sm">
          <Loader2 size={18} className="animate-spin text-accent" />
          <div>
            <div className="font-medium text-ink">Syncing…</div>
            <div className="text-muted">
              Run #{newest?.id} · {modeLabel(newest?.mode ?? "", newest?.source ?? "")} — start
              buttons disabled
            </div>
          </div>
        </div>
      ) : null}

      {lastRunSummary ? (
        <div
          className={cn(
            "rounded-xl border px-4 py-3",
            lastRunSummary.finished ? "border-line bg-panel" : "border-amber-200 bg-amber-50/60",
          )}
        >
          <div className="flex flex-wrap items-center gap-3">
            <RefreshCw size={16} className="text-muted" />
            <span className="text-sm font-medium">Last run</span>
            <StatusBadge status={lastRunSummary.status} />
            <span className="text-sm text-muted">
              #{lastRunSummary.id} · {modeLabel(lastRunSummary.mode, lastRunSummary.source)}
            </span>
            {newest?.finished_at ? (
              <span className="text-sm text-muted">finished {fmtDate(newest.finished_at)}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas/70 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">ID</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Fetched</th>
              <th className="px-4 py-3">
                Shop writes
                <span className="mt-0.5 block font-normal normal-case tracking-normal text-[11px] text-muted/80">
                  New products · listing updates · prices
                </span>
              </th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Started</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td className="px-4 py-6 text-muted" colSpan={7}>
                  Loading…
                </td>
              </tr>
            ) : runs.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-muted" colSpan={7}>
                  No sync runs yet — Rebuild catalogue after Secrets are set.
                </td>
              </tr>
            ) : (
              runs.map((r) => (
                <tr
                  key={r.id}
                  className={cn(
                    "border-b border-line/70 last:border-0",
                    r.id === newest?.id && syncRunning && "bg-teal-50/40",
                  )}
                >
                  <td className="px-4 py-3 font-mono tabular-nums">#{r.id}</td>
                  <td className="px-4 py-3">{modeLabel(r.mode, r.source)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs tabular-nums">{fetchedLabel(r)}</td>
                  <td className="px-4 py-3 text-xs tabular-nums text-muted">
                    {writesLabel(r)}
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums">
                    {r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted">{fmtDate(r.started_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {data ? (
        <Pagination page={page} limit={data.limit} total={data.total} onPageChange={setPage} />
      ) : null}
    </div>
  );
}
