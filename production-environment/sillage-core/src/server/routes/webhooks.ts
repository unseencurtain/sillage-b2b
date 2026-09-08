/** Inbound webhooks from sillage-bridge. */
import { Hono } from "hono";
import { recordEvent } from "../../db/settings.ts";
import { logger } from "../../lib/log.ts";
import { ingestOrder } from "../../orders/ingest.ts";
import { requireSignature, type SignedEnv } from "../hmac.ts";

const log = logger("webhook");

export const webhooks = new Hono<SignedEnv>();

webhooks.use("*", requireSignature);

/**
 * An order became dispatchable.
 *
 * This only splits the order into vendor rows; it never contacts a vendor. Dispatch is a separate,
 * rail-guarded step, so a webhook can never be the thing that spends money.
 */
webhooks.post("/order", async (c) => {
  const payload = c.get("payload");
  const orderId = Number(payload.order_id ?? 0);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return c.json({ ok: false, error: "order_id is required" }, 400);
  }

  try {
    const result = await ingestOrder(orderId);
    return c.json({ ok: true, ...result });
  } catch (err) {
    log.error(`ingest failed for order ${orderId}`, String(err));
    await recordEvent("error", "orders", `webhook ingest failed for order ${orderId}: ${String(err)}`);
    // 500 so the plugin records the failure on the order; the sweep will retry regardless.
    return c.json({ ok: false, error: String(err) }, 500);
  }
});
