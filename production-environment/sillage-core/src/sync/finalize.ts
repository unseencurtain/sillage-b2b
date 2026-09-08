import { env } from "../config/env.ts";
import { logger } from "../lib/log.ts";
import { signPayload } from "../lib/hmac.ts";

const log = logger("finalize");

/**
 * Tell WordPress that the catalogue changed.
 *
 * Bulk SQL writes are invisible to WooCommerce's caches: its transient cache version, the product
 * query cache, and Blocksy's own taxonomy lookup table all keep serving pre-import data until
 * something bumps them. Only PHP can do that, so the plugin exposes an endpoint for it.
 *
 * A failure here is not fatal — the data is already correct in the database and the caches expire
 * on their own — so it is logged rather than thrown.
 */
export async function finalizeWordPress(): Promise<boolean> {
  // Prefer the in-network WordPress hostname — public WP_BASE_URL often fails from inside Docker.
  const origin = env.wordpress.internalUrl || env.wordpress.baseUrl;
  const url = `${origin}/wp-json/sillage/v1/finalize`;
  const body = JSON.stringify({ timestamp: Date.now() });
  const signature = signPayload(body, env.wordpress.sharedSecret);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sillage-Signature": signature,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      log.warn(`finalize returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return false;
    }
    log.info("WooCommerce caches invalidated");
    return true;
  } catch (err) {
    log.warn(`finalize call failed (data is still correct, caches will expire): ${String(err)}`);
    return false;
  }
}
