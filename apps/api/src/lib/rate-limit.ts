import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context";
import { errorBody, HttpError } from "./errors";

/**
 * In-memory fixed-window limiter. Sufficient for the single API instance this deployment runs;
 * put limits in the reverse proxy (or Redis) if you scale the API horizontally.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  hit(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    this.sweep(now);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    return { allowed: w.count <= this.limit, retryAfterSeconds: Math.ceil((w.resetAt - now) / 1000) };
  }

  /** True when the key is already over its limit, without counting this call. */
  isLimited(key: string, now = Date.now()): boolean {
    const w = this.windows.get(key);
    return !!w && w.resetAt > now && w.count >= this.limit;
  }

  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, w] of this.windows) if (w.resetAt <= now) this.windows.delete(key);
    // Hard cap to bound memory if an attacker rotates keys.
    if (this.windows.size > 100_000) this.windows.clear();
  }
}

export function rateLimit(
  limiter: RateLimiter,
  key: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { allowed, retryAfterSeconds } = limiter.hit(key(c));
    if (!allowed) {
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json(errorBody(c, new HttpError(429, "rate_limited", "Too many requests")), 429);
    }
    await next();
  };
}
