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
 * This does not throw: the products are already committed, so failing the run would be a lie
 * about the data. But it is not the harmless warning it was once written as. "The caches expire
 * on their own" is only true of transients — with Redis/Valkey object caching on, WordPress's
 * post counts are cached with no expiry, so a missed finalize leaves a full import showing as an
 * empty shop and an empty Products screen for as long as the shop stays up. That is not
 * hypothetical: it cost the retail shop a first import of 51,201 products, which reported
 * "51201 created" while the storefront showed nothing, with one WARN in between to explain it.
 *
 * So a failure logs at error level and names the fix, and 404 is called out on its own, because
 * it does not mean "WordPress is unhappy" — it means the route is not registered, i.e. the bridge
 * plugin is inactive.
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
      const detail = (await response.text()).slice(0, 300);
      if (response.status === 404) {
        log.error(
          "finalize got 404: the sillage-bridge plugin is not active, so WordPress was never told " +
            "the catalogue changed. Every product is written and correct, but the shop and the " +
            "WooCommerce Products screen will keep showing the old (possibly empty) catalogue. " +
            "Activate sillage-bridge in wp-admin, then run `deploy-vps.sh --host <host> --finish` " +
            "or the next full sync to clear the caches — a re-import is not needed.",
        );
      } else {
        log.error(`finalize returned ${response.status} — the shop may serve stale data: ${detail}`);
      }
      return false;
    }
    log.info("WooCommerce caches invalidated");
    return true;
  } catch (err) {
    log.error(`finalize call failed — products are written but the shop may serve stale data: ${String(err)}`);
    return false;
  }
}
