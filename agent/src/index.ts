/**
 * system-monitor-agent: push-only metrics agent for production VMs.
 *
 * It opens no listening sockets, executes no commands and performs no remediation; it only
 * reads /proc, statfs() on configured mounts, runs read-only SQL and HTTP GET health checks,
 * and pushes results to the monitoring server over HTTPS.
 */
import { readFileSync } from "node:fs";
import { SnapshotCollector, safeHostname } from "./collect";
import { ConfigError, loadAgentConfig } from "./config";
import { MonitorClient, SnapshotSender } from "./sender";
import { createLogger } from "./shared";
import { AGENT_VERSION } from "./version";

let config: ReturnType<typeof loadAgentConfig>;
try {
  config = loadAgentConfig();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : "failed to load configuration");
  process.exit(78); // EX_CONFIG: systemd will not hot-loop on a bad config with RestartPreventExitStatus.
}

const log = createLogger({
  level: config.logLevel,
  base: { service: "system-monitor-agent", version: AGENT_VERSION },
});
const client = new MonitorClient({
  baseUrl: config.monitorUrl,
  token: config.token,
  timeoutMs: config.requestTimeoutMs,
  ca: config.caFile ? readFileSync(config.caFile, "utf8") : undefined,
});
const collector = new SnapshotCollector(config, log);
const sender = new SnapshotSender(client, config.maxBuffer, log);

let stopping = false;
const timers = new Set<ReturnType<typeof setTimeout>>();

/** Fixed-rate loop that never overlaps itself (a slow cycle delays the next one, never doubles up). */
function every(seconds: number, name: string, task: () => Promise<void>): void {
  const run = async () => {
    const started = Date.now();
    try {
      await task();
    } catch (error) {
      log.error(`${name} cycle failed`, { error });
    }
    if (stopping) return;
    const timer = setTimeout(run, Math.max(1000, seconds * 1000 - (Date.now() - started)));
    timers.add(timer);
  };
  void run();
}

async function sendHeartbeat(): Promise<void> {
  try {
    const { status } = await client.post("/api/v1/agents/heartbeat", {
      agentVersion: AGENT_VERSION,
      hostname: safeHostname(),
      sentAt: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
    });
    if (status >= 300) log.warn("heartbeat rejected", { status });
  } catch (error) {
    log.warn("heartbeat failed", { error });
  }
}

async function collectAndSend(): Promise<void> {
  const snapshot = await collector.collect();
  const unavailableCount = snapshot.metrics.filter((m) => m.status === "unavailable").length;
  log.debug("collected snapshot", { metrics: snapshot.metrics.length, unavailable: unavailableCount });
  sender.enqueue(snapshot);
  await sender.flush();
}

async function main(): Promise<void> {
  log.info("agent starting", {
    monitor: config.monitorUrl,
    intervalSeconds: config.intervalSeconds,
    mounts: config.mounts,
    postgresTargets: config.postgres.targets.map((t) => t.name),
    httpChecks: config.httpChecks.map((c) => c.name),
  });
  await collector.prime();
  every(config.heartbeatSeconds, "heartbeat", sendHeartbeat);
  // First metrics cycle after one interval so CPU usage covers a full interval.
  const first = setTimeout(
    () => every(config.intervalSeconds, "metrics", collectAndSend),
    config.intervalSeconds * 1000,
  );
  timers.add(first);
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("agent stopping", { signal, pendingSnapshots: sender.pending });
  for (const t of timers) clearTimeout(t);
  await Promise.race([sender.flush(), new Promise((r) => setTimeout(r, 5000))]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
void main();
