/**
 * Integration tests need an isolated, disposable PostgreSQL database:
 *   TEST_DATABASE_URL=postgres://monitor_owner:testpass@127.0.0.1:55439/system_monitor_test bun test
 * Every table is truncated between tests. Never point this at a real monitoring database.
 */
import { describe } from "bun:test";
import { loadApiConfig } from "@system-monitor/config";
import {
  agents,
  createDatabase,
  type Database,
  type DatabaseHandle,
  metricSamples,
  metricSnapshots,
  monitoredHosts,
  seedDefaultRules,
  users,
} from "@system-monitor/database";
import { type MetricName, silentLogger, type UserRole } from "@system-monitor/shared";
import { sql } from "drizzle-orm";
import { createApp } from "../../apps/api/src/app";
import { AGENT_TOKEN_PREFIX, generateToken, sha256Hex } from "../../apps/api/src/lib/crypto";
import type { EngineContext } from "../../apps/worker/src/evaluation/engine";
import { runMigrations } from "../../packages/database/src/migrate";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;
if (TEST_DB_URL && !/test/i.test(new URL(TEST_DB_URL).pathname)) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name contains 'test'");
}
export const describeDb = TEST_DB_URL ? describe : describe.skip;
export const RECIPIENTS = ["+919876543210", "+14155550100"];

let handle: DatabaseHandle | null = null;
export async function testDb(): Promise<Database> {
  if (!TEST_DB_URL) throw new Error("TEST_DATABASE_URL is not set");
  if (!handle) {
    await runMigrations(TEST_DB_URL, { seed: false });
    handle = createDatabase(TEST_DB_URL, { poolMax: 10, applicationName: "system-monitor-tests" });
  }
  return handle.db;
}

export async function resetDb(db: Database, options: { seedRules?: boolean } = {}) {
  await db.execute(sql`TRUNCATE notification_attempts, notifications, incidents, alert_rules, metric_samples,
    metric_snapshots, agents, monitored_hosts, sessions, users, audit_logs, service_heartbeats CASCADE`);
  if (options.seedRules) await seedDefaultRules(db);
}

export function apiConfig(overrides: Record<string, string> = {}) {
  return loadApiConfig({
    DATABASE_URL: TEST_DB_URL,
    COOKIE_SECURE: "false",
    WHATSAPP_RECIPIENT: RECIPIENTS.join(","),
    WHATSAPP_APP_SECRET: "test-app-secret",
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: "test-verify-token",
    ...overrides,
  });
}

export function makeApp(db: Database, options: { env?: Record<string, string>; now?: () => Date } = {}) {
  return createApp({
    db,
    config: apiConfig(options.env),
    log: silentLogger,
    pingDb: async () => {},
    now: options.now,
  });
}

export async function createUser(db: Database, role: UserRole) {
  const email = `${role}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "correct horse battery staple";
  const [user] = await db
    .insert(users)
    .values({
      email,
      role,
      passwordHash: await Bun.password.hash(password, { algorithm: "argon2id", timeCost: 2 }),
    })
    .returning();
  if (!user) throw new Error("user insert failed");
  return { user, email, password };
}

type App = ReturnType<typeof makeApp>;
export async function login(app: App, email: string, password: string): Promise<string> {
  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("no session cookie");
  return cookie;
}

export async function loginAs(app: App, db: Database, role: UserRole) {
  const u = await createUser(db, role);
  return { ...u, cookie: await login(app, u.email, u.password) };
}

export async function createHost(
  db: Database,
  name = `host-${crypto.randomUUID().slice(0, 8)}`,
  options: { lastHeartbeatAt?: Date } = {},
) {
  const [host] = await db
    .insert(monitoredHosts)
    .values({ name, lastHeartbeatAt: options.lastHeartbeatAt ?? new Date() })
    .returning();
  if (!host) throw new Error("host insert failed");
  const token = generateToken(AGENT_TOKEN_PREFIX);
  const [agent] = await db
    .insert(agents)
    .values({
      hostId: host.id,
      name: "default",
      tokenHash: sha256Hex(token),
      tokenPrefix: token.slice(0, 12),
    })
    .returning();
  if (!agent) throw new Error("agent insert failed");
  return { host, agent, token };
}

/** Inserts one sample per snapshot, `intervalSeconds` apart, the last one at `end`. */
export async function insertSeries(
  db: Database,
  target: { hostId: string; agentId: string },
  metric: MetricName,
  values: Array<number | null>,
  options: { end: Date; intervalSeconds?: number; resource?: string },
) {
  const interval = (options.intervalSeconds ?? 30) * 1000;
  for (let i = 0; i < values.length; i++) {
    const collectedAt = new Date(options.end.getTime() - (values.length - 1 - i) * interval);
    const snapshotId = Bun.randomUUIDv7();
    await db.insert(metricSnapshots).values({
      id: snapshotId,
      hostId: target.hostId,
      agentId: target.agentId,
      snapshotKey: crypto.randomUUID(),
      agentVersion: "test",
      collectedAt,
      sampleCount: 1,
    });
    const value = values[i] ?? null;
    await db.insert(metricSamples).values({
      id: Bun.randomUUIDv7(),
      snapshotId,
      hostId: target.hostId,
      metric,
      resource: options.resource ?? "",
      status: value === null ? "unavailable" : "ok",
      value,
      collectedAt,
    });
  }
}

export function engineContext(
  db: Database,
  now: Date,
  overrides: Partial<EngineContext> = {},
): EngineContext {
  return {
    db,
    log: silentLogger,
    now: () => now,
    recipients: RECIPIENTS,
    staleAfterSeconds: 120,
    agentIntervalSeconds: 30,
    maxAttempts: 5,
    timeZone: "UTC",
    ...overrides,
  };
}

export const json = (body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...extra },
  body: JSON.stringify(body),
});

/** Untyped JSON body for assertions (responses are validated by the expectations themselves). */
// biome-ignore lint/suspicious/noExplicitAny: test assertions inspect arbitrary JSON
export type Json = any;
export const readJson = async (res: Response | Promise<Response>): Promise<Json> => (await res).json();
