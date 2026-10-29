import { describe, expect, test } from "bun:test";
import { type DecideContext, decide, type IncidentState } from "../../apps/worker/src/evaluation/decide";
import type { EvalResult } from "../../apps/worker/src/evaluation/evaluate";

const NOW = new Date("2026-10-28T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const ctx = (overrides: Partial<DecideContext> = {}): DecideContext => ({
  now: NOW,
  lastNotifiedForFingerprint: null,
  canNotify: true,
  policy: {
    notifyWarning: true,
    notifyOnRecovery: true,
    cooldownSeconds: 300,
    reminderIntervalSeconds: 1800,
    escalationAfterSeconds: null,
    hasEscalationRecipients: false,
  },
  ...overrides,
});

const firing = (severity: "warning" | "critical" = "critical"): EvalResult => ({
  state: "firing",
  severity,
  value: 97,
  threshold: 95,
  since: minutesAgo(3),
  heldSeconds: 180,
});
const pending: EvalResult = {
  state: "pending",
  severity: "critical",
  value: 97,
  threshold: 95,
  since: NOW,
  heldSeconds: 0,
};
const ok: EvalResult = { state: "ok", value: 40 };

const incident = (o: Partial<IncidentState> = {}): IncidentState => ({
  id: "inc-1",
  status: "firing",
  severity: "critical",
  startedAt: minutesAgo(10),
  firedAt: minutesAgo(7),
  lastNotifiedAt: minutesAgo(7),
  notificationCount: 1,
  reminderCount: 0,
  escalatedAt: null,
  ...o,
});

describe("incident lifecycle", () => {
  test("breach starts a pending incident without notifying", () => {
    expect(decide(null, pending, ctx())).toMatchObject({ op: "create", status: "pending", notify: [] });
  });

  test("pending → firing notifies once", () => {
    const d = decide(
      incident({ status: "pending", firedAt: null, lastNotifiedAt: null, notificationCount: 0 }),
      firing(),
      ctx(),
    );
    expect(d).toEqual({
      op: "update",
      patch: { status: "firing", severity: "critical", firedAt: NOW },
      notify: [{ kind: "firing", audience: "default", key: "firing" }],
      cooldownSuppressed: false,
    });
  });

  test("an immediately-firing condition (disk) creates a firing incident", () => {
    expect(decide(null, firing(), ctx())).toMatchObject({
      op: "create",
      status: "firing",
      firedAt: NOW,
      notify: [{ kind: "firing" }],
    });
  });

  test("pending that clears is deleted silently", () => {
    expect(decide(incident({ status: "pending" }), ok, ctx())).toEqual({
      op: "delete",
      reason: "condition cleared before firing",
    });
  });

  test("firing that clears resolves with a recovery notification", () => {
    expect(decide(incident(), ok, ctx())).toEqual({
      op: "resolve",
      notify: [{ kind: "recovery", audience: "default", key: "recovery" }],
    });
  });

  test("acknowledged incidents still resolve and announce recovery", () => {
    expect(decide(incident({ status: "acknowledged" }), ok, ctx())).toMatchObject({
      op: "resolve",
      notify: [{ kind: "recovery" }],
    });
  });

  test("no recovery message for incidents that never notified", () => {
    expect(decide(incident({ notificationCount: 0 }), ok, ctx())).toEqual({ op: "resolve", notify: [] });
  });

  test("no data never changes state", () => {
    expect(decide(incident(), { state: "nodata", reason: "stale" }, ctx())).toEqual({ op: "none" });
  });

  test("steady firing within the reminder interval is a no-op (deduplication)", () => {
    expect(decide(incident(), firing(), ctx())).toEqual({ op: "none" });
  });
});

describe("notification policy", () => {
  test("warnings can be configured to not notify", () => {
    const c = ctx();
    c.policy.notifyWarning = false;
    expect(decide(null, firing("warning"), c)).toMatchObject({ op: "create", notify: [] });
    expect(decide(null, firing("critical"), c)).toMatchObject({ notify: [{ kind: "firing" }] });
  });

  test("cooldown suppresses re-firing of a flapping condition", () => {
    const d = decide(null, firing(), ctx({ lastNotifiedForFingerprint: minutesAgo(2) }));
    expect(d).toMatchObject({ op: "create", status: "firing", notify: [], cooldownSuppressed: true });
    expect(decide(null, firing(), ctx({ lastNotifiedForFingerprint: minutesAgo(6) }))).toMatchObject({
      notify: [{ kind: "firing" }],
    });
  });

  test("warning → critical always notifies and re-opens an acknowledged incident", () => {
    const d = decide(incident({ status: "acknowledged", severity: "warning" }), firing("critical"), ctx());
    expect(d).toMatchObject({
      op: "update",
      patch: { severity: "critical", status: "firing", acknowledgedAt: null, acknowledgedBy: null },
      notify: [{ kind: "severity_increase", key: "severity:critical" }],
    });
  });

  test("critical → warning downgrades quietly", () => {
    expect(decide(incident(), firing("warning"), ctx())).toMatchObject({
      op: "update",
      patch: { severity: "warning" },
      notify: [],
    });
  });

  test("unresolved critical incidents get numbered reminders", () => {
    const d = decide(incident({ lastNotifiedAt: minutesAgo(31), reminderCount: 2 }), firing(), ctx());
    expect(d).toMatchObject({
      op: "update",
      patch: { reminderCount: 3 },
      notify: [{ kind: "reminder", key: "reminder:3" }],
    });
  });

  test("reminders continue while still breaching even if the level is not currently held", () => {
    const d = decide(incident({ lastNotifiedAt: minutesAgo(31) }), pending, ctx());
    expect(d).toMatchObject({ notify: [{ kind: "reminder" }] });
  });

  test("no reminders for acknowledged or warning incidents", () => {
    expect(
      decide(incident({ status: "acknowledged", lastNotifiedAt: minutesAgo(60) }), firing(), ctx()),
    ).toEqual({ op: "none" });
    expect(
      decide(incident({ severity: "warning", lastNotifiedAt: minutesAgo(60) }), firing("warning"), ctx()),
    ).toEqual({ op: "none" });
  });

  test("escalation fires once after the configured time when unacknowledged", () => {
    const c = ctx();
    c.policy.escalationAfterSeconds = 600;
    c.policy.hasEscalationRecipients = true;
    const d = decide(incident({ firedAt: minutesAgo(11), lastNotifiedAt: minutesAgo(11) }), firing(), c);
    expect(d).toMatchObject({
      op: "update",
      patch: { escalatedAt: NOW },
      notify: [{ kind: "escalation", audience: "escalation" }],
    });
    expect(decide(incident({ firedAt: minutesAgo(11), escalatedAt: minutesAgo(1) }), firing(), c)).toEqual({
      op: "none",
    });
    expect(decide(incident({ status: "acknowledged", firedAt: minutesAgo(11) }), firing(), c)).toEqual({
      op: "none",
    });
  });

  test("without recipients state still changes but nothing is queued", () => {
    expect(decide(null, firing(), ctx({ canNotify: false }))).toMatchObject({
      op: "create",
      status: "firing",
      notify: [],
    });
    expect(decide(incident({ lastNotifiedAt: minutesAgo(60) }), firing(), ctx({ canNotify: false }))).toEqual(
      { op: "none" },
    );
  });
});
