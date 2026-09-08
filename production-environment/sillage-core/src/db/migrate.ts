import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../config/env.ts";
import { logger } from "../lib/log.ts";
import { execute, getPool, query, waitForDatabase, type RowDataPacket } from "./pool.ts";

const log = logger("migrate");
const MIGRATIONS_DIR = join(env.rootDir, "migrations");

interface AppliedRow extends RowDataPacket {
  name: string;
}

/**
 * Split a .sql file into statements on semicolons at end of line, ignoring semicolons inside
 * string literals and comments. mysql2 does not enable multi-statement queries and we do not want
 * to, because it disables prepared statements.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === "*" && next === "/") {
        current += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === "-" && next === "-") {
        inLineComment = true;
        current += ch;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        current += ch;
        continue;
      }
    }

    if (ch === "'" && !inDouble) {
      // Backslash-escaped quotes are the only escape form we emit.
      const escaped = i > 0 && sql[i - 1] === "\\";
      if (!escaped) inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      const escaped = i > 0 && sql[i - 1] === "\\";
      if (!escaped) inDouble = !inDouble;
    }

    if (ch === ";" && !inSingle && !inDouble) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements.filter((s) => stripComments(s).length > 0);
}

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*--.*$/gm, "")
    .trim();
}

export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  await waitForDatabase();

  await execute(
    `CREATE DATABASE IF NOT EXISTS \`${env.db.sillage}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await execute(
    `CREATE TABLE IF NOT EXISTS \`${env.db.sillage}\`.sil_migrations (
       name       VARCHAR(190) NOT NULL PRIMARY KEY,
       applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  const alreadyApplied = new Set(
    (await query<AppliedRow>(`SELECT name FROM \`${env.db.sillage}\`.sil_migrations`)).map((r) => r.name),
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }

    const raw = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const statements = splitStatements(raw);

    // Each migration runs on one connection with the sillage schema selected, so the migration
    // files can use bare table names.
    const conn = await getPool().getConnection();
    try {
      await conn.query(`USE \`${env.db.sillage}\``);
      for (const statement of statements) {
        await conn.query(statement);
      }
      await conn.query(`INSERT INTO \`${env.db.sillage}\`.sil_migrations (name) VALUES (?)`, [file]);
      log.info(`applied ${file} (${statements.length} statements)`);
      applied.push(file);
    } catch (err) {
      log.error(`failed applying ${file}`, String(err));
      throw err;
    } finally {
      conn.release();
    }
  }

  if (applied.length === 0) log.info(`schema up to date (${skipped.length} migrations)`);
  return { applied, skipped };
}
