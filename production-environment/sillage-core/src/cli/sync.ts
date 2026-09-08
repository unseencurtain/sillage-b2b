/**
 * Run a sync from the command line. This is what the container's cron invokes.
 *
 *   bun run sync -- --mode=full --source=local
 *   bun run sync -- --mode=fast --source=live --vendor=bts
 *   bun run sync -- --mode=full --source=local --dry-run
 *   bun run sync -- --mode=full --source=local --redrive
 *   bun run sync -- --mode=full --source=local --rewrite-all
 *   bun run sync -- --mode=full --rewrite-only --rewrite-all
 *   bun run sync -- --mode=fast --source=cache --rewrite-only
 */
import { env } from "../config/env.ts";
import { closePool, waitForDatabase } from "../db/pool.ts";
import { logger, setLogLevel } from "../lib/log.ts";
import { runSync } from "../sync/run.ts";
import type { FeedSource } from "../vendors/types.ts";

setLogLevel(env.logLevel);
const log = logger("cli");

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const mode = (flag("mode") ?? "full") as "full" | "fast";
const source = (flag("source") ?? "live") as FeedSource;
const vendorArg = flag("vendor") ?? "all";
const dryRun = args.includes("--dry-run");
const redrive = args.includes("--redrive");
const rewriteAll = args.includes("--rewrite-all");
const rewriteOnly = args.includes("--rewrite-only");

if (mode !== "full" && mode !== "fast") {
  log.error(`--mode must be "full" or "fast", got "${mode}"`);
  process.exit(1);
}
if (source !== "live" && source !== "local" && source !== "cache") {
  log.error(`--source must be "live", "local", or "cache", got "${source}"`);
  process.exit(1);
}

try {
  await waitForDatabase();
  const summary = await runSync({
    mode,
    source,
    vendors: vendorArg === "all" ? [] : vendorArg.split(","),
    dryRun,
    redrive,
    rewriteAll,
    rewriteOnly,
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (err) {
  log.error("sync failed", String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exitCode = 1;
} finally {
  await closePool();
}
