/**
 * Queue a settings/vendor-driven WooCommerce rewrite when the sync lock is held.
 *
 * Multiplier / FX / VAT / tiers live outside offer hashes. Saving them marks products dirty and
 * must start (or queue) a rewrite-only run from sil_offers — no live vendor download.
 */
import { setSetting } from "../db/settings.ts";
import { query, type RowDataPacket } from "../db/pool.ts";
import { lockName, sil } from "../config/env.ts";
import { logger } from "../lib/log.ts";
import { runSync } from "./run.ts";

const log = logger("sync");

const PENDING_PRICE_KEY = "pending_price_rewrite";
const PENDING_CONTENT_KEY = "pending_content_rewrite";
const PENDING_REBUILD_KEY = "pending_catalogue_rebuild";

export type RewriteKickStatus = "started" | "queued";

export async function isSyncLockHeld(): Promise<boolean> {
  const rows = await query<RowDataPacket & { holder: number | null }>(
    `SELECT IS_USED_LOCK(?) AS holder`,
    [lockName("sync")],
  );
  return rows[0]?.holder != null;
}

/** True when the newest sil_sync_runs row is still open (UI / API honesty). */
export async function hasActiveSyncRun(): Promise<boolean> {
  const rows = await query<RowDataPacket & { status: string; finished_at: string | null }>(
    `SELECT status, finished_at FROM ${sil("sil_sync_runs")} ORDER BY id DESC LIMIT 1`,
    [],
  );
  const row = rows[0];
  if (!row) return false;
  if (row.status === "running") return true;
  return row.finished_at == null || row.finished_at === "";
}

async function flagPending(kind: "price" | "content"): Promise<void> {
  await setSetting(kind === "content" ? PENDING_CONTENT_KEY : PENDING_PRICE_KEY, "1");
}

async function readFlag(key: string): Promise<boolean> {
  const rows = await query<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = ? LIMIT 1`,
    [key],
  );
  const v = rows[0]?.setting_value;
  return v === "1" || v === "true";
}

async function clearFlag(key: string): Promise<void> {
  await setSetting(key, "0");
}

/**
 * Consume pending flags and fire runSync. Re-flags if the lock races.
 * Content pending wins (full/cache also rewrites prices).
 */
async function tryStartFromPending(): Promise<RewriteKickStatus> {
  if (await isSyncLockHeld()) return "queued";

  const wantContent = await readFlag(PENDING_CONTENT_KEY);
  const wantPrice = await readFlag(PENDING_PRICE_KEY);
  if (!wantContent && !wantPrice) return "queued";

  if (wantContent) {
    // Content rewrite also refreshes prices. Keep price pending until the run actually
    // starts — if we race the lock, re-flag both so a multiplier Save is not lost.
    await clearFlag(PENDING_CONTENT_KEY);
    const hadPrice = wantPrice;
    if (hadPrice) await clearFlag(PENDING_PRICE_KEY);
    void runSync({ mode: "full", source: "cache" }).catch(async (err) => {
      if (String(err).includes("another sync is already running")) {
        await flagPending("content");
        if (hadPrice) await flagPending("price");
        log.info("content rewrite: lock busy — left pending for drain after current run");
        return;
      }
      // Non-lock failure: leave flags clear so we do not spin forever; operator can Save again.
      log.error("content rewrite failed", String(err));
    });
    return "started";
  }

  await clearFlag(PENDING_PRICE_KEY);
  void runSync({ mode: "fast", source: "cache", rewriteOnly: true }).catch(async (err) => {
    if (String(err).includes("another sync is already running")) {
      await flagPending("price");
      log.info("price rewrite: lock busy — left pending for drain after current run");
      return;
    }
    log.error("price rewrite failed", String(err));
  });
  return "started";
}

/**
 * Mark a follow-up price rewrite and try to start it now (rewrite-only from sil_offers).
 * If the sync lock is held, the flag stays set; `drainPendingRewrites` runs after the active sync.
 */
export async function kickPriceRewrite(): Promise<RewriteKickStatus> {
  await flagPending("price");
  return tryStartFromPending();
}

/** Full/cache rewrite for description / volume-mode changes. */
export async function queueCatalogueRebuild(): Promise<void> {
  await setSetting(PENDING_REBUILD_KEY, "1");
}

export async function isCatalogueRebuildPending(): Promise<boolean> {
  return readFlag(PENDING_REBUILD_KEY);
}

/** Returns true when a rebuild was waiting, and clears the flag. */
export async function consumeCatalogueRebuildFlag(): Promise<boolean> {
  const pending = await readFlag(PENDING_REBUILD_KEY);
  if (pending) await clearFlag(PENDING_REBUILD_KEY);
  return pending;
}

export async function restoreCatalogueRebuildFlag(): Promise<void> {
  await setSetting(PENDING_REBUILD_KEY, "1");
}

export async function kickContentRewrite(): Promise<RewriteKickStatus> {
  await flagPending("content");
  return tryStartFromPending();
}

/** Called after every sync releases the advisory lock. */
export async function drainPendingRewrites(): Promise<void> {
  if (!(await readFlag(PENDING_CONTENT_KEY)) && !(await readFlag(PENDING_PRICE_KEY))) return;
  const status = await tryStartFromPending();
  if (status === "queued") {
    log.info("pending rewrite still blocked — another holder grabbed the lock");
  }
}
