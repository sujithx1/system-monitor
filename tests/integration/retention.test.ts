import { beforeEach, expect, test } from "bun:test";
import {
  alertRules,
  type Database,
  incidents,
  metricSamples,
  metricSnapshots,
  notifications,
} from "@system-monitor/database";
import { applyRetention } from "../../apps/worker/src/retention";
import { createHost, describeDb, insertSeries, loginAs, makeApp, readJson, resetDb, testDb } from "./helpers";

const DAY = 86_400_000;

describeDb("retention and pagination", () => {
  let db: Database;
  beforeEach(async () => {
    db = await testDb();
    await resetDb(db, { seedRules: true });
  });

  test("old metrics, terminal notifications and resolved incidents are purged; recent data is kept", async () => {
    const now = new Date();
    const h = await createHost(db);
    const target = { hostId: h.host.id, agentId: h.agent.id };
    await insertSeries(db, target, "cpu.usage_percent", [1, 2, 3], {
      end: new Date(now.getTime() - 40 * DAY),
    });
    await insertSeries(db, target, "cpu.usage_percent", [4, 5], { end: now });
    const [rule] = await db.select().from(alertRules).limit(1);
    const base = {
      ruleId: rule?.id ?? "",
      hostId: h.host.id,
      fingerprint: "f",
      severity: "warning" as const,
      summary: "s",
    };
    await db.insert(incidents).values([
      {
        ...base,
        status: "resolved",
        startedAt: new Date(now.getTime() - 400 * DAY),
        resolvedAt: new Date(now.getTime() - 400 * DAY),
      },
      {
        ...base,
        status: "resolved",
        startedAt: new Date(now.getTime() - 2 * DAY),
        resolvedAt: new Date(now.getTime() - DAY),
      },
      { ...base, status: "firing", startedAt: new Date(now.getTime() - 400 * DAY) },
    ]);
    const payload = {
      severityLabel: "",
      host: "",
      service: "",
      incidentId: "",
      detectedAt: "",
      details: "",
      suggestedAction: "",
    };
    await db.insert(notifications).values([
      {
        kind: "test",
        recipient: "+1",
        dedupeKey: "a",
        maxAttempts: 1,
        payload,
        status: "delivered",
        createdAt: new Date(now.getTime() - 100 * DAY),
      },
      {
        kind: "test",
        recipient: "+1",
        dedupeKey: "b",
        maxAttempts: 1,
        payload,
        status: "queued",
        createdAt: new Date(now.getTime() - 100 * DAY),
      },
    ]);

    const deleted = await applyRetention(
      db,
      { metricsDays: 30, incidentsDays: 365, notificationsDays: 90 },
      now,
    );
    expect(deleted).toMatchObject({ samples: 3, snapshots: 3, incidents: 1, notifications: 1 });
    expect(await db.$count(metricSamples)).toBe(2);
    expect(await db.$count(metricSnapshots)).toBe(2);
    expect(await db.$count(incidents)).toBe(2); // open incidents are never purged
    expect(await db.$count(notifications)).toBe(1); // queued ones are kept
  });

  test("incident list keyset pagination returns every row exactly once", async () => {
    const app = makeApp(db);
    const viewer = await loginAs(app, db, "viewer");
    const h = await createHost(db);
    const [rule] = await db.select().from(alertRules).limit(1);
    const t = Date.now();
    // Include identical timestamps to exercise the id tie-breaker.
    await db.insert(incidents).values(
      Array.from({ length: 25 }, (_, i) => ({
        ruleId: rule?.id ?? "",
        hostId: h.host.id,
        fingerprint: "f",
        status: "resolved" as const,
        severity: "warning" as const,
        summary: `#${i}`,
        startedAt: new Date(t - Math.floor(i / 3) * 1000),
        resolvedAt: new Date(t),
      })),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = `limit=10${cursor ? `&cursor=${cursor}` : ""}`;
      const page = (await readJson(
        app.request(`/api/v1/incidents?${qs}`, { headers: { cookie: viewer.cookie } }),
      )) as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);

    const bad = await app.request("/api/v1/incidents?cursor=garbage", { headers: { cookie: viewer.cookie } });
    expect(bad.status).toBe(400);
    const tooBig = await app.request("/api/v1/incidents?limit=1000", { headers: { cookie: viewer.cookie } });
    expect(tooBig.status).toBe(422);
  });
});
