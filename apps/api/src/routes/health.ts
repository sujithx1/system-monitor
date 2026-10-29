import { Hono } from "hono";
import type { AppEnv, Deps } from "../context";

export function healthRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  /** Liveness: the process is up and serving. Never touches dependencies. */
  app.get("/health", (c) => c.json({ status: "ok" }));

  /** Readiness: can serve traffic, i.e. the monitoring database is reachable. */
  app.get("/ready", async (c) => {
    try {
      await deps.pingDb();
      return c.json({ status: "ready", checks: { database: "ok" } });
    } catch (error) {
      c.get("log").warn("readiness check failed", { error });
      return c.json({ status: "not_ready", checks: { database: "unavailable" } }, 503);
    }
  });

  return app;
}
