import { createHmac, timingSafeEqual } from "node:crypto";

/** `sha256=<hex>`, matching what the PHP side produces with hash_hmac(). */
export function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** Constant-time comparison, so a signature cannot be recovered by timing the failures. */
export function verifySignature(body: string, secret: string, provided: string | null | undefined): boolean {
  if (!provided) return false;
  const expected = signPayload(body, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
