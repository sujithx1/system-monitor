/**
 * Response shapes of the monitoring API (JSON over HTTP; timestamps are ISO-8601 strings).
 * Shared with the dashboard so both sides agree on the contract.
 */
import type { MetricName } from "./metrics";
import type { Comparator, IncidentStatus, RuleKind, Severity } from "./rules";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: Array<{ path: string; message: string }>;
  };
}

export const USER_ROLES = ["viewer", "operator", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface UserDto {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
}

export type HostHealth = "healthy" | "warning" | "critical" | "offline" | "unknown" | "disabled";

export interface HostSummaryDto {
  id: string;
  name: string;
  displayName: string | null;
  environment: string | null;
  enabled: boolean;
  health: HostHealth;
  lastHeartbeatAt: string | null;
  lastMetricsAt: string | null;
  agentVersion: string | null;
  hostname: string | null;
  activeIncidents: number;
  latest: { cpu: number | null; memory: number | null; diskMax: number | null };
}

export interface AgentDto {
  id: string;
  name: string;
  tokenPrefix: string;
  enabled: boolean;
  lastSeenAt: string | null;
  version: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface LatestMetricDto {
  metric: MetricName;
  resource: string;
  value: number | null;
  status: "ok" | "unavailable";
  error: string | null;
  collectedAt: string;
}

export interface HostDetailDto extends HostSummaryDto {
  description: string | null;
  createdAt: string;
  agents: AgentDto[];
  metrics: LatestMetricDto[];
  incidents: IncidentDto[];
}

export interface MetricPointDto {
  t: string;
  /** Average over the bucket (or the raw value when not downsampled). */
  value: number | null;
  max: number | null;
}

export interface MetricSeriesDto {
  metric: MetricName;
  resource: string;
  points: MetricPointDto[];
}

export interface MetricHistoryDto {
  hostId: string;
  from: string;
  to: string;
  stepSeconds: number | null;
  series: MetricSeriesDto[];
}

export interface IncidentDto {
  id: string;
  ruleId: string;
  ruleName: string;
  hostId: string;
  hostName: string;
  resource: string;
  status: IncidentStatus;
  severity: Severity;
  summary: string;
  value: number | null;
  threshold: number | null;
  startedAt: string;
  firedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  lastNotifiedAt: string | null;
  notificationCount: number;
  metadata: Record<string, unknown>;
}

export const NOTIFICATION_KINDS = [
  "firing",
  "severity_increase",
  "reminder",
  "escalation",
  "recovery",
  "test",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_STATUSES = [
  "queued",
  "sending",
  "retrying",
  "accepted",
  "sent",
  "delivered",
  "read",
  "failed",
  "cancelled",
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export interface NotificationAttemptDto {
  attemptNumber: number;
  startedAt: string;
  durationMs: number | null;
  httpStatus: number | null;
  outcome: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface NotificationDto {
  id: string;
  incidentId: string | null;
  kind: NotificationKind;
  /** Masked phone number, e.g. "+91******3210". */
  recipient: string;
  status: NotificationStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  acceptedAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  attempts?: NotificationAttemptDto[];
}

export interface IncidentDetailDto extends IncidentDto {
  rule: AlertRuleDto | null;
  notifications: NotificationDto[];
}

export interface AlertRuleDto {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  kind: RuleKind;
  metric: MetricName | null;
  hostId: string | null;
  resource: string | null;
  comparator: Comparator;
  warningThreshold: number | null;
  criticalThreshold: number | null;
  warningForSeconds: number;
  criticalForSeconds: number;
  windowSamples: number;
  cooldownSeconds: number;
  reminderIntervalSeconds: number | null;
  escalationAfterSeconds: number | null;
  escalationRecipients: string[];
  notifyWarning: boolean;
  notifyOnRecovery: boolean;
  suggestedAction: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface OverviewDto {
  status: "healthy" | "warning" | "critical";
  hosts: Record<HostHealth, number> & { total: number };
  incidents: { pending: number; firing: number; acknowledged: number };
  notifications: { queued: number; failedLast24h: number };
  worker: { lastSeenAt: string | null; healthy: boolean };
}

export interface CreatedHostDto {
  host: HostSummaryDto;
  agent: AgentDto;
  /** Shown exactly once; only a hash is stored server-side. */
  agentToken: string;
}
