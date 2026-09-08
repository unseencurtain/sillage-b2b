/**
 * HMAC verification for requests coming from sillage-bridge.
 *
 * WordPress and sillage-core share a secret rather than using an API key, because the webhook
 * crosses a container boundary on a network the storefront can also reach. Verifying the signature
 * over the raw body means a tampered payload fails even if someone can talk to the port.
 */
import type { Context, Next } from "hono";
import { env } from "../config/env.ts";
import { verifySignature } from "../lib/hmac.ts";
import { logger } from "../lib/log.ts";

const log = logger("http");

/** Hono context additions. The parsed body is shared so a route need not re-read the stream. */
export type SignedEnv = { Variables: { payload: Record<string, unknown> } };

/** Maximum age of a signed request, to stop a captured one being replayed later. */
const MAX_SKEW_SECONDS = 300;

export async function requireSignature(c: Context<SignedEnv>, next: Next) {
  const body = await c.req.text();

  if (!verifySignature(body, env.wordpress.sharedSecret, c.req.header("X-Sillage-Signature"))) {
    log.warn(`rejected unsigned or mis-signed request to ${c.req.path}`);
    return c.json({ ok: false, error: "invalid signature" }, 401);
  }

  // The signature proves the body is authentic but not that it is fresh.
  const parsed = safeParse(body);
  const timestamp = typeof parsed?.timestamp === "number" ? parsed.timestamp : null;
  if (timestamp !== null && Math.abs(Date.now() / 1000 - timestamp) > MAX_SKEW_SECONDS) {
    log.warn(`rejected stale request to ${c.req.path}, timestamp ${timestamp}`);
    return c.json({ ok: false, error: "stale request" }, 401);
  }

  c.set("payload", parsed ?? {});
  await next();
}

function safeParse(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
