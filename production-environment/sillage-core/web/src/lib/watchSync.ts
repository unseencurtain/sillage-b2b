import type { QueryClient } from "@tanstack/react-query";
import { api, type SyncRun } from "@/lib/api";

function isRunActive(run: SyncRun | undefined) {
  if (!run) return false;
  if (run.status === "running") return true;
  return run.finished_at == null || run.finished_at === "";
}

function isRunFinished(run: SyncRun) {
  if (run.finished_at) return true;
  return ["success", "partial", "error"].includes(run.status);
}

/**
 * After a pricing Save, poll Sync runs until the active (or next) rewrite finishes.
 * Returns a cancel function.
 */
export function watchSyncUntilIdle(
  qc: QueryClient,
  toast: (message: string, kind: "ok" | "info" | "error") => void,
  opts?: { expectFollowUp?: boolean },
): () => void {
  let cancelled = false;
  let sawActive = false;
  let ticks = 0;
  const maxTicks = 180; // ~6 min at 2s

  const tick = async () => {
    if (cancelled) return;
    ticks++;
    try {
      await qc.invalidateQueries({ queryKey: ["sync-runs"] });
      await qc.invalidateQueries({ queryKey: ["overview"] });
      const page = await api.syncRuns(1);
      const newest = page.runs[0];
      if (isRunActive(newest)) {
        sawActive = true;
      } else if (sawActive && newest && isRunFinished(newest)) {
        if (newest.status === "success" || newest.status === "partial") {
          toast(
            `Prices updated (run #${newest.id}) — ${newest.prices_updated} repriced. Check Products or the shop.`,
            "ok",
          );
        } else {
          toast(`Price rewrite #${newest.id} failed (${newest.status})`, "error");
        }
        await qc.invalidateQueries({ queryKey: ["products"] });
        return;
      } else if (!sawActive && !opts?.expectFollowUp && ticks >= 3) {
        // Nothing started — stop quietly (e.g. marked=0).
        return;
      } else if (!sawActive && opts?.expectFollowUp && ticks >= 5) {
        // Queued behind another run that may have finished before we attached — keep waiting a bit.
        sawActive = true;
      }
    } catch {
      // ignore transient poll errors
    }
    if (ticks >= maxTicks) {
      toast("Still recalculating prices — open Sync for live progress.", "info");
      return;
    }
    timer = setTimeout(() => void tick(), 2_000);
  };

  let timer: ReturnType<typeof setTimeout> = setTimeout(() => void tick(), 500);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
