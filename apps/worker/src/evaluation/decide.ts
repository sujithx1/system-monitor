import type { IncidentStatus, NotificationKind, Severity } from "@system-monitor/shared";
import type { EvalResult } from "./evaluate";

export interface IncidentState {
  id: string;
  status: IncidentStatus;
  severity: Severity;
  startedAt: Date;
  firedAt: Date | null;
  lastNotifiedAt: Date | null;
  notificationCount: number;
  reminderCount: number;
  escalatedAt: Date | null;
}

export interface NotificationPolicy {
  notifyWarning: boolean;
  notifyOnRecovery: boolean;
  cooldownSeconds: number;
  reminderIntervalSeconds: number | null;
  escalationAfterSeconds: number | null;
  hasEscalationRecipients: boolean;
}

export interface NotifyIntent {
  kind: NotificationKind;
  audience: "default" | "escalation";
  /** Stable per-incident key; combined with incident id + recipient for de-duplication. */
  key: string;
}

export type IncidentPatch = Partial<{
  status: IncidentStatus;
  severity: Severity;
  firedAt: Date;
  acknowledgedAt: null;
  acknowledgedBy: null;
  reminderCount: number;
  escalatedAt: Date;
}>;

export type Decision =
  | { op: "none" }
  | { op: "delete"; reason: string }
  | {
      op: "create";
      status: "pending" | "firing";
      severity: Severity;
      startedAt: Date;
      firedAt: Date | null;
      notify: NotifyIntent[];
      cooldownSuppressed: boolean;
    }
  | { op: "update"; patch: IncidentPatch; notify: NotifyIntent[]; cooldownSuppressed: boolean }
  | { op: "resolve"; notify: NotifyIntent[] };

export interface DecideContext {
  now: Date;
  policy: NotificationPolicy;
  /** Most recent notification time of any earlier incident with the same fingerprint. */
  lastNotifiedForFingerprint: Date | null;
  /** false when no recipients are configured: state still changes, nothing is queued. */
  canNotify: boolean;
}

const RANK: Record<Severity, number> = { warning: 1, critical: 2 };

/**
 * Pure incident state machine:
 *
 *   (none) ──breach──▶ pending ──held for duration──▶ firing ──ack──▶ acknowledged
 *      ▲                  │                             │  ▲               │
 *      └──cleared (row deleted, never notified)─────────┘  └─severity up───┘
 *                                    firing/acknowledged ──cleared──▶ resolved
 */
export function decide(incident: IncidentState | null, result: EvalResult, ctx: DecideContext): Decision {
  const { now, policy } = ctx;
  if (result.state === "nodata") return { op: "none" };

  const wants = (severity: Severity) => ctx.canNotify && (severity === "critical" || policy.notifyWarning);
  const inCooldown =
    ctx.lastNotifiedForFingerprint !== null &&
    now.getTime() - ctx.lastNotifiedForFingerprint.getTime() < policy.cooldownSeconds * 1000;

  if (result.state === "ok") {
    if (!incident) return { op: "none" };
    if (incident.status === "pending") return { op: "delete", reason: "condition cleared before firing" };
    if (incident.status === "resolved") return { op: "none" };
    const notify: NotifyIntent[] =
      ctx.canNotify && policy.notifyOnRecovery && incident.notificationCount > 0
        ? [{ kind: "recovery", audience: "default", key: "recovery" }]
        : [];
    return { op: "resolve", notify };
  }

  if (result.state === "pending") {
    if (!incident) {
      return {
        op: "create",
        status: "pending",
        severity: result.severity,
        startedAt: result.since,
        firedAt: null,
        notify: [],
        cooldownSuppressed: false,
      };
    }
    if (incident.status === "pending") {
      return incident.severity !== result.severity
        ? { op: "update", patch: { severity: result.severity }, notify: [], cooldownSuppressed: false }
        : { op: "none" };
    }
    // Already firing and still breaching (just not held at a level right now): keep the current
    // severity, but reminders and escalation continue.
    return ongoing(incident, incident.severity, ctx);
  }

  // result.state === "firing"
  const firingNotify = (): { notify: NotifyIntent[]; suppressed: boolean } => {
    if (!wants(result.severity)) return { notify: [], suppressed: false };
    if (inCooldown) return { notify: [], suppressed: true };
    return { notify: [{ kind: "firing", audience: "default", key: "firing" }], suppressed: false };
  };

  if (!incident) {
    const f = firingNotify();
    return {
      op: "create",
      status: "firing",
      severity: result.severity,
      startedAt: result.since,
      firedAt: now,
      notify: f.notify,
      cooldownSuppressed: f.suppressed,
    };
  }

  if (incident.status === "pending") {
    const f = firingNotify();
    return {
      op: "update",
      patch: { status: "firing", severity: result.severity, firedAt: now },
      notify: f.notify,
      cooldownSuppressed: f.suppressed,
    };
  }

  return ongoing(incident, result.severity, ctx);
}

/** An incident that is already firing or acknowledged and whose condition still holds. */
function ongoing(incident: IncidentState, severityNow: Severity, ctx: DecideContext): Decision {
  const { now, policy } = ctx;
  const patch: IncidentPatch = {};
  const notify: NotifyIntent[] = [];

  if (RANK[severityNow] > RANK[incident.severity]) {
    // Escalated severity always notifies and re-opens an acknowledged incident.
    patch.severity = severityNow;
    if (incident.status === "acknowledged") {
      patch.status = "firing";
      patch.acknowledgedAt = null;
      patch.acknowledgedBy = null;
    }
    if (ctx.canNotify)
      notify.push({ kind: "severity_increase", audience: "default", key: `severity:${severityNow}` });
    return { op: "update", patch, notify, cooldownSuppressed: false };
  }
  if (RANK[severityNow] < RANK[incident.severity]) {
    patch.severity = severityNow; // de-escalate quietly; recovery is announced on resolve
  }

  const status = patch.status ?? incident.status;
  const severity = patch.severity ?? incident.severity;
  const firedAt = incident.firedAt ?? now;

  if (
    status === "firing" &&
    severity === "critical" &&
    policy.reminderIntervalSeconds !== null &&
    ctx.canNotify
  ) {
    const reference = incident.lastNotifiedAt ?? firedAt;
    if (now.getTime() - reference.getTime() >= policy.reminderIntervalSeconds * 1000) {
      const n = incident.reminderCount + 1;
      patch.reminderCount = n;
      notify.push({ kind: "reminder", audience: "default", key: `reminder:${n}` });
    }
  }

  if (
    status === "firing" &&
    ctx.canNotify &&
    policy.escalationAfterSeconds !== null &&
    policy.hasEscalationRecipients &&
    incident.escalatedAt === null &&
    now.getTime() - firedAt.getTime() >= policy.escalationAfterSeconds * 1000
  ) {
    patch.escalatedAt = now;
    notify.push({ kind: "escalation", audience: "escalation", key: "escalation" });
  }

  return Object.keys(patch).length > 0 || notify.length > 0
    ? { op: "update", patch, notify, cooldownSuppressed: false }
    : { op: "none" };
}
