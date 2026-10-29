/**
 * Failure simulator. Sends SYNTHETIC metric snapshots for a dedicated test host to a monitoring
 * server, so alert rules, incidents and WhatsApp delivery can be exercised end-to-end without
 * touching any production machine. Register a host such as `sim-test-1` and use its token.
 *
 *   MONITOR_URL=https://monitor.example.com AGENT_TOKEN=ima_... \
 *     bun run simulate --scenario high-cpu --minutes 6
 *
 * Scenarios: normal | high-cpu | high-memory | low-disk | inodes | pg-down | api-down |
 *            pg-connections | missed-heartbeat (sends nothing: the heartbeat rule fires after 90/180 s)
 */
import { parseArgs } from "node:util";
import type { MetricSample, MetricSnapshot } from "@system-monitor/shared";

const SCENARIOS = [
  "normal",
  "high-cpu",
  "high-memory",
  "low-disk",
  "inodes",
  "pg-down",
  "api-down",
  "pg-connections",
  "missed-heartbeat",
] as const;
type Scenario = (typeof SCENARIOS)[number];

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: "normal" },
    minutes: { type: "string", default: "6" },
    interval: { type: "string", default: "30" },
  },
});
const scenario = values.scenario as Scenario;
if (!SCENARIOS.includes(scenario)) throw new Error(`--scenario must be one of ${SCENARIOS.join(", ")}`);
const url = process.env.MONITOR_URL?.replace(/\/+$/, "");
const token = process.env.AGENT_TOKEN;
if (!url || !token) throw new Error("MONITOR_URL and AGENT_TOKEN are required");
const intervalMs = Number(values.interval) * 1000;
const endAt = Date.now() + Number(values.minutes) * 60_000;

const ok = (name: MetricSample["name"], value: number, resource = ""): MetricSample => ({
  name,
  resource,
  status: "ok",
  value,
});
const jitter = (base: number, spread: number) =>
  Math.max(0, Math.min(100, base + (Math.random() - 0.5) * spread));

function metrics(s: Scenario): MetricSample[] {
  return [
    ok("cpu.usage_percent", s === "high-cpu" ? jitter(97.5, 2) : jitter(25, 10)),
    ok("mem.usage_percent", s === "high-memory" ? jitter(97, 1.5) : jitter(55, 5)),
    ok("disk.usage_percent", s === "low-disk" ? 96.4 : 42.1, "/"),
    ok("disk.usage_percent", 61.3, "/var/lib/postgresql"),
    ok("disk.inode_usage_percent", s === "inodes" ? 96.2 : 12.5, "/"),
    ok("pg.up", s === "pg-down" ? 0 : 1, "main"),
    s === "pg-down"
      ? {
          name: "pg.latency_ms",
          resource: "main",
          status: "unavailable",
          value: null,
          error: "simulated: connection refused",
        }
      : ok("pg.latency_ms", jitter(3, 2), "main"),
    ok("pg.connections_usage_percent", s === "pg-connections" ? 97 : 18, "main"),
    ok("http.up", s === "api-down" ? 0 : 1, "app"),
    ok("http.latency_ms", s === "api-down" ? 5000 : jitter(40, 20), "app"),
  ];
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return res.status;
}

console.log(`Simulating "${scenario}" for ${values.minutes} min against ${url}`);
if (scenario === "missed-heartbeat") {
  console.log(
    "Not sending anything. Heartbeat warning fires after ~90 s, critical after ~180 s; it resolves",
  );
  console.log("when you run another scenario (e.g. --scenario normal --minutes 1).");
  process.exit(0);
}
while (Date.now() < endAt) {
  const snapshot: MetricSnapshot = {
    snapshotId: crypto.randomUUID(),
    agentVersion: "simulator-1.0.0",
    hostname: "simulated-host",
    collectedAt: new Date().toISOString(),
    metrics: metrics(scenario),
  };
  const [hb, m] = await Promise.all([
    post("/api/v1/agents/heartbeat", {
      agentVersion: "simulator-1.0.0",
      hostname: "simulated-host",
      sentAt: new Date().toISOString(),
    }),
    post("/api/v1/metrics", snapshot),
  ]);
  console.log(`${new Date().toISOString()} heartbeat=${hb} metrics=${m}`);
  await Bun.sleep(intervalMs);
}
