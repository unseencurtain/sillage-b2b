import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("pending price rewrite on Save", () => {
  const pendingSrc = readFileSync(join(import.meta.dir, "../src/sync/pendingRewrite.ts"), "utf8");
  const apiSrc = readFileSync(join(import.meta.dir, "../src/server/routes/api.ts"), "utf8");
  const runSrc = readFileSync(join(import.meta.dir, "../src/sync/run.ts"), "utf8");

  test("exports kick + drain for settings/vendor Save", () => {
    expect(pendingSrc).toContain("export async function kickPriceRewrite");
    expect(pendingSrc).toContain("export async function kickContentRewrite");
    expect(pendingSrc).toContain("export async function drainPendingRewrites");
    expect(pendingSrc).toContain("export async function queueCatalogueRebuild");
    expect(pendingSrc).toContain("pending_catalogue_rebuild");
    expect(pendingSrc).toContain('rewriteOnly: true');
    expect(pendingSrc).toContain('source: "cache"');
  });

  test("runSync drains pending rewrites after releasing the lock", () => {
    expect(runSrc).toContain("drainPendingRewrites");
    expect(runSrc).toContain('await import("./pendingRewrite.ts")');
  });

  test("runSync releases the advisory lock even if startRun fails", () => {
    // Lock acquire must be paired with try/finally before any throwy setup (ENUM, no vendors).
    // GET_LOCK is connection-scoped — must hold one dedicated pool connection for the run.
    expect(runSrc).toContain("acquireLockOn");
    expect(runSrc).toContain("releaseLockOn");
    expect(runSrc).toContain("getPool().getConnection()");
    expect(runSrc).toContain("lockConn.release()");
    expect(runSrc).toContain("lockConn.destroy()");
    const acquireAt = runSrc.indexOf('if (!(await acquireLockOn(lockConn, "sync")))');
    const tryAt = runSrc.indexOf("try {", acquireAt);
    const startRunAt = runSrc.indexOf("await startRun(", acquireAt);
    expect(acquireAt).toBeGreaterThan(-1);
    expect(tryAt).toBeGreaterThan(acquireAt);
    expect(startRunAt).toBeGreaterThan(tryAt);
    expect(runSrc).toContain("if (runId > 0)");
  });

  test("content rewrite lock race re-flags price pending", () => {
    expect(pendingSrc).toContain("if (hadPrice) await flagPending(\"price\")");
  });

  test("settings Save only kicks rewrite when price/content values change", () => {
    expect(apiSrc).toContain("prior.get(key) !== persist");
    expect(apiSrc).toContain("if (!changed) continue");
  });

  test("settings and vendor pricing Save kick rewrite-only", () => {
    expect(apiSrc).toContain("kickPriceRewrite");
    expect(apiSrc).toContain("kickContentRewrite");
    expect(apiSrc).toContain("patch.fxRate !== undefined");
    expect(apiSrc).toContain("patch.minVisibleStock !== undefined");
    expect(apiSrc).toContain("global_price_multiplier");
    expect(apiSrc).toContain("alreadyRunning");
  });

  test("schedule_timezone is allow-listed and does not kick catalogue rewrite", () => {
    expect(apiSrc).toContain('"schedule_timezone"');
    expect(apiSrc).toContain("resolveTimeZone");
    const priceKeysBlock = apiSrc.slice(
      apiSrc.indexOf("const priceKeys = new Set"),
      apiSrc.indexOf("const contentKeys = new Set"),
    );
    expect(priceKeysBlock).not.toContain("schedule_timezone");
  });

  test("migration widens sil_sync_runs.source for cache/rewrite-only", () => {
    const mig = readFileSync(
      join(import.meta.dir, "../migrations/018_sync_run_source_cache.sql"),
      "utf8",
    );
    expect(mig).toContain("sil_sync_runs");
    expect(mig).toContain("'cache'");
    expect(mig).toContain("ENUM('live', 'local', 'cache')");
  });
});

