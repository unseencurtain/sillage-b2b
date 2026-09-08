import { Hono } from "hono";
import {
  clearSession,
  requireSession,
  setSession,
  verifyPassword,
  type AuthEnv,
} from "../auth.ts";

export const auth = new Hono<AuthEnv>();

auth.post("/login", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { user?: string; password?: string };
  const user = String(body.user ?? "");
  const password = String(body.password ?? "");
  if (!verifyPassword(user, password)) {
    return c.json({ ok: false, error: "invalid credentials" }, 401);
  }
  setSession(c, user);
  return c.json({ ok: true, user });
});

auth.post("/logout", (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

auth.get("/me", requireSession, (c) => c.json({ ok: true, user: c.get("user") }));
