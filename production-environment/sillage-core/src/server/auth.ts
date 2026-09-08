/**
 * Cookie session auth for the dashboard.
 *
 * One operator account from env. The session is an HMAC-signed cookie so we do not need a
 * sessions table; rotating SESSION_SECRET invalidates every login.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { env } from "../config/env.ts";

const COOKIE = "sillage_session";
const MAX_AGE_SECONDS = 60 * 60 * 12;

export type AuthEnv = { Variables: { user: string } };

function sign(payload: string): string {
  return createHmac("sha256", env.dashboard.sessionSecret).update(payload).digest("base64url");
}

function encodeSession(user: string): string {
  const body = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + MAX_AGE_SECONDS * 1000 }), "utf8").toString(
    "base64url",
  );
  return `${body}.${sign(body)}`;
}

function decodeSession(token: string | undefined): string | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { u: string; exp: number };
    if (typeof parsed.u !== "string" || typeof parsed.exp !== "number") return null;
    if (parsed.exp < Date.now()) return null;
    return parsed.u;
  } catch {
    return null;
  }
}

export function verifyPassword(user: string, password: string): boolean {
  if (!env.dashboard.password) return false;
  if (user !== env.dashboard.user) return false;
  const a = Buffer.from(password);
  const b = Buffer.from(env.dashboard.password);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function setSession(c: Context, user: string): void {
  setCookie(c, COOKIE, encodeSession(user), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export function clearSession(c: Context): void {
  deleteCookie(c, COOKIE, { path: "/" });
}

export async function requireSession(c: Context<AuthEnv>, next: Next) {
  const user = decodeSession(getCookie(c, COOKIE));
  if (!user) return c.json({ ok: false, error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
}
