import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Type-safe environment configuration. Each process parses only what it needs and fails fast
 * with a readable message (never echoing secret values) when something is missing or invalid.
 */

type Env = Record<string, string | undefined>;

const bool = (fallback: boolean) => z.stringbool().default(fallback);
const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));
const logLevel = z.enum(["debug", "info", "warn", "error"]).default("info");
const nodeEnv = z.enum(["production", "development", "test"]).default("production");
const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// URL");

/** Comma separated E.164 numbers, e.g. "+919876543210,+14155550100". */
const phoneList = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(/^\+?[1-9]\d{6,14}$/, "must be E.164 phone numbers")));

export class ConfigError extends Error {
  constructor(issues: z.core.$ZodIssue[]) {
    super(
      `Invalid configuration:\n${issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`,
    );
    this.name = "ConfigError";
  }
}

function parse<T extends z.ZodType>(schema: T, env: Env): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) throw new ConfigError(result.error.issues);
  return result.data;
}

const databaseSchema = {
  DATABASE_URL: postgresUrl,
  DATABASE_POOL_MAX: int(10, 1, 100),
};

const whatsappSchema = {
  WHATSAPP_ACCESS_TOKEN: optionalString,
  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_RECIPIENT: phoneList,
  WHATSAPP_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, "must look like v23.0")
    .default("v23.0"),
  WHATSAPP_TEMPLATE_NAME: z
    .string()
    .regex(/^[a-z0-9_]{1,512}$/, "template names are lowercase letters, digits and underscores")
    .default("system_alert"),
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().min(2).max(10).default("en"),
  WHATSAPP_GRAPH_BASE_URL: z.url().default("https://graph.facebook.com"),
  WHATSAPP_TIMEOUT_MS: int(10_000, 1000, 60_000),
  WHATSAPP_MAX_ATTEMPTS: int(10, 1, 50),
};

// ---------------------------------------------------------------- API

const apiSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  ...databaseSchema,
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: int(3000, 1, 65535),
  PUBLIC_ORIGIN: z.url().optional(),
  TRUST_PROXY: bool(false),
  COOKIE_SECURE: bool(true),
  SESSION_TTL_HOURS: int(12, 1, 24 * 30),
  MAX_BODY_BYTES: int(256 * 1024, 1024, 5 * 1024 * 1024),
  MAX_SNAPSHOT_AGE_SECONDS: int(900, 60, 86_400),
  MAX_CLOCK_SKEW_SECONDS: int(60, 5, 3600),
  HEARTBEAT_OFFLINE_SECONDS: int(180, 30, 86_400),
  WORKER_STALE_SECONDS: int(90, 15, 3600),
  WHATSAPP_RECIPIENT: whatsappSchema.WHATSAPP_RECIPIENT,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: optionalString,
  WHATSAPP_APP_SECRET: optionalString,
});

export type ApiConfig = ReturnType<typeof loadApiConfig>;

export function loadApiConfig(env: Env = process.env) {
  const e = parse(apiSchema, env);
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    database: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX },
    http: {
      host: e.API_HOST,
      port: e.API_PORT,
      publicOrigin: e.PUBLIC_ORIGIN,
      trustProxy: e.TRUST_PROXY,
      maxBodyBytes: e.MAX_BODY_BYTES,
    },
    auth: { cookieSecure: e.COOKIE_SECURE, sessionTtlHours: e.SESSION_TTL_HOURS },
    ingest: {
      maxSnapshotAgeSeconds: e.MAX_SNAPSHOT_AGE_SECONDS,
      maxClockSkewSeconds: e.MAX_CLOCK_SKEW_SECONDS,
    },
    health: {
      heartbeatOfflineSeconds: e.HEARTBEAT_OFFLINE_SECONDS,
      workerStaleSeconds: e.WORKER_STALE_SECONDS,
    },
    whatsapp: {
      recipients: e.WHATSAPP_RECIPIENT,
      webhookVerifyToken: e.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
      appSecret: e.WHATSAPP_APP_SECRET,
    },
  };
}

// ---------------------------------------------------------------- Worker

const workerSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  ...databaseSchema,
  ...whatsappSchema,
  EVALUATION_INTERVAL_SECONDS: int(15, 5, 300),
  DISPATCH_INTERVAL_MS: int(2000, 250, 60_000),
  STALE_AFTER_SECONDS: int(120, 30, 3600),
  AGENT_INTERVAL_SECONDS: int(30, 5, 600),
  METRICS_RETENTION_DAYS: int(30, 1, 3650),
  INCIDENT_RETENTION_DAYS: int(365, 7, 3650),
  NOTIFICATION_RETENTION_DAYS: int(90, 7, 3650),
  ALERT_TIMEZONE: z
    .string()
    .default("UTC")
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "unknown IANA time zone"),
  DEADMAN_PING_URL: z.url().optional(),
  WORKER_HEALTH_FILE: z.string().default("/tmp/system-monitor-worker.health"),
});

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;

export function loadWorkerConfig(env: Env = process.env) {
  const e = parse(workerSchema, env);
  const token = e.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = e.WHATSAPP_PHONE_NUMBER_ID;
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    database: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX },
    evaluation: {
      intervalSeconds: e.EVALUATION_INTERVAL_SECONDS,
      staleAfterSeconds: e.STALE_AFTER_SECONDS,
      agentIntervalSeconds: e.AGENT_INTERVAL_SECONDS,
    },
    dispatch: { intervalMs: e.DISPATCH_INTERVAL_MS },
    retention: {
      metricsDays: e.METRICS_RETENTION_DAYS,
      incidentsDays: e.INCIDENT_RETENTION_DAYS,
      notificationsDays: e.NOTIFICATION_RETENTION_DAYS,
    },
    alertTimezone: e.ALERT_TIMEZONE,
    deadmanPingUrl: e.DEADMAN_PING_URL,
    healthFile: e.WORKER_HEALTH_FILE,
    whatsapp: {
      /** null when credentials are absent: notifications stay queued and nothing is sent. */
      credentials: token && phoneNumberId ? { accessToken: token, phoneNumberId } : null,
      recipients: e.WHATSAPP_RECIPIENT,
      apiVersion: e.WHATSAPP_API_VERSION,
      templateName: e.WHATSAPP_TEMPLATE_NAME,
      templateLanguage: e.WHATSAPP_TEMPLATE_LANGUAGE,
      graphBaseUrl: e.WHATSAPP_GRAPH_BASE_URL.replace(/\/+$/, ""),
      timeoutMs: e.WHATSAPP_TIMEOUT_MS,
      maxAttempts: e.WHATSAPP_MAX_ATTEMPTS,
    },
  };
}

// ---------------------------------------------------------------- Agent

const jsonArray = <T extends z.ZodType>(item: T) =>
  z
    .string()
    .default("[]")
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "must be a JSON array" });
        return z.NEVER;
      }
    })
    .pipe(z.array(item));

const checkName = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "names use letters, digits, . _ -");

const pgTargetSchema = z.object({ name: checkName, url: postgresUrl }).strict();
const httpCheckSchema = z
  .object({
    name: checkName,
    url: z.url({ protocol: /^https?$/ }),
    timeoutMs: z.number().int().min(100).max(60_000).default(5000),
    expectedStatus: z.array(z.number().int().min(100).max(599)).optional(),
  })
  .strict();
const backupMarkerSchema = z.object({ name: checkName, path: z.string().startsWith("/") }).strict();

const agentSchema = z.object({
  LOG_LEVEL: logLevel,
  MONITOR_URL: z.url({ protocol: /^https?$/ }),
  AGENT_TOKEN: optionalString,
  AGENT_TOKEN_FILE: optionalString,
  AGENT_ALLOW_INSECURE_HTTP: bool(false),
  AGENT_CA_FILE: optionalString,
  AGENT_INTERVAL_SECONDS: int(30, 5, 600),
  AGENT_HEARTBEAT_SECONDS: int(30, 5, 600),
  AGENT_REQUEST_TIMEOUT_MS: int(10_000, 1000, 60_000),
  AGENT_MAX_BUFFER: int(20, 0, 1000),
  AGENT_PROC_ROOT: z.string().default("/proc"),
  AGENT_MOUNTS: z.string().default("/"),
  AGENT_PG_URL: optionalString.pipe(postgresUrl.optional()),
  AGENT_PG_TARGETS: jsonArray(pgTargetSchema),
  AGENT_PG_TIMEOUT_MS: int(5000, 500, 60_000),
  AGENT_PG_REPLICATION: bool(false),
  AGENT_HTTP_CHECKS: jsonArray(httpCheckSchema),
  AGENT_DOCKER_SOCKET: optionalString,
  AGENT_BACKUP_MARKERS: jsonArray(backupMarkerSchema),
});

export type AgentConfig = ReturnType<typeof loadAgentConfig>;
export type HttpCheckConfig = z.infer<typeof httpCheckSchema>;
export type PgTargetConfig = z.infer<typeof pgTargetSchema>;

export function loadAgentConfig(
  env: Env = process.env,
  readFile: (path: string) => string = defaultReadFile,
) {
  const e = parse(agentSchema, env);
  const token = e.AGENT_TOKEN ?? (e.AGENT_TOKEN_FILE ? readFile(e.AGENT_TOKEN_FILE).trim() : undefined);
  const issues: z.core.$ZodIssue[] = [];
  if (!token) {
    issues.push({
      code: "custom",
      path: ["AGENT_TOKEN"],
      message: "AGENT_TOKEN or AGENT_TOKEN_FILE is required",
      input: undefined,
    });
  }
  const monitorUrl = new URL(e.MONITOR_URL);
  if (monitorUrl.protocol !== "https:" && !e.AGENT_ALLOW_INSECURE_HTTP) {
    issues.push({
      code: "custom",
      path: ["MONITOR_URL"],
      message: "must use https:// (set AGENT_ALLOW_INSECURE_HTTP=true only for local development)",
      input: undefined,
    });
  }
  const pgTargets = [...e.AGENT_PG_TARGETS];
  if (e.AGENT_PG_URL) pgTargets.unshift({ name: "main", url: e.AGENT_PG_URL });
  if (new Set(pgTargets.map((t) => t.name)).size !== pgTargets.length) {
    issues.push({
      code: "custom",
      path: ["AGENT_PG_TARGETS"],
      message: "target names must be unique",
      input: undefined,
    });
  }
  if (issues.length > 0 || !token) throw new ConfigError(issues);

  const mounts = e.AGENT_MOUNTS.trim();
  return {
    logLevel: e.LOG_LEVEL,
    monitorUrl: monitorUrl.toString().replace(/\/+$/, ""),
    token,
    caFile: e.AGENT_CA_FILE,
    intervalSeconds: e.AGENT_INTERVAL_SECONDS,
    heartbeatSeconds: e.AGENT_HEARTBEAT_SECONDS,
    requestTimeoutMs: e.AGENT_REQUEST_TIMEOUT_MS,
    maxBuffer: e.AGENT_MAX_BUFFER,
    procRoot: e.AGENT_PROC_ROOT.replace(/\/+$/, ""),
    mounts:
      mounts === "auto"
        ? ("auto" as const)
        : mounts
            .split(",")
            .map((m) => m.trim())
            .filter(Boolean),
    postgres: { targets: pgTargets, timeoutMs: e.AGENT_PG_TIMEOUT_MS, replication: e.AGENT_PG_REPLICATION },
    httpChecks: e.AGENT_HTTP_CHECKS,
    dockerSocket: e.AGENT_DOCKER_SOCKET,
    backupMarkers: e.AGENT_BACKUP_MARKERS,
  };
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------- Migrations / scripts

export function loadDatabaseUrl(env: Env = process.env, key = "DATABASE_URL"): string {
  return parse(z.object({ [key]: postgresUrl }), env)[key] as string;
}
