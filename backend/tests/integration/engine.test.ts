import { beforeEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { pgErrorCode } from "../../src/api/lib/errors";
import { alertRules, type Database, incidents, monitoredHosts, notifications } from "../../src/db";
import { applyResult, runEvaluationCycle } from "../../src/worker/evaluation/engine";
import {
  createHost,
  describeDb,
  engineContext,
  insertSeries,
  json,
  loginAs,
  makeApp,
  RECIPIENTS,
  resetDb,
  testDb,
} from "./helpers";

const minutes = (n: number) => n * 60_000;

describeDb("alert evaluation engine", () => {
  let db: Database;
  let now: Date;
  beforeEach(async () => {
    db = await testDb();
    await resetDb(db, { seedRules: true });
    now = new Date(Math.floor(Date.now() / 1000) * 1000);
  });

  const rule = async (name: string) => {
    const [r] = await db.select().from(alertRules).where(eq(alertRules.name, name));
    if (!r) throw new Error(`rule ${name} missing`);
    return r;
  };
  /** Incidents of one rule on a host (time-travel in these tests also trips the heartbeat rule). */
  const incidentsFor = async (hostId: string, ruleName: string) =>
    db
      .select()
      .from(incidents)
      .where(and(eq(incidents.hostId, hostId), eq(incidents.ruleId, (await rule(ruleName)).id)));
  const notificationsFor = (incidentId: string) =>
    db.select().from(notifications).where(eq(notifications.incidentId, incidentId));

  test("a temporary CPU spike creates at most a pending incident and no notification", async () => {
    const h = await createHost(db);
    await insertSeries(db, { hostId: h.host.id, agentId: h.agent.id }, "cpu.usage_percent", [20, 20, 99], {
      end: now,
    });
    await runEvaluationCycle(engineContext(db, now));
    const rows = await incidentsFor(h.host.id, "CPU usage");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", severity: "critical", firedAt: null });
    expect(await db.$count(notifications)).toBe(0);

    // Spike over: pending incident disappears silently.
    await insertSeries(db, { hostId: h.host.id, agentId: h.agent.id }, "cpu.usage_percent", [25], {
      end: new Date(now.getTime() + 30_000),
    });
    await runEvaluationCycle(engineContext(db, new Date(now.getTime() + 30_000)));
    expect(await incidentsFor(h.host.id, "CPU usage")).toHaveLength(0);
  });

  test("sustained critical CPU fires once, deduplicates, reminds, and recovers", async () => {
    const h = await createHost(db);
    const target = { hostId: h.host.id, agentId: h.agent.id };
    await insertSeries(db, target, "cpu.usage_percent", [96, 97, 98, 99, 97, 96, 98], { end: now }); // 180 s
    const stats = await runEvaluationCycle(engineContext(db, now));
    expect(stats).toMatchObject({ created: 1, notificationsQueued: 2, errors: 0 });

    const [incident] = await incidentsFor(h.host.id, "CPU usage");
    expect(incident).toMatchObject({
      status: "firing",
      severity: "critical",
      notificationCount: 2,
      threshold: 95,
    });
    expect(incident?.summary).toContain("CPU usage is 98.0%");
    const queued = await notificationsFor(incident?.id ?? "");
    expect(queued.map((n) => n.recipient).sort()).toEqual([...RECIPIENTS].sort());
    expect(queued[0]?.payload).toMatchObject({
      severityLabel: "CRITICAL",
      host: h.host.name,
      service: "CPU usage",
    });

    // Re-evaluating (e.g. after a worker restart) does not create duplicates.
    await runEvaluationCycle(engineContext(db, now));
    await runEvaluationCycle(engineContext(db, new Date(now.getTime() + 15_000)));
    expect(await incidentsFor(h.host.id, "CPU usage")).toHaveLength(1);
    expect(await notificationsFor(incident?.id ?? "")).toHaveLength(2);

    // 31 minutes later, still critical: one reminder per recipient.
    const later = new Date(now.getTime() + minutes(31));
    await insertSeries(db, target, "cpu.usage_percent", [97, 98], { end: later });
    await runEvaluationCycle(engineContext(db, later));
    await runEvaluationCycle(engineContext(db, later));
    const afterReminder = await notificationsFor(incident?.id ?? "");
    expect(afterReminder.filter((n) => n.kind === "reminder")).toHaveLength(2);

    // Recovery.
    const recovered = new Date(later.getTime() + 30_000);
    await insertSeries(db, target, "cpu.usage_percent", [30], { end: recovered });
    const s2 = await runEvaluationCycle(engineContext(db, recovered));
    expect(s2.resolved).toBe(1);
    const [resolved] = await incidentsFor(h.host.id, "CPU usage");
    expect(resolved).toMatchObject({
      status: "resolved",
      resolvedAt: recovered,
      metadata: { recoveredValue: 30 },
    });
    const recovery = (await notificationsFor(incident?.id ?? "")).filter((n) => n.kind === "recovery");
    expect(recovery).toHaveLength(2);
    expect(recovery[0]?.payload.severityLabel).toBe("RESOLVED");
  });

  test("concurrent workers evaluating the same rule create one incident and one notification per recipient", async () => {
    const h = await createHost(db);
    const r = await rule("Disk usage");
    const result = {
      state: "firing" as const,
      severity: "critical" as const,
      value: 97,
      threshold: 95,
      since: now,
      heldSeconds: 0,
    };
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => applyResult(engineContext(db, now), r, h.host, "/", result, now)),
    );
    expect(outcomes.filter((o) => o.op === "created")).toHaveLength(1);
    const rows = await incidentsFor(h.host.id, "Disk usage");
    expect(rows).toHaveLength(1);
    expect(await notificationsFor(rows[0]?.id ?? "")).toHaveLength(RECIPIENTS.length);
  });

  test("the database refuses a second active incident for the same rule/host/resource", async () => {
    const h = await createHost(db);
    const r = await rule("Disk usage");
    const values = {
      ruleId: r.id,
      hostId: h.host.id,
      resource: "/",
      fingerprint: "f",
      status: "firing" as const,
      severity: "critical" as const,
      summary: "s",
      startedAt: now,
    };
    await db.insert(incidents).values(values);
    const error = await db
      .insert(incidents)
      .values(values)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(pgErrorCode(error)).toBe("23505"); // unique_violation on incidents_one_active_uq
    // A resolved one may coexist.
    await db.insert(incidents).values({ ...values, status: "resolved", resolvedAt: now });
  });

  test("heartbeat timeout: warning, then critical with escalation notice, then recovery", async () => {
    const h = await createHost(db, "web-1", { lastHeartbeatAt: new Date(now.getTime() - 100_000) });
    await runEvaluationCycle(engineContext(db, now));
    let [incident] = await incidentsFor(h.host.id, "Agent heartbeat");
    expect(incident).toMatchObject({ status: "firing", severity: "warning" });
    expect(incident?.summary).toContain("No heartbeat from agent for 1m 40s");

    const t2 = new Date(now.getTime() + 90_000);
    await runEvaluationCycle(engineContext(db, t2));
    [incident] = await incidentsFor(h.host.id, "Agent heartbeat");
    expect(incident?.severity).toBe("critical");
    const kinds = (await notificationsFor(incident?.id ?? "")).map((n) => n.kind);
    expect(kinds.filter((k) => k === "severity_increase")).toHaveLength(2);

    await db.update(monitoredHosts).set({ lastHeartbeatAt: t2 }).where(eq(monitoredHosts.id, h.host.id));
    await runEvaluationCycle(engineContext(db, t2));
    [incident] = await incidentsFor(h.host.id, "Agent heartbeat");
    expect(incident?.status).toBe("resolved");
  });

  test("PostgreSQL down for two consecutive checks is critical and includes the error", async () => {
    const h = await createHost(db);
    const target = { hostId: h.host.id, agentId: h.agent.id };
    await insertSeries(db, target, "pg.up", [1, 1, 0], { end: now, resource: "main" });
    await runEvaluationCycle(engineContext(db, now));
    expect((await incidentsFor(h.host.id, "PostgreSQL health"))[0]).toMatchObject({ status: "pending" });
    await insertSeries(db, target, "pg.up", [0], { end: new Date(now.getTime() + 30_000), resource: "main" });
    await runEvaluationCycle(engineContext(db, new Date(now.getTime() + 30_000)));
    const [incident] = await incidentsFor(h.host.id, "PostgreSQL health");
    expect(incident).toMatchObject({ status: "firing", severity: "critical", resource: "main" });
  });

  test("stale data does not resolve an open incident", async () => {
    const h = await createHost(db);
    const target = { hostId: h.host.id, agentId: h.agent.id };
    await insertSeries(db, target, "disk.usage_percent", [97], { end: now, resource: "/" });
    await runEvaluationCycle(engineContext(db, now));
    const later = new Date(now.getTime() + minutes(10));
    await runEvaluationCycle(engineContext(db, later));
    expect((await incidentsFor(h.host.id, "Disk usage"))[0]?.status).toBe("firing");
  });

  test("acknowledgement stops reminders; cooldown suppresses flapping", async () => {
    const app = makeApp(db);
    const operator = await loginAs(app, db, "operator");
    const h = await createHost(db);
    const target = { hostId: h.host.id, agentId: h.agent.id };
    await insertSeries(db, target, "disk.usage_percent", [97], { end: now, resource: "/" });
    await runEvaluationCycle(engineContext(db, now));
    const [incident] = await incidentsFor(h.host.id, "Disk usage");
    const ack = await app.request(
      `/api/v1/incidents/${incident?.id}/acknowledge`,
      json({}, { cookie: operator.cookie }),
    );
    expect(ack.status).toBe(200);

    const later = new Date(now.getTime() + minutes(40));
    await insertSeries(db, target, "disk.usage_percent", [97], { end: later, resource: "/" });
    await runEvaluationCycle(engineContext(db, later));
    expect((await notificationsFor(incident?.id ?? "")).filter((n) => n.kind === "reminder")).toHaveLength(0);

    // Recover, then breach again within the 5-minute cooldown: new incident, no new page.
    const t1 = new Date(later.getTime() + 30_000);
    await insertSeries(db, target, "disk.usage_percent", [50], { end: t1, resource: "/" });
    await runEvaluationCycle(engineContext(db, t1));
    const t2 = new Date(t1.getTime() + 30_000);
    await insertSeries(db, target, "disk.usage_percent", [97], { end: t2, resource: "/" });
    await runEvaluationCycle(engineContext(db, t2));
    const all = await incidentsFor(h.host.id, "Disk usage");
    const reopened = all.find((i) => i.status === "firing");
    expect(reopened?.metadata).toMatchObject({ cooldownSuppressed: true });
    expect(await notificationsFor(reopened?.id ?? "")).toHaveLength(0);
  });

  test("disabling a rule closes its open incidents without paging", async () => {
    const h = await createHost(db);
    await insertSeries(db, { hostId: h.host.id, agentId: h.agent.id }, "disk.usage_percent", [97], {
      end: now,
      resource: "/",
    });
    await runEvaluationCycle(engineContext(db, now));
    const r = await rule("Disk usage");
    await db.update(alertRules).set({ enabled: false }).where(eq(alertRules.id, r.id));
    await runEvaluationCycle(engineContext(db, now));
    const [incident] = await db
      .select()
      .from(incidents)
      .where(and(eq(incidents.hostId, h.host.id), eq(incidents.ruleId, r.id)));
    expect(incident).toMatchObject({
      status: "resolved",
      metadata: { resolvedReason: "rule or host disabled" },
    });
    expect((await notificationsFor(incident?.id ?? "")).filter((n) => n.kind === "recovery")).toHaveLength(0);
  });

  test("escalation goes to the escalation recipients once", async () => {
    const r = await rule("Disk usage");
    await db
      .update(alertRules)
      .set({ escalationAfterSeconds: 600, escalationRecipients: ["+447700900123"] })
      .where(eq(alertRules.id, r.id));
    const h = await createHost(db);
    const target = { hostId: h.host.id, agentId: h.agent.id };
    await insertSeries(db, target, "disk.usage_percent", [97], { end: now, resource: "/" });
    await runEvaluationCycle(engineContext(db, now));
    const later = new Date(now.getTime() + minutes(11));
    await insertSeries(db, target, "disk.usage_percent", [97], { end: later, resource: "/" });
    await runEvaluationCycle(engineContext(db, later));
    await runEvaluationCycle(engineContext(db, later));
    const [incident] = await incidentsFor(h.host.id, "Disk usage");
    const escalations = (await notificationsFor(incident?.id ?? "")).filter((n) => n.kind === "escalation");
    expect(escalations.map((n) => n.recipient)).toEqual(["+447700900123"]);
  });
});
