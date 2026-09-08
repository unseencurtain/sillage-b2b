/**
 * Cooperative sync abort. Dashboard Stop sets a flag; long runs check it between vendors/batches.
 */
import { sil } from "../config/env.ts";
import { execute, query, type RowDataPacket } from "../db/pool.ts";
import { setSetting } from "../db/settings.ts";

const ABORT_KEY = "sync_abort";

export async function requestSyncAbort(): Promise<void> {
  await setSetting(ABORT_KEY, "1");
  // Flip the kill switch so the scheduler will not start another run until an operator re-enables.
  await setSetting("sync_enabled", "0");
  await execute(
    `UPDATE ${sil("sil_sync_runs")}
        SET status = 'error', finished_at = NOW(),
            error_message = COALESCE(error_message, 'aborted from dashboard')
      WHERE status = 'running' AND finished_at IS NULL`,
  );
}

export async function clearSyncAbort(): Promise<void> {
  await setSetting(ABORT_KEY, "0");
}

export async function isSyncAbortRequested(): Promise<boolean> {
  const [row] = await query<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = ?`,
    [ABORT_KEY],
  );
  return row?.setting_value === "1" || row?.setting_value === "true";
}

export class SyncAbortedError extends Error {
  constructor(message = "sync aborted from dashboard") {
    super(message);
    this.name = "SyncAbortedError";
  }
}

export async function throwIfSyncAborted(): Promise<void> {
  if (await isSyncAbortRequested()) throw new SyncAbortedError();
}
