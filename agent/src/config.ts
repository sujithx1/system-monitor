import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Type-safe agent configuration from the environment. Fails fast with a readable message (never
 * echoing secret values) when something is missing or invalid.
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
const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// URL");

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
