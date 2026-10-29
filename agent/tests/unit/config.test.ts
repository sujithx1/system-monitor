import { describe, expect, test } from "bun:test";
import { ConfigError, loadAgentConfig } from "../../src/config";

describe("agent configuration", () => {
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
});
