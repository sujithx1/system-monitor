import { describe, expect, test } from "bun:test";
import { ConfigError, loadAgentConfig, loadWorkerConfig } from "@system-monitor/config";
import {
  createLogger,
  createRuleSchema,
  heartbeatSchema,
  metricSnapshotSchema,
  redactString,
} from "@system-monitor/shared";

const snapshot = () => ({
  snapshotId: crypto.randomUUID(),
  agentVersion: "1.0.0",
  hostname: "db-prod-1",
  collectedAt: new Date().toISOString(),
  metrics: [
    { name: "cpu.usage_percent", resource: "", status: "ok", value: 42.5 },
    { name: "disk.usage_percent", resource: "/", status: "ok", value: 71 },
    { name: "pg.latency_ms", resource: "main", status: "unavailable", value: null, error: "timeout" },
  ],
});

describe("metric payload validation", () => {
  test("accepts a well-formed snapshot", () => {
    expect(metricSnapshotSchema.safeParse(snapshot()).success).toBe(true);
  });

  test.each([
    [
      "unknown metric name",
      (s: ReturnType<typeof snapshot>) => ({
        ...s,
        metrics: [{ name: "rm -rf", resource: "", status: "ok", value: 1 }],
      }),
    ],
    [
      "percent above 100",
      (s: ReturnType<typeof snapshot>) => ({
        ...s,
        metrics: [{ name: "cpu.usage_percent", resource: "", status: "ok", value: 101 }],
      }),
    ],
    [
      "ok status without value",
      (s: ReturnType<typeof snapshot>) => ({
        ...s,
        metrics: [{ name: "cpu.usage_percent", resource: "", status: "ok", value: null }],
      }),
    ],
    [
      "unavailable with a value",
      (s: ReturnType<typeof snapshot>) => ({
        ...s,
        metrics: [{ name: "cpu.usage_percent", resource: "", status: "unavailable", value: 0 }],
      }),
    ],
    [
      "boolean metric not 0/1",
      (s: ReturnType<typeof snapshot>) => ({
        ...s,
        metrics: [{ name: "pg.up", resource: "main", status: "ok", value: 0.5 }],
      }),
    ],
    [
      "negative bytes",
      (s: ReturnType<typeof snapshot>) => ({
        ...s,
        metrics: [{ name: "disk.used_bytes", resource: "/", status: "ok", value: -1 }],
      }),
    ],
    ["unknown top-level field", (s: ReturnType<typeof snapshot>) => ({ ...s, hostId: "spoofed" })],
    ["empty metrics", (s: ReturnType<typeof snapshot>) => ({ ...s, metrics: [] })],
    ["bad timestamp", (s: ReturnType<typeof snapshot>) => ({ ...s, collectedAt: "yesterday" })],
    [
      "control characters in resource",
      (s: ReturnType<typeof snapshot>) => ({
        ...s,
        metrics: [{ name: "disk.usage_percent", resource: "/\u0000", status: "ok", value: 1 }],
      }),
    ],
    [
      "duplicate metric/resource pair",
      (s: ReturnType<typeof snapshot>) => ({ ...s, metrics: [s.metrics[0], s.metrics[0]] }),
    ],
  ])("rejects %s", (_name, mutate) => {
    expect(metricSnapshotSchema.safeParse(mutate(snapshot())).success).toBe(false);
  });

  test("rejects NaN/Infinity (JSON cannot carry them, but defend anyway)", () => {
    const s = snapshot();
    s.metrics[0] = { name: "cpu.usage_percent", resource: "", status: "ok", value: Number.NaN };
    expect(metricSnapshotSchema.safeParse(s).success).toBe(false);
  });

  test("heartbeat schema is strict", () => {
    expect(
      heartbeatSchema.safeParse({ agentVersion: "1.0.0", hostname: "h", sentAt: new Date().toISOString() })
        .success,
    ).toBe(true);
    expect(
      heartbeatSchema.safeParse({
        agentVersion: "1.0.0; drop",
        hostname: "h",
        sentAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });
});

describe("alert rule validation", () => {
  test("defaults are applied", () => {
    const r = createRuleSchema.parse({
      name: "CPU",
      kind: "threshold",
      metric: "cpu.usage_percent",
      criticalThreshold: 90,
    });
    expect(r).toMatchObject({ comparator: "gt", warningForSeconds: 0, cooldownSeconds: 300, enabled: true });
  });

  test("check_failures needs a 0/1 metric and integer counts", () => {
    expect(
      createRuleSchema.safeParse({
        name: "x",
        kind: "check_failures",
        metric: "cpu.usage_percent",
        criticalThreshold: 2,
      }).success,
    ).toBe(false);
    expect(
      createRuleSchema.safeParse({
        name: "x",
        kind: "check_failures",
        metric: "pg.up",
        criticalThreshold: 1.5,
      }).success,
    ).toBe(false);
    expect(
      createRuleSchema.safeParse({ name: "x", kind: "check_failures", metric: "pg.up", criticalThreshold: 2 })
        .success,
    ).toBe(true);
  });

  test("heartbeat rules take no metric and sane thresholds", () => {
    expect(
      createRuleSchema.safeParse({
        name: "hb",
        kind: "heartbeat",
        metric: "cpu.usage_percent",
        criticalThreshold: 180,
      }).success,
    ).toBe(false);
    expect(createRuleSchema.safeParse({ name: "hb", kind: "heartbeat", criticalThreshold: 5 }).success).toBe(
      false,
    );
  });

  test("escalation recipients must be E.164", () => {
    expect(
      createRuleSchema.safeParse({
        name: "x",
        kind: "threshold",
        metric: "cpu.usage_percent",
        criticalThreshold: 9,
        escalationRecipients: ["call me"],
      }).success,
    ).toBe(false);
  });
});

describe("configuration", () => {
  const base = { MONITOR_URL: "https://monitor.example.com", AGENT_TOKEN: "ima_x" };

  test("agent refuses plain http unless explicitly allowed", () => {
    expect(() => loadAgentConfig({ ...base, MONITOR_URL: "http://monitor.example.com" })).toThrow(
      ConfigError,
    );
    expect(
      loadAgentConfig({ ...base, MONITOR_URL: "http://localhost:3000", AGENT_ALLOW_INSECURE_HTTP: "true" })
        .monitorUrl,
    ).toBe("http://localhost:3000");
  });

  test("agent token can come from a credentials file", () => {
    const cfg = loadAgentConfig(
      { MONITOR_URL: base.MONITOR_URL, AGENT_TOKEN_FILE: "/run/creds/token" },
      () => "ima_fromfile\n",
    );
    expect(cfg.token).toBe("ima_fromfile");
  });

  test("agent parses mounts, postgres targets and http checks", () => {
    const cfg = loadAgentConfig({
      ...base,
      AGENT_MOUNTS: "/, /var/lib/postgresql",
      AGENT_PG_URL: "postgres://m:p@127.0.0.1/app",
      AGENT_HTTP_CHECKS: '[{"name":"api","url":"http://127.0.0.1:8080/health"}]',
    });
    expect(cfg.mounts).toEqual(["/", "/var/lib/postgresql"]);
    expect(cfg.postgres.targets).toEqual([{ name: "main", url: "postgres://m:p@127.0.0.1/app" }]);
    expect(cfg.httpChecks[0]).toMatchObject({ name: "api", timeoutMs: 5000 });
  });

  test("errors name the variable but never echo secret values", () => {
    try {
      loadAgentConfig({
        MONITOR_URL: base.MONITOR_URL,
        AGENT_PG_URL: "mysql://user:hunter2@db/app",
        AGENT_TOKEN: "ima_secret",
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(String(error)).toContain("AGENT_PG_URL");
      expect(String(error)).not.toContain("hunter2");
    }
  });

  test("worker parses recipients and leaves WhatsApp disabled without credentials", () => {
    const cfg = loadWorkerConfig({
      DATABASE_URL: "postgres://u:p@db/m",
      WHATSAPP_RECIPIENT: "+919876543210, +14155550100",
    });
    expect(cfg.whatsapp.recipients).toEqual(["+919876543210", "+14155550100"]);
    expect(cfg.whatsapp.credentials).toBeNull();
    expect(() =>
      loadWorkerConfig({ DATABASE_URL: "postgres://u:p@db/m", WHATSAPP_RECIPIENT: "not-a-number" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadWorkerConfig({ DATABASE_URL: "postgres://u:p@db/m", ALERT_TIMEZONE: "Mars/Olympus" }),
    ).toThrow(ConfigError);
  });
});

describe("structured logging", () => {
  test("redacts secrets by key and inside strings", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l) });
    log.info("x", {
      authorization: "Bearer ima_abc",
      nested: { accessToken: "EAAG...", ok: 1 },
      url: "postgres://monitor:s3cret@db:5432/app",
      error: new Error("request failed with Bearer EAAGtoken"),
    });
    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry.authorization).toBe("[REDACTED]");
    expect(entry.nested).toEqual({ accessToken: "[REDACTED]", ok: 1 });
    expect(entry.url).toBe("postgres://monitor:[REDACTED]@db:5432/app");
    expect(entry.error.message).not.toContain("EAAGtoken");
    expect(redactString("https://x/?access_token=abc&x=1")).toBe("https://x/?access_token=[REDACTED]&x=1");
  });
});
