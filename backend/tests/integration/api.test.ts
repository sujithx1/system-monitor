import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLogs, type Database, incidents, metricSamples, monitoredHosts } from "../../src/db";
import { createHost, describeDb, json, loginAs, makeApp, readJson, resetDb, testDb } from "./helpers";

describeDb("API authentication and authorization", () => {
  let db: Database;
  beforeEach(async () => {
    db = await testDb();
    await resetDb(db, { seedRules: true });
  });

  test("health endpoints are public and leak nothing", async () => {
    const app = makeApp(db);
    expect(await readJson(app.request("/health"))).toEqual({ status: "ok" });
    const ready = await app.request("/ready");
    expect(ready.status).toBe(200);
    expect(await readJson(ready)).toEqual({ status: "ready", checks: { database: "ok" } });
  });

  test("dashboard endpoints require a session", async () => {
    const app = makeApp(db);
    for (const path of ["/api/v1/hosts", "/api/v1/incidents", "/api/v1/alerts/rules", "/api/v1/overview"]) {
      const res = await app.request(path);
      expect(res.status).toBe(401);
      expect((await readJson(res)).error.code).toBe("unauthorized");
    }
  });

  test("agent tokens cannot be used as user credentials and vice versa", async () => {
    const app = makeApp(db);
    const { token } = await createHost(db);
    expect(
      (await app.request("/api/v1/hosts", { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
    const viewer = await loginAs(app, db, "viewer");
    const res = await app.request(
      "/api/v1/agents/heartbeat",
      json({ agentVersion: "1", hostname: "h", sentAt: new Date().toISOString() }, { cookie: viewer.cookie }),
    );
    expect(res.status).toBe(401);
  });

  test("wrong password is rejected and audited", async () => {
    const app = makeApp(db);
    const viewer = await loginAs(app, db, "viewer");
    const res = await app.request(
      "/api/v1/auth/login",
      json({ email: viewer.email, password: "wrong password!!" }),
    );
    expect(res.status).toBe(401);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.login_failed"));
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain("wrong password");
  });

  test("login is rate limited per IP", async () => {
    const app = makeApp(db);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push(
        (await app.request("/api/v1/auth/login", json({ email: `x${i}@example.com`, password: "nope" })))
          .status,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  test("role checks: viewer < operator < admin", async () => {
    const app = makeApp(db);
    const viewer = await loginAs(app, db, "viewer");
    const operator = await loginAs(app, db, "operator");
    const admin = await loginAs(app, db, "admin");
    const rules = await readJson(app.request("/api/v1/alerts/rules", { headers: { cookie: viewer.cookie } }));
    const ruleId = rules.items[0].id;
    const patch = (cookie: string) =>
      app.request(`/api/v1/alerts/rules/${ruleId}`, {
        ...json({ cooldownSeconds: 600 }, { cookie }),
        method: "PATCH",
      });
    expect((await patch(viewer.cookie)).status).toBe(403);
    expect((await patch(operator.cookie)).status).toBe(403);
    const ok = await patch(admin.cookie);
    expect(ok.status).toBe(200);
    expect((await readJson(ok)).cooldownSeconds).toBe(600);
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, "rule.update"));
    expect(audit[0]?.metadata).toMatchObject({
      before: { cooldownSeconds: 300 },
      after: { cooldownSeconds: 600 },
    });
  });

  test("rule updates are re-validated as a whole", async () => {
    const app = makeApp(db);
    const admin = await loginAs(app, db, "admin");
    const rules = await readJson(app.request("/api/v1/alerts/rules", { headers: { cookie: admin.cookie } }));
    const pg = rules.items.find((r: { name: string }) => r.name === "PostgreSQL health");
    const res = await app.request(`/api/v1/alerts/rules/${pg.id}`, {
      ...json({ metric: "cpu.usage_percent" }, { cookie: admin.cookie }),
      method: "PATCH",
    });
    expect(res.status).toBe(422);
    expect((await readJson(res)).error.details[0].path).toBe("metric");
  });

  test("logout invalidates the session server-side", async () => {
    const app = makeApp(db);
    const viewer = await loginAs(app, db, "viewer");
    expect((await app.request("/api/v1/auth/me", { headers: { cookie: viewer.cookie } })).status).toBe(200);
    await app.request("/api/v1/auth/logout", { method: "POST", headers: { cookie: viewer.cookie } });
    expect((await app.request("/api/v1/auth/me", { headers: { cookie: viewer.cookie } })).status).toBe(401);
  });

  test("cross-origin writes are rejected when PUBLIC_ORIGIN is set", async () => {
    const app = makeApp(db, { env: { PUBLIC_ORIGIN: "https://monitor.example.com" } });
    const res = await app.request(
      "/api/v1/auth/login",
      json({ email: "a@example.com", password: "x" }, { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
  });

  test("admin registers a host; the agent token is returned once and works", async () => {
    const app = makeApp(db);
    const admin = await loginAs(app, db, "admin");
    const res = await app.request(
      "/api/v1/hosts",
      json({ name: "db-prod-1", environment: "production" }, { cookie: admin.cookie }),
    );
    expect(res.status).toBe(201);
    const created = await readJson(res);
    expect(created.agentToken).toStartWith("ima_");
    const hb = await app.request(
      "/api/v1/agents/heartbeat",
      json(
        { agentVersion: "1.0.0", hostname: "db-prod-1", sentAt: new Date().toISOString() },
        { authorization: `Bearer ${created.agentToken}` },
      ),
    );
    expect(hb.status).toBe(200);
    const detail = await readJson(
      app.request(`/api/v1/hosts/${created.host.id}`, { headers: { cookie: admin.cookie } }),
    );
    expect(JSON.stringify(detail)).not.toContain(created.agentToken);
    expect(detail.health).toBe("healthy");

    const revoke = await app.request(`/api/v1/agents/${created.agent.id}/revoke`, {
      method: "POST",
      headers: { cookie: admin.cookie },
    });
    expect(revoke.status).toBe(200);
    const after = await app.request(
      "/api/v1/agents/heartbeat",
      json(
        { agentVersion: "1.0.0", hostname: "db-prod-1", sentAt: new Date().toISOString() },
        { authorization: `Bearer ${created.agentToken}` },
      ),
    );
    expect(after.status).toBe(401);
  });

  test("test notifications only go to configured recipients", async () => {
    const app = makeApp(db);
    const admin = await loginAs(app, db, "admin");
    const bad = await app.request(
      "/api/v1/alerts/test",
      json({ recipient: "+15555550123" }, { cookie: admin.cookie }),
    );
    expect(bad.status).toBe(403);
    const good = await app.request(
      "/api/v1/alerts/test",
      json({ recipient: "+91 98765 43210" }, { cookie: admin.cookie }),
    );
    expect(good.status).toBe(202);
    const list = await readJson(app.request("/api/v1/notifications", { headers: { cookie: admin.cookie } }));
    expect(list.items[0]).toMatchObject({ kind: "test", status: "queued", recipient: "+91******3210" });
  });

  test("errors are consistent and never include stack traces", async () => {
    const app = makeApp(db);
    const admin = await loginAs(app, db, "admin");
    const res = await app.request("/api/v1/incidents/not-a-uuid", { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body).toEqual({
      error: { code: "not_found", message: "resource not found", requestId: expect.any(String) },
    });
    expect(res.headers.get("x-request-id")).toBe(body.error.requestId);
    const notFound = await app.request("/api/v1/nope");
    expect((await readJson(notFound)).error.code).toBe("not_found");
  });
});

describeDb("metric ingestion", () => {
  let db: Database;
  beforeEach(async () => {
    db = await testDb();
    await resetDb(db);
  });

  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    snapshotId: crypto.randomUUID(),
    agentVersion: "1.0.0",
    hostname: "db-prod-1",
    collectedAt: new Date().toISOString(),
    metrics: [
      { name: "cpu.usage_percent", resource: "", status: "ok", value: 12.5 },
      { name: "disk.usage_percent", resource: "/", status: "ok", value: 70 },
      { name: "pg.latency_ms", resource: "main", status: "unavailable", value: null, error: "timeout" },
    ],
    ...overrides,
  });

  test("stores a snapshot; the host comes from the credential", async () => {
    const app = makeApp(db);
    const { host, token } = await createHost(db);
    const res = await app.request("/api/v1/metrics", json(snapshot(), { authorization: `Bearer ${token}` }));
    expect(res.status).toBe(202);
    expect(await readJson(res)).toEqual({ accepted: true, duplicate: false, samples: 3 });
    const rows = await db.select().from(metricSamples).where(eq(metricSamples.hostId, host.id));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.metric === "pg.latency_ms")).toMatchObject({
      status: "unavailable",
      value: null,
      error: "timeout",
    });
    const [h] = await db.select().from(monitoredHosts).where(eq(monitoredHosts.id, host.id));
    expect(h?.lastAgentVersion).toBe("1.0.0");
  });

  test("duplicate snapshots are idempotent", async () => {
    const app = makeApp(db);
    const { host, token } = await createHost(db);
    const body = snapshot();
    const first = await app.request("/api/v1/metrics", json(body, { authorization: `Bearer ${token}` }));
    const second = await app.request("/api/v1/metrics", json(body, { authorization: `Bearer ${token}` }));
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect((await readJson(second)).duplicate).toBe(true);
    expect(await db.$count(metricSamples, eq(metricSamples.hostId, host.id))).toBe(3);
  });

  test("stale or future-dated payloads are refused (replay protection)", async () => {
    const app = makeApp(db);
    const { token } = await createHost(db);
    const stale = await app.request(
      "/api/v1/metrics",
      json(snapshot({ collectedAt: new Date(Date.now() - 3600_000).toISOString() }), {
        authorization: `Bearer ${token}`,
      }),
    );
    expect(stale.status).toBe(422);
    expect((await readJson(stale)).error.code).toBe("stale_payload");
    const future = await app.request(
      "/api/v1/metrics",
      json(snapshot({ collectedAt: new Date(Date.now() + 600_000).toISOString() }), {
        authorization: `Bearer ${token}`,
      }),
    );
    expect((await readJson(future)).error.code).toBe("clock_skew");
  });

  test("malformed, oversized and wrongly typed payloads", async () => {
    const app = makeApp(db, { env: { MAX_BODY_BYTES: "2048" } });
    const { token } = await createHost(db);
    const auth = { authorization: `Bearer ${token}` };
    const invalid = await app.request(
      "/api/v1/metrics",
      json(
        snapshot({ metrics: [{ name: "cpu.usage_percent", resource: "", status: "ok", value: 250 }] }),
        auth,
      ),
    );
    expect(invalid.status).toBe(422);
    expect((await readJson(invalid)).error.details[0]).toEqual({
      path: "metrics.0.value",
      message: "percent must be within 0..100",
    });
    const notJson = await app.request("/api/v1/metrics", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{",
    });
    expect(notJson.status).toBe(400);
    const wrongType = await app.request("/api/v1/metrics", {
      method: "POST",
      headers: { ...auth, "content-type": "text/plain" },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);
    const big = snapshot({
      metrics: Array.from({ length: 60 }, (_, i) => ({
        name: "disk.usage_percent",
        resource: `/mnt/${i}`,
        status: "ok",
        value: 1,
      })),
    });
    expect((await app.request("/api/v1/metrics", json(big, auth))).status).toBe(413);
  });

  test("ingest is rate limited per agent", async () => {
    const app = makeApp(db);
    const { token } = await createHost(db);
    const hb = () =>
      json(
        { agentVersion: "1", hostname: "h", sentAt: new Date().toISOString() },
        { authorization: `Bearer ${token}` },
      );
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await app.request("/api/v1/agents/heartbeat", hb())).status;
    expect(last).toBe(429);
  });

  test("history endpoint returns raw pages and bucketed series", async () => {
    const app = makeApp(db);
    const { host, token } = await createHost(db);
    const admin = await loginAs(app, db, "viewer");
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await app.request(
        "/api/v1/metrics",
        json(snapshot({ collectedAt: new Date(now - (4 - i) * 30_000).toISOString() }), {
          authorization: `Bearer ${token}`,
        }),
      );
    }
    const page1 = await readJson(
      app.request(`/api/v1/hosts/${host.id}/metrics?metrics=cpu.usage_percent&step=0&limit=3`, {
        headers: { cookie: admin.cookie },
      }),
    );
    expect(page1.series[0].points).toHaveLength(3);
    expect(page1.nextCursor).toBeString();
    const page2 = await readJson(
      app.request(
        `/api/v1/hosts/${host.id}/metrics?metrics=cpu.usage_percent&step=0&limit=3&cursor=${page1.nextCursor}`,
        {
          headers: { cookie: admin.cookie },
        },
      ),
    );
    expect(page2.series[0].points).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const bucketed = await readJson(
      app.request(`/api/v1/hosts/${host.id}/metrics?metrics=cpu.usage_percent,disk.usage_percent&step=3600`, {
        headers: { cookie: admin.cookie },
      }),
    );
    expect(bucketed.stepSeconds).toBe(3600);
    expect(bucketed.series.map((s: { metric: string }) => s.metric).sort()).toEqual([
      "cpu.usage_percent",
      "disk.usage_percent",
    ]);
  });

  test("operators acknowledge firing incidents exactly once", async () => {
    const app = makeApp(db);
    await resetDb(db, { seedRules: true });
    const { host } = await createHost(db);
    const operator = await loginAs(app, db, "operator");
    const viewer = await loginAs(app, db, "viewer");
    const rules = await readJson(app.request("/api/v1/alerts/rules", { headers: { cookie: viewer.cookie } }));
    const [incident] = await db
      .insert(incidents)
      .values({
        ruleId: rules.items[0].id,
        hostId: host.id,
        fingerprint: "x",
        status: "firing",
        severity: "critical",
        summary: "CPU usage is 97%",
        startedAt: new Date(),
        firedAt: new Date(),
      })
      .returning();
    const url = `/api/v1/incidents/${incident?.id}/acknowledge`;
    expect((await app.request(url, { method: "POST", headers: { cookie: viewer.cookie } })).status).toBe(403);
    const ack = await app.request(url, json({ note: "looking into it" }, { cookie: operator.cookie }));
    expect(ack.status).toBe(200);
    expect(await readJson(ack)).toMatchObject({
      status: "acknowledged",
      acknowledgedBy: operator.email,
      metadata: { ackNote: "looking into it" },
    });
    expect((await app.request(url, { method: "POST", headers: { cookie: operator.cookie } })).status).toBe(
      409,
    );
  });
});
