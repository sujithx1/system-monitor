import type {
  agents,
  alertRules,
  incidents,
  notificationAttempts,
  notifications,
} from "@system-monitor/database";
import type {
  AgentDto,
  AlertRuleDto,
  IncidentDto,
  MetricName,
  NotificationAttemptDto,
  NotificationDto,
} from "@system-monitor/shared";
import { maskPhone } from "./crypto";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toAgentDto(a: typeof agents.$inferSelect): AgentDto {
  return {
    id: a.id,
    name: a.name,
    tokenPrefix: a.tokenPrefix,
    enabled: a.enabled,
    lastSeenAt: iso(a.lastSeenAt),
    version: a.version,
    createdAt: a.createdAt.toISOString(),
    revokedAt: iso(a.revokedAt),
  };
}

export function toRuleDto(r: typeof alertRules.$inferSelect): AlertRuleDto {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    enabled: r.enabled,
    kind: r.kind,
    metric: r.metric as MetricName | null,
    hostId: r.hostId,
    resource: r.resource,
    comparator: r.comparator,
    warningThreshold: r.warningThreshold,
    criticalThreshold: r.criticalThreshold,
    warningForSeconds: r.warningForSeconds,
    criticalForSeconds: r.criticalForSeconds,
    windowSamples: r.windowSamples,
    cooldownSeconds: r.cooldownSeconds,
    reminderIntervalSeconds: r.reminderIntervalSeconds,
    escalationAfterSeconds: r.escalationAfterSeconds,
    escalationRecipients: r.escalationRecipients,
    notifyWarning: r.notifyWarning,
    notifyOnRecovery: r.notifyOnRecovery,
    suggestedAction: r.suggestedAction,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toIncidentDto(
  i: typeof incidents.$inferSelect,
  extra: { ruleName: string; hostName: string; acknowledgedByEmail: string | null },
): IncidentDto {
  return {
    id: i.id,
    ruleId: i.ruleId,
    ruleName: extra.ruleName,
    hostId: i.hostId,
    hostName: extra.hostName,
    resource: i.resource,
    status: i.status,
    severity: i.severity,
    summary: i.summary,
    value: i.value,
    threshold: i.threshold,
    startedAt: i.startedAt.toISOString(),
    firedAt: iso(i.firedAt),
    acknowledgedAt: iso(i.acknowledgedAt),
    acknowledgedBy: extra.acknowledgedByEmail,
    resolvedAt: iso(i.resolvedAt),
    lastNotifiedAt: iso(i.lastNotifiedAt),
    notificationCount: i.notificationCount,
    metadata: i.metadata,
  };
}

export function toNotificationDto(
  n: typeof notifications.$inferSelect,
  attempts?: Array<typeof notificationAttempts.$inferSelect>,
): NotificationDto {
  const pending = n.status === "queued" || n.status === "retrying" || n.status === "sending";
  return {
    id: n.id,
    incidentId: n.incidentId,
    kind: n.kind,
    recipient: maskPhone(n.recipient),
    status: n.status,
    attemptCount: n.attemptCount,
    maxAttempts: n.maxAttempts,
    nextAttemptAt: pending ? n.nextAttemptAt.toISOString() : null,
    lastError: n.lastError,
    createdAt: n.createdAt.toISOString(),
    acceptedAt: iso(n.acceptedAt),
    deliveredAt: iso(n.deliveredAt),
    readAt: iso(n.readAt),
    failedAt: iso(n.failedAt),
    ...(attempts
      ? {
          attempts: attempts.map(
            (a): NotificationAttemptDto => ({
              attemptNumber: a.attemptNumber,
              startedAt: a.startedAt.toISOString(),
              durationMs: a.durationMs,
              httpStatus: a.httpStatus,
              outcome: a.outcome,
              errorCode: a.errorCode,
              errorMessage: a.errorMessage,
            }),
          ),
        }
      : {}),
  };
}
