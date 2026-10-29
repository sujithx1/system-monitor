import { agents, monitoredHosts, sessions, users } from "@system-monitor/database";
import type { UserRole } from "@system-monitor/shared";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv, Deps } from "../context";
import { AGENT_TOKEN_PREFIX, sha256Hex } from "../lib/crypto";
import { HttpError } from "../lib/errors";

const ROLE_RANK: Record<UserRole, number> = { viewer: 1, operator: 2, admin: 3 };

export function sessionCookieName(secure: boolean): string {
  // The __Host- prefix pins the cookie to this exact origin over HTTPS (no Domain, Path=/).
  return secure ? "__Host-im_session" : "im_session";
}

function bearer(c: Context<AppEnv>): string | null {
  const header = c.req.header("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m?.[1] ?? null;
}

/** Agent credentials: per-agent bearer token, looked up by SHA-256 hash. */
export function requireAgent(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearer(c);
    if (!token?.startsWith(AGENT_TOKEN_PREFIX) || token.length > 200) {
      throw new HttpError(401, "unauthorized", "Valid agent credentials are required");
    }
    const [row] = await deps.db
      .select({ id: agents.id, hostId: agents.hostId, hostName: monitoredHosts.name })
      .from(agents)
      .innerJoin(monitoredHosts, eq(monitoredHosts.id, agents.hostId))
      .where(and(eq(agents.tokenHash, sha256Hex(token)), eq(agents.enabled, true), isNull(agents.revokedAt)))
      .limit(1);
    if (!row) throw new HttpError(401, "unauthorized", "Valid agent credentials are required");
    c.set("agent", row);
    c.set("log", c.get("log").child({ agentId: row.id, hostId: row.hostId }));
    await next();
  };
}

/** Dashboard users: opaque session token in an HttpOnly cookie, plus a role check. */
export function requireUser(deps: Deps, minRole: UserRole = "viewer"): MiddlewareHandler<AppEnv> {
  const cookieName = sessionCookieName(deps.config.auth.cookieSecure);
  return async (c, next) => {
    const token = getCookie(c, cookieName);
    if (!token || token.length > 200) throw new HttpError(401, "unauthorized", "Authentication required");
    const now = deps.now?.() ?? new Date();
    const [row] = await deps.db
      .select({
        sessionId: sessions.id,
        lastSeenAt: sessions.lastSeenAt,
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(eq(sessions.tokenHash, sha256Hex(token)), gt(sessions.expiresAt, now), eq(users.disabled, false)),
      )
      .limit(1);
    if (!row) throw new HttpError(401, "unauthorized", "Authentication required");
    if (ROLE_RANK[row.role] < ROLE_RANK[minRole]) {
      throw new HttpError(403, "forbidden", "Your role does not allow this action");
    }
    if (now.getTime() - row.lastSeenAt.getTime() > 5 * 60_000) {
      await deps.db.update(sessions).set({ lastSeenAt: sql`now()` }).where(eq(sessions.id, row.sessionId));
    }
    c.set("user", {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      role: row.role,
      sessionId: row.sessionId,
    });
    await next();
  };
}

/**
 * CSRF defence in depth for cookie-authenticated writes (cookies are already SameSite=Strict):
 * state-changing requests must come from the dashboard's own origin.
 */
export function requireSameOrigin(deps: Deps): MiddlewareHandler<AppEnv> {
  const expected = deps.config.http.publicOrigin ? new URL(deps.config.http.publicOrigin).origin : null;
  return async (c, next) => {
    if (expected && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin !== expected) throw new HttpError(403, "forbidden", "Cross-origin request rejected");
    }
    await next();
  };
}
