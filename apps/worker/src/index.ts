/**
 * Background worker: rule evaluation, notification dispatch and retention. Runs as its own
 * process/container so the HTTP API can be restarted (or fail) without stopping alerting.
 */
import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { ConfigError, loadWorkerConfig } from "@system-monitor/config";
import { createDatabase, serviceHeartbeats } from "@system-monitor/database";
import { createLogger } from "@system-monitor/shared";
import { sql } from "drizzle-orm";
import { type CycleStats, runEvaluationCycle } from "./evaluation/engine";
import { Loop } from "./loop";
import { dispatchDue } from "./notifications/dispatcher";
import { WhatsAppClient } from "./notifications/whatsapp";
import { applyRetention } from "./retention";

let config: ReturnType<typeof loadWorkerConfig>;
try {
  config = loadWorkerConfig();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : "failed to load configuration");
  process.exit(78);
}

const VERSION = "1.0.0";
const workerId = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
const log = createLogger({ level: config.logLevel, base: { service: "worker", workerId } });
const database = createDatabase(config.database.url, {
  poolMax: config.database.poolMax,
  applicationName: "system-monitor-worker",
});
const { db } = database;
const startedAt = new Date();
const status: { lastEvaluation?: CycleStats & { at: string; durationMs: number }; lastDispatchAt?: string } =
  {};

const wa = config.whatsapp;
const provider = wa.credentials
  ? new WhatsAppClient({
      accessToken: wa.credentials.accessToken,
      phoneNumberId: wa.credentials.phoneNumberId,
      apiVersion: wa.apiVersion,
      templateName: wa.templateName,
      templateLanguage: wa.templateLanguage,
      graphBaseUrl: wa.graphBaseUrl,
      timeoutMs: wa.timeoutMs,
    })
  : null;
if (!provider)
  log.warn("WhatsApp credentials not configured: notifications will stay queued and are not sent");
if (wa.recipients.length === 0)
  log.warn("WHATSAPP_RECIPIENT is empty: incidents are tracked but no notifications are queued");

let lastDeadmanPing = 0;
async function pingDeadman() {
  if (!config.deadmanPingUrl || Date.now() - lastDeadmanPing < 60_000) return;
  try {
    const res = await fetch(config.deadmanPingUrl, { method: "GET", signal: AbortSignal.timeout(5000) });
    await res.body?.cancel();
    lastDeadmanPing = Date.now();
  } catch (error) {
    log.warn("dead man's switch ping failed", { error });
  }
}

async function recordLiveness() {
  const now = new Date();
  await db
    .insert(serviceHeartbeats)
    .values({
      service: "worker",
      instanceId: workerId,
      version: VERSION,
      startedAt,
      lastSeenAt: now,
      details: status,
    })
    .onConflictDoUpdate({
      target: [serviceHeartbeats.service, serviceHeartbeats.instanceId],
      set: { lastSeenAt: sql`excluded.last_seen_at`, details: sql`excluded.details` },
    });
  await writeFile(config.healthFile, now.toISOString()).catch(() => {});
}

const evaluation = new Loop(
  "evaluation",
  config.evaluation.intervalSeconds * 1000,
  async () => {
    const t0 = performance.now();
    const stats = await runEvaluationCycle({
      db,
      log,
      now: () => new Date(),
      recipients: wa.recipients,
      staleAfterSeconds: config.evaluation.staleAfterSeconds,
      agentIntervalSeconds: config.evaluation.agentIntervalSeconds,
      maxAttempts: wa.maxAttempts,
      timeZone: config.alertTimezone,
    });
    const durationMs = Math.round(performance.now() - t0);
    status.lastEvaluation = { ...stats, at: new Date().toISOString(), durationMs };
    const changed =
      stats.created + stats.updated + stats.resolved + stats.deleted + stats.notificationsQueued;
    (changed > 0 || stats.errors > 0 ? log.info : log.debug)("evaluation cycle", { ...stats, durationMs });
    await recordLiveness();
    if (stats.errors === 0) await pingDeadman();
  },
  log,
);

const dispatch = new Loop(
  "dispatch",
  config.dispatch.intervalMs,
  async () => {
    if (!provider) return;
    const stats = await dispatchDue({ db, log, provider, workerId, now: () => new Date() });
    status.lastDispatchAt = new Date().toISOString();
    if (stats.claimed > 0) log.info("dispatch cycle", { ...stats });
  },
  log,
);

const retention = new Loop(
  "retention",
  3600_000,
  async () => {
    const deleted = await applyRetention(db, config.retention, new Date());
    log.info("retention applied", deleted);
  },
  log,
);

log.info("worker starting", {
  evaluationIntervalSeconds: config.evaluation.intervalSeconds,
  whatsappConfigured: provider !== null,
  recipients: wa.recipients.length,
});
evaluation.start();
dispatch.start(1000);
retention.start(60_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("worker shutting down", { signal });
  const force = setTimeout(() => process.exit(1), 25_000);
  await Promise.all([evaluation.stop(), dispatch.stop(), retention.stop()]);
  await database.close(5);
  clearTimeout(force);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
