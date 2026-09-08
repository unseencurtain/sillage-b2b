import { runMigrations } from "../db/migrate.ts";
import { closePool } from "../db/pool.ts";
import { setLogLevel } from "../lib/log.ts";
import { applyStorefrontProfile } from "../storefront/profile.ts";
import { env } from "../config/env.ts";

setLogLevel(env.logLevel);

try {
  await runMigrations();
  await applyStorefrontProfile();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await closePool();
}
