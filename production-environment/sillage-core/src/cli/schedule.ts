/**
 * The cron tick. Invoked by supercronic on a fixed short interval; see ../../crontab.
 *
 *   bun run schedule              # decide from settings and run whatever is due
 *   bun run schedule -- --force=fast
 *   bun run schedule -- --dry     # report the decision without running anything
 */
import { env } from "../config/env.ts";
import { closePool, waitForDatabase } from "../db/pool.ts";
import { loadSettings } from "../db/settings.ts";
import { logger, setLogLevel } from "../lib/log.ts";
import { decideSchedule, runScheduledSync } from "../sync/schedule.ts";

setLogLevel(env.logLevel);
const log = logger("cli");

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const force = flag("force");
if (force !== undefined && force !== "full" && force !== "fast") {
  log.error(`--force must be "full" or "fast", got "${force}"`);
  process.exit(1);
}

try {
  await waitForDatabase();

  if (args.includes("--dry")) {
    const decision = await decideSchedule(await loadSettings());
    console.log(JSON.stringify(decision, null, 2));
  } else {
    const summary = await runScheduledSync(force as "full" | "fast" | undefined);
    if (summary) console.log(JSON.stringify(summary, null, 2));
  }
} catch (err) {
  log.error("scheduled sync failed", String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exitCode = 1;
} finally {
  await closePool();
}
