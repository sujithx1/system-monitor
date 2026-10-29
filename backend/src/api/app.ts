import { isIP } from "node:net";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv, Deps } from "./context";
import { errorBody, HttpError } from "./lib/errors";
import { buildOpenApiDocument } from "./openapi";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";
import { hostRoutes } from "./routes/hosts";
import { incidentRoutes } from "./routes/incidents";
import { ingestRoutes } from "./routes/ingest";
import { notificationRoutes } from "./routes/notifications";
import { overviewRoutes } from "./routes/overview";
import { ruleRoutes } from "./routes/rules";
import { webhookRoutes } from "./routes/webhooks";

function clientIp(c: Context<AppEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    // The reverse proxy appends the address it saw; the right-most entry is the one we trust.
    const last = c.req
      .header("x-forwarded-for")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .at(-1);
    if (last && isIP(last)) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const inbound = c.req.header("x-request-id");
    const requestId = inbound && /^[\w-]{8,64}$/.test(inbound) ? inbound : crypto.randomUUID();
    const ip = clientIp(c, deps.config.http.trustProxy);
    c.set("requestId", requestId);
    c.set("ip", ip);
    c.set("log", deps.log.child({ requestId }));
    c.header("X-Request-Id", requestId);
    const started = performance.now();
    await next();
    // Path only: query strings may carry tokens (e.g. webhook verification).
    c.get("log").info("request", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
      ip,
    });
  });

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      strictTransportSecurity: "max-age=63072000; includeSubDomains",
      referrerPolicy: "no-referrer",
    }),
  );
  app.use("/api/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: deps.config.http.maxBodyBytes,
      onError: (c) =>
        c.json(
          errorBody(c as Context<AppEnv>, new HttpError(413, "payload_too_large", "Request body too large")),
          413,
        ),
    }),
  );

  app.route("/", healthRoutes(deps));

  const v1 = new Hono<AppEnv>();
  const openapi = buildOpenApiDocument();
  v1.get("/openapi.json", (c) => c.json(openapi));
  v1.route("/auth", authRoutes(deps));
  v1.route("/", ingestRoutes(deps));
  v1.route("/", overviewRoutes(deps));
  v1.route("/", hostRoutes(deps));
  v1.route("/", incidentRoutes(deps));
  v1.route("/", ruleRoutes(deps));
  v1.route("/", notificationRoutes(deps));
  v1.route("/", webhookRoutes(deps));
  app.route("/api/v1", v1);

  app.notFound((c) => c.json(errorBody(c, new HttpError(404, "not_found", "Route not found")), 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(errorBody(c, err), err.status);
    if (err instanceof HTTPException) {
      const status = err.status as ContentfulStatusCode;
      return c.json(
        errorBody(c, new HttpError(status, "http_error", err.message || "Request failed")),
        status,
      );
    }
    // Details stay in server logs; clients get a generic message and the request id.
    (c.get("log") ?? deps.log).error("unhandled error", { error: err, path: c.req.path });
    return c.json(errorBody(c, new HttpError(500, "internal_error", "Internal server error")), 500);
  });

  return app;
}
