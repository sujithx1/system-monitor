import { beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { alertRules, type Database, incidents, notificationAttempts, notifications } from "../../src/db";
import { silentLogger } from "../../src/shared";
import { claimDue, type DispatcherContext, dispatchDue } from "../../src/worker/notifications/dispatcher";
import type { NotificationProvider, SendOutcome } from "../../src/worker/notifications/whatsapp";
import { createHost, describeDb, makeApp, resetDb, testDb } from "./helpers";

const payload = {
  severityLabel: "CRITICAL",
  host: "h",
  service: "s",
  incidentId: "i",
  detectedAt: "t",
  details: "d",
  suggestedAction: "a",
};

function provider(outcomes: SendOutcome[]): NotificationProvider & { calls: number } {
  const p = {
    calls: 0,
    async send() {
      p.calls++;
      return (
        outcomes.shift() ?? {
          kind: "accepted" as const,
          messageId: `wamid.${crypto.randomUUID()}`,
          httpStatus: 200,
        }
      );
    },
  };
  return p;
}

describeDb("notification dispatcher", () => {
  let db: Database;
  let now: Date;
  beforeEach(async () => {
    db = await testDb();
    await resetDb(db, { seedRules: true });
    now = new Date();
  });

  const ctx = (p: NotificationProvider, workerId = "w1", at = now): DispatcherContext => ({
    db,
    log: silentLogger,
    provider: p,
    workerId,
    now: () => at,
    random: () => 0.5,
  });
  const enqueue = async (overrides: Partial<typeof notifications.$inferInsert> = {}) => {
    const [n] = await db
      .insert(notifications)
      .values({
        kind: "firing",
        recipient: "+919876543210",
        dedupeKey: crypto.randomUUID(),
        maxAttempts: 3,
        payload,
        nextAttemptAt: new Date(now.getTime() - 1000),
        ...overrides,
      })
      .returning();
    if (!n) throw new Error("insert failed");
    return n;
  };
  const reload = async (id: string) =>
    (await db.select().from(notifications).where(eq(notifications.id, id)))[0];

  test("accepted messages record the provider id and an attempt (accepted ≠ delivered)", async () => {
    const n = await enqueue();
    const stats = await dispatchDue(
      ctx(provider([{ kind: "accepted", messageId: "wamid.1", httpStatus: 200 }])),
    );
    expect(stats).toMatchObject({ claimed: 1, accepted: 1 });
    expect(await reload(n.id)).toMatchObject({
      status: "accepted",
      providerMessageId: "wamid.1",
      attemptCount: 1,
      deliveredAt: null,
      lockedBy: null,
    });
    const attempts = await db
      .select()
      .from(notificationAttempts)
      .where(eq(notificationAttempts.notificationId, n.id));
    expect(attempts).toEqual([
      expect.objectContaining({ attemptNumber: 1, outcome: "accepted", httpStatus: 200 }),
    ]);
  });

  test("a duplicate provider message id never leaves a sent message stuck (no re-send)", async () => {
    const a = await enqueue();
    const b = await enqueue();
    const p = provider([
      { kind: "accepted", messageId: "wamid.same", httpStatus: 200 },
      { kind: "accepted", messageId: "wamid.same", httpStatus: 200 },
    ]);
    expect((await dispatchDue(ctx(p))).accepted).toBe(2);
    const rows = [await reload(a.id), await reload(b.id)];
    expect(rows.map((r) => r?.status)).toEqual(["accepted", "accepted"]);
    expect(rows.filter((r) => r?.providerMessageId === "wamid.same")).toHaveLength(1);
    expect(p.calls).toBe(2);
  });

  test("transient failures retry with backoff, then fail after maxAttempts", async () => {
    const n = await enqueue();
    const timeout: SendOutcome = {
      kind: "retryable",
      httpStatus: null,
      errorCode: "timeout",
      errorMessage: "no response",
    };
    const p = provider([timeout, timeout, timeout]);

    await dispatchDue(ctx(p));
    let row = await reload(n.id);
    expect(row).toMatchObject({ status: "retrying", attemptCount: 1, lastError: "timeout: no response" });
    expect(row?.nextAttemptAt.getTime()).toBe(now.getTime() + 3750); // 5 s base, equal jitter at 0.5

    // Not due yet → nothing claimed.
    expect((await dispatchDue(ctx(p))).claimed).toBe(0);

    for (let i = 0; i < 2; i++) {
      const at = new Date((row?.nextAttemptAt.getTime() ?? 0) + 1);
      await dispatchDue(ctx(p, "w1", at));
      row = await reload(n.id);
    }
    expect(row).toMatchObject({ status: "failed", attemptCount: 3 });
    expect(p.calls).toBe(3);
    expect(await db.$count(notificationAttempts, eq(notificationAttempts.notificationId, n.id))).toBe(3);
  });

  test("permanent provider errors fail immediately", async () => {
    const n = await enqueue();
    await dispatchDue(
      ctx(
        provider([
          { kind: "permanent", httpStatus: 404, errorCode: "132001", errorMessage: "template missing" },
        ]),
      ),
    );
    expect(await reload(n.id)).toMatchObject({ status: "failed", attemptCount: 1 });
  });

  test("concurrent workers never claim the same notification", async () => {
    for (let i = 0; i < 30; i++) await enqueue();
    const [a, b, c] = await Promise.all([
      claimDue({ ...ctx(provider([])), batchSize: 20 }),
      claimDue({ ...ctx(provider([]), "w2"), batchSize: 20 }),
      claimDue({ ...ctx(provider([]), "w3"), batchSize: 20 }),
    ]);
    const ids = [...(a ?? []), ...(b ?? []), ...(c ?? [])].map((n) => n.id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });

  test("a crashed worker's lease expires and the message is retried by another worker", async () => {
    const n = await enqueue();
    await claimDue({ ...ctx(provider([]), "crashed"), leaseMs: 1000 });
    expect((await reload(n.id))?.status).toBe("sending");
    expect((await dispatchDue(ctx(provider([]), "w2"))).claimed).toBe(0); // lease still valid
    const p = provider([]);
    await dispatchDue(ctx(p, "w2", new Date(now.getTime() + 2000)));
    expect(await reload(n.id)).toMatchObject({ status: "accepted", attemptCount: 2 });
    expect(p.calls).toBe(1);
  });

  test("reminders for acknowledged incidents are cancelled, not sent", async () => {
    const { host } = await createHost(db);
    const [rule] = await db.select().from(alertRules).limit(1);
    const [incident] = await db
      .insert(incidents)
      .values({
        ruleId: rule?.id ?? "",
        hostId: host.id,
        fingerprint: "f",
        status: "acknowledged",
        severity: "critical",
        summary: "s",
        startedAt: now,
      })
      .returning();
    const n = await enqueue({ kind: "reminder", incidentId: incident?.id });
    const p = provider([]);
    expect((await dispatchDue(ctx(p))).cancelled).toBe(1);
    expect(p.calls).toBe(0);
    expect((await reload(n.id))?.status).toBe("cancelled");
  });

  test("delivery webhooks are signature-checked and advance status monotonically", async () => {
    const app = makeApp(db);
    const n = await enqueue();
    await dispatchDue(ctx(provider([{ kind: "accepted", messageId: "wamid.XYZ", httpStatus: 200 }])));
    const send = (statuses: Array<{ status: string; timestamp: string }>, secret = "test-app-secret") => {
      const body = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "1",
            changes: [
              { field: "messages", value: { statuses: statuses.map((s) => ({ id: "wamid.XYZ", ...s })) } },
            ],
          },
        ],
      });
      const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      return app.request("/api/v1/webhooks/whatsapp", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": sig },
        body,
      });
    };
    expect((await send([{ status: "delivered", timestamp: "1761652800" }], "wrong-secret")).status).toBe(401);
    expect((await reload(n.id))?.status).toBe("accepted");

    expect(
      (
        await send([
          { status: "read", timestamp: "1761652900" },
          { status: "delivered", timestamp: "1761652800" },
        ])
      ).status,
    ).toBe(200);
    expect(await reload(n.id)).toMatchObject({ status: "read", readAt: new Date(1761652900_000) });

    const verify = await app.request(
      "/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345",
    );
    expect(await verify.text()).toBe("12345");
    expect(
      (
        await app.request(
          "/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1",
        )
      ).status,
    ).toBe(403);
  });
});
