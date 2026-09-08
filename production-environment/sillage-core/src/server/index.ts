/**
 * The sillage-core HTTP service: webhooks, dashboard API, and the built React UI.
 *
 * Kept as a separate container from the scheduler so a full sync cannot stall an inbound order
 * webhook or the operator dashboard.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { applyStorefrontProfile } from "../storefront/profile.ts";
import { applyRuntimeUrls, env } from "../config/env.ts";
import { loadSecretsOverlay } from "../config/secrets.ts";
import { closePool, query, waitForDatabase } from "../db/pool.ts";
import { loadSettings } from "../db/settings.ts";
import { logger, setLogLevel } from "../lib/log.ts";
import { api } from "./routes/api.ts";
import { auth } from "./routes/auth.ts";
import { webhooks } from "./routes/webhooks.ts";

setLogLevel(env.logLevel);
const log = logger("server");

const secretsBoot = loadSecretsOverlay();
if (secretsBoot.applied > 0) {
  log.info(`applied ${secretsBoot.applied} secret(s) from ${secretsBoot.path}`);
}

export const app = new Hono();

app.get("/health", async (c) => {
  try {
    await query("SELECT 1 AS ok");
    return c.json({
      ok: true,
      service: "sillage-core",
      database: "up",
      profile: env.sillageProfile,
    });
  } catch (err) {
    return c.json({ ok: false, service: "sillage-core", database: "down", error: String(err) }, 503);
  }
});

app.route("/api/webhooks", webhooks);
app.route("/api/auth", auth);
app.route("/api", api);

const distDir = join(env.rootDir, "web/dist");
if (existsSync(distDir)) {
  app.use("/*", serveStatic({ root: distDir }));
  app.get("*", async (c) => {
    const file = Bun.file(join(distDir, "index.html"));
    if (await file.exists()) return new Response(file, { headers: { "Content-Type": "text/html" } });
    return c.json({ ok: false, error: "dashboard not built" }, 404);
  });
} else {
  app.get("/", (c) =>
    c.json({
      ok: true,
      service: "sillage-core",
      message: "API up. Build the dashboard with `bun run web:build` and restart.",
    }),
  );
}

app.notFound((c) => c.json({ ok: false, error: "not found" }, 404));

app.onError((err, c) => {
  log.error(`unhandled error on ${c.req.method} ${c.req.path}`, String(err));
  return c.json({ ok: false, error: "internal error" }, 500);
});

if (import.meta.main) {
  await waitForDatabase();
  try {
    await applyStorefrontProfile();
  } catch (err) {
    log.warn(`storefront profile apply skipped: ${String(err)}`);
  }
  try {
    const settings = await loadSettings();
    applyRuntimeUrls({ wpBaseUrl: settings.wpBaseUrl, imageCdnBaseUrl: settings.imageCdnBaseUrl });
    log.info(`shop URL ${env.wordpress.baseUrl}`);
  } catch (err) {
    log.warn(`could not load settings URLs at boot: ${String(err)}`);
  }
  const server = Bun.serve({ port: env.port, hostname: "0.0.0.0", fetch: app.fetch });
  log.info(`listening on http://0.0.0.0:${server.port}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log.info(`received ${signal}, shutting down`);
      void server.stop(true).then(closePool).then(() => process.exit(0));
    });
  }
}
