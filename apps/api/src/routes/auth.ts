import { sessions, users } from "@system-monitor/database";
import type { UserDto } from "@system-monitor/shared";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv, Deps } from "../context";
import { audit } from "../lib/audit";
import { generateToken, SESSION_TOKEN_PREFIX, sha256Hex } from "../lib/crypto";
import { HttpError, parseJson } from "../lib/errors";
import { RateLimiter, rateLimit } from "../lib/rate-limit";
import { requireSameOrigin, requireUser, sessionCookieName } from "../middleware/auth";

export const loginSchema = z
  .object({ email: z.email().max(254), password: z.string().min(1).max(256) })
  .strict();

// Verifying against a real hash when the user does not exist keeps response timing uniform.
const DUMMY_HASH = Bun.password.hashSync("timing-equaliser-not-a-real-password", { algorithm: "argon2id" });

export function authRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const cookieName = sessionCookieName(deps.config.auth.cookieSecure);
  const perIp = new RateLimiter(10, 60_000);
  const perEmail = new RateLimiter(5, 15 * 60_000);

  app.post(
    "/login",
    requireSameOrigin(deps),
    rateLimit(perIp, (c) => `ip:${c.get("ip")}`),
    async (c) => {
      const body = await parseJson(c, loginSchema);
      const email = body.email.toLowerCase();
      // Only failed attempts count per account, so nobody can lock a user out by guessing wrong
      // on purpose faster than the per-IP limit allows.
      if (perEmail.isLimited(email)) throw new HttpError(429, "rate_limited", "Too many login attempts");

      const [user] = await deps.db.select().from(users).where(eq(users.email, email)).limit(1);
      const valid = await Bun.password.verify(body.password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !valid || user.disabled) {
        perEmail.hit(email);
        await audit(deps.db, {
          actorType: "user",
          actorId: user?.id ?? null,
          action: "auth.login_failed",
          ip: c.get("ip"),
          metadata: { email },
        });
        throw new HttpError(401, "invalid_credentials", "Invalid email or password");
      }

      const token = generateToken(SESSION_TOKEN_PREFIX);
      const ttlMs = deps.config.auth.sessionTtlHours * 3600_000;
      const now = deps.now?.() ?? new Date();
      await deps.db.transaction(async (tx) => {
        await tx.insert(sessions).values({
          userId: user.id,
          tokenHash: sha256Hex(token),
          ip: c.get("ip"),
          userAgent: c.req.header("user-agent")?.slice(0, 300) ?? null,
          expiresAt: new Date(now.getTime() + ttlMs),
        });
        await tx.update(users).set({ lastLoginAt: sql`now()` }).where(eq(users.id, user.id));
        await audit(tx, { actorType: "user", actorId: user.id, action: "auth.login", ip: c.get("ip") });
      });

      setCookie(c, cookieName, token, {
        httpOnly: true,
        secure: deps.config.auth.cookieSecure,
        sameSite: "Strict",
        path: "/",
        maxAge: Math.floor(ttlMs / 1000),
      });
      const dto: UserDto = { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
      return c.json({ user: dto });
    },
  );

  app.post("/logout", requireSameOrigin(deps), async (c) => {
    const token = getCookie(c, cookieName);
    if (token) await deps.db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(token)));
    deleteCookie(c, cookieName, { path: "/", secure: deps.config.auth.cookieSecure });
    return c.body(null, 204);
  });

  app.get("/me", requireUser(deps), (c) => {
    const u = c.get("user");
    const dto: UserDto = { id: u.id, email: u.email, displayName: u.displayName, role: u.role };
    return c.json({ user: dto });
  });

  return app;
}
