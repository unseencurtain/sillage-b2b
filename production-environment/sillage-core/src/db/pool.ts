import mysql, { type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from "mysql2/promise";
import { env } from "../config/env.ts";
import { logger } from "../lib/log.ts";

const log = logger("db");

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;
  pool = mysql.createPool({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    // Deliberately no `database`. Every statement fully qualifies its schema, because a pooled
    // connection's default schema leaks between borrowers and the writer spans two databases.
    connectionLimit: env.db.connectionLimit,
    waitForConnections: true,
    charset: "utf8mb4_unicode_ci",
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true,
    namedPlaceholders: false,
    // The writer builds large multi-row INSERT statements; keep them as one round trip.
    maxPreparedStatements: 200,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}

export async function query<T extends RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await getPool().query<T[]>(sql, params);
  return rows;
}

export async function queryOne<T extends RowDataPacket>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

export async function execute(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [result] = await getPool().query<ResultSetHeader>(sql, params);
  return result;
}

/**
 * Run `fn` inside a transaction on a dedicated connection. Rolls back on throw.
 *
 * The sync writer uses one transaction per batch rather than one per run, so a failure in batch 40
 * leaves batches 1-39 committed.
 */
export async function transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      log.error("rollback failed", String(rollbackErr));
    }
    throw err;
  } finally {
    conn.release();
  }
}

/** Wait for the database to accept connections. The container may start before MariaDB is ready. */
export async function waitForDatabase(attempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await query("SELECT 1 AS ok");
      return;
    } catch (err) {
      if (i === attempts) throw err;
      log.warn(`database not ready (attempt ${i}/${attempts}), retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export type { PoolConnection, RowDataPacket, ResultSetHeader };
