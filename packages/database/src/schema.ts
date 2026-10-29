import {
  COMPARATORS,
  INCIDENT_STATUSES,
  NOTIFICATION_KINDS,
  NOTIFICATION_STATUSES,
  RULE_KINDS,
  SEVERITIES,
  USER_ROLES,
} from "@system-monitor/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => tstz("created_at").notNull().defaultNow();
const updatedAt = () =>
  tstz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const userRole = pgEnum("user_role", USER_ROLES);
export const severity = pgEnum("severity", SEVERITIES);
export const incidentStatus = pgEnum("incident_status", INCIDENT_STATUSES);
export const ruleKind = pgEnum("rule_kind", RULE_KINDS);
export const comparator = pgEnum("comparator", COMPARATORS);
export const sampleStatus = pgEnum("sample_status", ["ok", "unavailable"]);
export const notificationKind = pgEnum("notification_kind", NOTIFICATION_KINDS);
export const notificationStatus = pgEnum("notification_status", NOTIFICATION_STATUSES);
export const actorType = pgEnum("actor_type", ["user", "agent", "system"]);

// ------------------------------------------------------------------ users & sessions

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull().default("viewer"),
    disabled: boolean("disabled").notNull().default(false),
    lastLoginAt: tstz("last_login_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
    check("users_email_lowercase_ck", sql`${t.email} = lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the opaque session token; the token itself is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastSeenAt: tstz("last_seen_at").notNull().defaultNow(),
    expiresAt: tstz("expires_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

// ------------------------------------------------------------------ hosts & agents

export const monitoredHosts = pgTable(
  "monitored_hosts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    displayName: text("display_name"),
    description: text("description"),
    environment: text("environment"),
    enabled: boolean("enabled").notNull().default(true),
    /** Server receive time of the most recent heartbeat or metrics push (server clock). */
    lastHeartbeatAt: tstz("last_heartbeat_at"),
    lastMetricsAt: tstz("last_metrics_at"),
    lastAgentVersion: text("last_agent_version"),
    lastHostname: text("last_hostname"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("monitored_hosts_name_ck", sql`${t.name} ~ '^[a-z0-9][a-z0-9._-]{0,62}$'`)],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostId: uuid("host_id")
      .notNull()
      .references(() => monitoredHosts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** SHA-256 of the agent token (tokens carry 256 bits of entropy, so a fast hash is adequate). */
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    version: text("version"),
    lastSeenAt: tstz("last_seen_at"),
    lastIp: text("last_ip"),
    revokedAt: tstz("revoked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("agents_host_name_uq").on(t.hostId, t.name), index("agents_host_idx").on(t.hostId)],
);

// ------------------------------------------------------------------ metrics

/** One row per agent push; the unique key makes re-sent snapshots idempotent. */
export const metricSnapshots = pgTable(
  "metric_snapshots",
  {
    id: uuid("id").primaryKey(),
    hostId: uuid("host_id")
      .notNull()
      .references(() => monitoredHosts.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    snapshotKey: uuid("snapshot_key").notNull(),
    agentVersion: text("agent_version").notNull(),
    collectedAt: tstz("collected_at").notNull(),
    receivedAt: tstz("received_at").notNull().defaultNow(),
    sampleCount: integer("sample_count").notNull(),
  },
  (t) => [
    uniqueIndex("metric_snapshots_agent_key_uq").on(t.agentId, t.snapshotKey),
    index("metric_snapshots_host_time_idx").on(t.hostId, t.collectedAt),
    index("metric_snapshots_collected_idx").on(t.collectedAt),
  ],
);

export const metricSamples = pgTable(
  "metric_samples",
  {
    /** UUIDv7 generated by the API: time-ordered, so inserts stay index-friendly. */
    id: uuid("id").primaryKey(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => metricSnapshots.id, { onDelete: "cascade" }),
    hostId: uuid("host_id")
      .notNull()
      .references(() => monitoredHosts.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    resource: text("resource").notNull().default(""),
    status: sampleStatus("status").notNull(),
    value: doublePrecision("value"),
    error: text("error"),
    collectedAt: tstz("collected_at").notNull(),
  },
  (t) => [
    index("metric_samples_series_idx").on(t.hostId, t.metric, t.resource, t.collectedAt.desc()),
    index("metric_samples_collected_idx").on(t.collectedAt),
    index("metric_samples_snapshot_idx").on(t.snapshotId),
    check(
      "metric_samples_value_status_ck",
      sql`(${t.status} = 'ok' AND ${t.value} IS NOT NULL) OR (${t.status} = 'unavailable' AND ${t.value} IS NULL)`,
    ),
  ],
);

// ------------------------------------------------------------------ alerting

export const alertRules = pgTable(
  "alert_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    kind: ruleKind("kind").notNull(),
    metric: text("metric"),
    /** null = applies to every enabled host. */
    hostId: uuid("host_id").references(() => monitoredHosts.id, { onDelete: "cascade" }),
    /** null = every resource (mount, check, database) reported for the metric. */
    resource: text("resource"),
    comparator: comparator("comparator").notNull().default("gt"),
    warningThreshold: doublePrecision("warning_threshold"),
    criticalThreshold: doublePrecision("critical_threshold"),
    warningForSeconds: integer("warning_for_seconds").notNull().default(0),
    criticalForSeconds: integer("critical_for_seconds").notNull().default(0),
    windowSamples: integer("window_samples").notNull().default(10),
    cooldownSeconds: integer("cooldown_seconds").notNull().default(300),
    reminderIntervalSeconds: integer("reminder_interval_seconds").default(1800),
    escalationAfterSeconds: integer("escalation_after_seconds"),
    escalationRecipients: text("escalation_recipients").array().notNull().default(sql`'{}'::text[]`),
    notifyWarning: boolean("notify_warning").notNull().default(true),
    notifyOnRecovery: boolean("notify_on_recovery").notNull().default(true),
    suggestedAction: text("suggested_action"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "alert_rules_threshold_ck",
      sql`${t.warningThreshold} IS NOT NULL OR ${t.criticalThreshold} IS NOT NULL`,
    ),
    check(
      "alert_rules_durations_ck",
      sql`${t.warningForSeconds} >= 0 AND ${t.criticalForSeconds} >= 0 AND ${t.cooldownSeconds} >= 0 AND ${t.windowSamples} >= 1`,
    ),
  ],
);

export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => alertRules.id, { onDelete: "restrict" }),
    hostId: uuid("host_id")
      .notNull()
      .references(() => monitoredHosts.id, { onDelete: "cascade" }),
    resource: text("resource").notNull().default(""),
    /** rule:host:resource – groups incidents of the same condition across time (cooldowns). */
    fingerprint: text("fingerprint").notNull(),
    status: incidentStatus("status").notNull(),
    severity: severity("severity").notNull(),
    summary: text("summary").notNull(),
    value: doublePrecision("value"),
    threshold: doublePrecision("threshold"),
    startedAt: tstz("started_at").notNull(),
    firedAt: tstz("fired_at"),
    acknowledgedAt: tstz("acknowledged_at"),
    acknowledgedBy: uuid("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: tstz("resolved_at"),
    lastEvaluatedAt: tstz("last_evaluated_at").notNull().defaultNow(),
    lastNotifiedAt: tstz("last_notified_at"),
    notificationCount: integer("notification_count").notNull().default(0),
    reminderCount: integer("reminder_count").notNull().default(0),
    escalatedAt: tstz("escalated_at"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most one open incident per rule/host/resource – enforced by the database, not just code.
    uniqueIndex("incidents_one_active_uq")
      .on(t.ruleId, t.hostId, t.resource)
      .where(sql`${t.status} IN ('pending', 'firing', 'acknowledged')`),
    index("incidents_status_started_idx").on(t.status, t.startedAt.desc()),
    index("incidents_host_started_idx").on(t.hostId, t.startedAt.desc()),
    index("incidents_started_idx").on(t.startedAt.desc(), t.id.desc()),
    index("incidents_fingerprint_idx").on(t.fingerprint, t.lastNotifiedAt),
    check("incidents_resolved_ck", sql`(${t.status} = 'resolved') = (${t.resolvedAt} IS NOT NULL)`),
  ],
);

/** Durable outbox: one row per message per recipient. */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id").references(() => incidents.id, { onDelete: "cascade" }),
    kind: notificationKind("kind").notNull(),
    recipient: text("recipient").notNull(),
    /** Prevents the same logical notification from being enqueued twice (restarts, races). */
    dedupeKey: text("dedupe_key").notNull().unique(),
    status: notificationStatus("status").notNull().default("queued"),
    /** Template parameters (no secrets). */
    payload: jsonb("payload").$type<NotificationPayload>().notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    nextAttemptAt: tstz("next_attempt_at").notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedUntil: tstz("locked_until"),
    providerMessageId: text("provider_message_id").unique(),
    lastError: text("last_error"),
    acceptedAt: tstz("accepted_at"),
    sentAt: tstz("sent_at"),
    deliveredAt: tstz("delivered_at"),
    readAt: tstz("read_at"),
    failedAt: tstz("failed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("notifications_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} IN ('queued', 'retrying', 'sending')`),
    index("notifications_incident_idx").on(t.incidentId),
    index("notifications_created_idx").on(t.createdAt.desc(), t.id.desc()),
  ],
);

export interface NotificationPayload {
  severityLabel: string;
  host: string;
  service: string;
  incidentId: string;
  detectedAt: string;
  details: string;
  suggestedAction: string;
}

export const notificationAttempts = pgTable(
  "notification_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    workerId: text("worker_id").notNull(),
    startedAt: tstz("started_at").notNull(),
    finishedAt: tstz("finished_at"),
    durationMs: integer("duration_ms"),
    httpStatus: integer("http_status"),
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    providerMessageId: text("provider_message_id"),
  },
  (t) => [uniqueIndex("notification_attempts_uq").on(t.notificationId, t.attemptNumber)],
);

// ------------------------------------------------------------------ operations

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorType: actorType("actor_type").notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_created_idx").on(t.createdAt.desc()),
    index("audit_logs_target_idx").on(t.targetType, t.targetId),
  ],
);

/** Liveness of background processes (worker loops), visible to the API and dashboard. */
export const serviceHeartbeats = pgTable(
  "service_heartbeats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    service: text("service").notNull(),
    instanceId: text("instance_id").notNull(),
    version: text("version"),
    startedAt: tstz("started_at").notNull(),
    lastSeenAt: tstz("last_seen_at").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [uniqueIndex("service_heartbeats_uq").on(t.service, t.instanceId)],
);
