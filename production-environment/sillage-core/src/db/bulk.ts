import type { PoolConnection } from "./pool.ts";

/**
 * Execute a multi-row INSERT split into statements that stay under a byte budget.
 *
 * `max_allowed_packet` caps a single statement, not a row count, so batching by rows either
 * wastes round trips on narrow tables or overflows on wide ones. Sizing by estimated bytes gets
 * both right.
 */
export async function bulkInsert(
  conn: PoolConnection,
  prefix: string,
  rowPlaceholder: string,
  rows: unknown[][],
  suffix = "",
  maxBytes = 4_194_304,
): Promise<number> {
  if (rows.length === 0) return 0;

  const overhead = Buffer.byteLength(prefix) + Buffer.byteLength(suffix) + 64;
  let written = 0;
  let batch: unknown[][] = [];
  let batchBytes = overhead;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const sql = `${prefix} VALUES ${batch.map(() => rowPlaceholder).join(",")} ${suffix}`;
    await conn.query(sql, batch.flat());
    written += batch.length;
    batch = [];
    batchBytes = overhead;
  };

  for (const row of rows) {
    const size = estimateRowBytes(row);
    // A single row larger than the budget still has to go out on its own.
    if (batch.length > 0 && batchBytes + size > maxBytes) await flush();
    batch.push(row);
    batchBytes += size;
  }
  await flush();

  return written;
}

function estimateRowBytes(row: unknown[]): number {
  let bytes = row.length * 4; // separators and quoting
  for (const value of row) {
    if (value === null || value === undefined) bytes += 4;
    else if (typeof value === "number") bytes += 20;
    else if (typeof value === "boolean") bytes += 1;
    else if (value instanceof Date) bytes += 20;
    else bytes += Buffer.byteLength(String(value)) + 2;
  }
  return bytes;
}

/** `DELETE ... WHERE col IN (...)` split into chunks so the IN list never grows unbounded. */
export async function deleteByIds(
  conn: PoolConnection,
  table: string,
  column: string,
  ids: Array<number | string>,
  chunkSize = 2000,
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const [res] = await conn.query(
      `DELETE FROM ${table} WHERE ${column} IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    );
    deleted += (res as { affectedRows: number }).affectedRows;
  }
  return deleted;
}
