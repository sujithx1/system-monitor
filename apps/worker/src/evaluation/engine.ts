import {
  alertRules,
  type Database,
  incidents,
  metricSamples,
  monitoredHosts,
  notifications,
  type Transaction,
} from "@system-monitor/database";
import { ACTIVE_INCIDENT_STATUSES, type Logger } from "@system-monitor/shared";
import { and, asc, eq, gte, inArray, max, ne, or, sql } from "drizzle-orm";
import { buildIncidentPayload } from "../notifications/payload";
import { decide, type IncidentState, type NotifyIntent } from "./decide";
import {
  type EvalResult,
  evaluateCheckFailures,
  evaluateHeartbeat,
  evaluateThreshold,
  type Point,
} from "./evaluate";
import { serviceLabel, summarize } from "./summary";

type RuleRow = typeof alertRules.$inferSelect;
type HostRow = typeof monitoredHosts.$inferSelect;
type IncidentRow = typeof incidents.$inferSelect;

export interface EngineContext {
  db: Database;
  log: Logger;
  now: () => Date;
  /** Default WhatsApp recipients (E.164). Empty = notifications disabled. */
  recipients: string[];
  staleAfterSeconds: number;
  agentIntervalSeconds: number;
  maxAttempts: number;
  timeZone: string;
}

export interface CycleStats {
  rules: number;
  targets: number;
  created: number;
  updated: number;
  resolved: number;
  deleted: number;
  notificationsQueued: number;
  errors: number;
}

const digits = (phone: string) => phone.replace(/\D/g, "");

export async function runEvaluationCycle(ctx: EngineContext): Promise<CycleStats> {
  const now = ctx.now();
  const stats: CycleStats = {
    rules: 0,
    targets: 0,
    created: 0,
    updated: 0,
    resolved: 0,
    deleted: 0,
    notificationsQueued: 0,
    errors: 0,
  };
  const rules = await ctx.db.select().from(alertRules);
  const hosts = await ctx.db.select().from(monitoredHosts);
  await closeOutOfScopeIncidents(ctx, rules, hosts, now);

  const enabledHosts = hosts.filter((h) => h.enabled);
  for (const rule of rules.filter((r) => r.enabled)) {
    stats.rules++;
    try {
      const scope = rule.hostId ? enabledHosts.filter((h) => h.id === rule.hostId) : enabledHosts;
      if (scope.length === 0) continue;
      for (const target of await evaluateRule(ctx, rule, scope, now)) {
        stats.targets++;
        const outcome = await applyResult(ctx, rule, target.host, target.resource, target.result, now);
        if (outcome.op !== "none") stats[outcome.op]++;
        stats.notificationsQueued += outcome.queued;
      }
    } catch (error) {
      // One broken rule must not stop evaluation of the others.
      stats.errors++;
      ctx.log.error("rule evaluation failed", { ruleId: rule.id, rule: rule.name, error });
    }
  }
  return stats;
}

interface Target {
  host: HostRow;
  resource: string;
  result: EvalResult;
}

async function evaluateRule(
  ctx: EngineContext,
  rule: RuleRow,
  hosts: HostRow[],
  now: Date,
): Promise<Target[]> {
  const thresholds = {
    kind: rule.kind,
    comparator: rule.comparator,
    warningThreshold: rule.warningThreshold,
    criticalThreshold: rule.criticalThreshold,
    warningForSeconds: rule.warningForSeconds,
    criticalForSeconds: rule.criticalForSeconds,
    windowSamples: rule.windowSamples,
  };
  if (rule.kind === "heartbeat") {
    return hosts.map((host) => ({
      host,
      resource: "",
      result: evaluateHeartbeat(host.lastHeartbeatAt, thresholds, now),
    }));
  }
  if (!rule.metric) return [];

  const staleAfterMs = ctx.staleAfterSeconds * 1000;
  const maxGapMs = Math.max(ctx.agentIntervalSeconds * 2.5, 45) * 1000;
  const lookbackMs =
    rule.kind === "threshold"
      ? Math.max(rule.warningForSeconds, rule.criticalForSeconds) * 1000 + staleAfterMs + maxGapMs
      : rule.windowSamples * ctx.agentIntervalSeconds * 2000 + staleAfterMs;

  const conditions = [
    eq(metricSamples.metric, rule.metric),
    inArray(
      metricSamples.hostId,
      hosts.map((h) => h.id),
    ),
    gte(metricSamples.collectedAt, new Date(now.getTime() - lookbackMs)),
  ];
  if (rule.resource !== null) conditions.push(eq(metricSamples.resource, rule.resource));
  const rows = await ctx.db
    .select({
      hostId: metricSamples.hostId,
      resource: metricSamples.resource,
      value: metricSamples.value,
      error: metricSamples.error,
      t: metricSamples.collectedAt,
    })
    .from(metricSamples)
    .where(and(...conditions))
    .orderBy(asc(metricSamples.collectedAt))
    .limit(200_000);

  const series = new Map<string, { host: HostRow; resource: string; points: Point[] }>();
  const byId = new Map(hosts.map((h) => [h.id, h]));
  for (const r of rows) {
    const host = byId.get(r.hostId);
    if (!host) continue;
    const key = `${r.hostId}\u0000${r.resource}`;
    let s = series.get(key);
    if (!s) {
      s = { host, resource: r.resource, points: [] };
      series.set(key, s);
    }
    s.points.push({ t: r.t, value: r.value, error: r.error });
  }

  const opts = { now, staleAfterMs, maxGapMs };
  return [...series.values()].map((s) => ({
    host: s.host,
    resource: s.resource,
    result:
      rule.kind === "threshold"
        ? evaluateThreshold(s.points, thresholds, opts)
        : evaluateCheckFailures(s.points, thresholds, opts),
  }));
}

function toState(i: IncidentRow): IncidentState {
  return {
    id: i.id,
    status: i.status,
    severity: i.severity,
    startedAt: i.startedAt,
    firedAt: i.firedAt,
    lastNotifiedAt: i.lastNotifiedAt,
    notificationCount: i.notificationCount,
    reminderCount: i.reminderCount,
    escalatedAt: i.escalatedAt,
  };
}

/**
 * Applies one evaluation result inside a transaction. The active incident row is locked
 * (SELECT … FOR UPDATE) and creation relies on the partial unique index, so concurrent
 * workers evaluating the same rule cannot create duplicates or double-notify.
 */
export async function applyResult(
  ctx: EngineContext,
  rule: RuleRow,
  host: HostRow,
  resource: string,
  result: EvalResult,
  now: Date,
): Promise<{ op: "none" | "created" | "updated" | "resolved" | "deleted"; queued: number }> {
  if (result.state === "nodata") return { op: "none", queued: 0 };

  return ctx.db.transaction(async (tx) => {
    const [incident] = await tx
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.ruleId, rule.id),
          eq(incidents.hostId, host.id),
          eq(incidents.resource, resource),
          inArray(incidents.status, [...ACTIVE_INCIDENT_STATUSES]),
        ),
      )
      .for("update");
    if (!incident && result.state === "ok") return { op: "none" as const, queued: 0 };

    const fingerprint = `${rule.id}:${host.id}:${resource}`;
    let lastNotifiedForFingerprint: Date | null = null;
    if (result.state === "firing" && (!incident || incident.status === "pending")) {
      const [row] = await tx
        .select({ t: max(incidents.lastNotifiedAt) })
        .from(incidents)
        .where(
          and(eq(incidents.fingerprint, fingerprint), incident ? ne(incidents.id, incident.id) : undefined),
        );
      lastNotifiedForFingerprint = row?.t ?? null;
    }

    const decision = decide(incident ? toState(incident) : null, result, {
      now,
      lastNotifiedForFingerprint,
      canNotify: ctx.recipients.length > 0,
      policy: {
        notifyWarning: rule.notifyWarning,
        notifyOnRecovery: rule.notifyOnRecovery,
        cooldownSeconds: rule.cooldownSeconds,
        reminderIntervalSeconds: rule.reminderIntervalSeconds,
        escalationAfterSeconds: rule.escalationAfterSeconds,
        hasEscalationRecipients: rule.escalationRecipients.length > 0,
      },
    });
    const breach = result.state === "pending" || result.state === "firing" ? result : null;
    const observed = breach
      ? { value: breach.value, summary: summarize(rule, resource, breach), lastEvaluatedAt: now }
      : { lastEvaluatedAt: now };

    switch (decision.op) {
      case "none": {
        if (incident && breach) {
          const threshold = breach.severity === incident.severity ? breach.threshold : incident.threshold;
          await tx
            .update(incidents)
            .set({ ...observed, threshold })
            .where(eq(incidents.id, incident.id));
        }
        return { op: "none" as const, queued: 0 };
      }
      case "delete": {
        if (incident) await tx.delete(incidents).where(eq(incidents.id, incident.id));
        return { op: "deleted" as const, queued: 0 };
      }
      case "create": {
        if (!breach) return { op: "none" as const, queued: 0 };
        const [created] = await tx
          .insert(incidents)
          .values({
            ruleId: rule.id,
            hostId: host.id,
            resource,
            fingerprint,
            status: decision.status,
            severity: decision.severity,
            summary: observed.summary ?? rule.name,
            value: breach.value,
            threshold: breach.threshold,
            startedAt: decision.startedAt,
            firedAt: decision.firedAt,
            lastEvaluatedAt: now,
            metadata: decision.cooldownSuppressed ? { cooldownSuppressed: true } : {},
          })
          .onConflictDoNothing()
          .returning();
        if (!created) return { op: "none" as const, queued: 0 }; // another worker created it first
        const queued = await enqueue(tx, ctx, rule, host, created, decision.notify, now);
        return { op: "created" as const, queued };
      }
      case "update": {
        if (!incident) return { op: "none" as const, queued: 0 };
        const [updated] = await tx
          .update(incidents)
          .set({
            ...decision.patch,
            ...observed,
            ...(breach && (decision.patch.severity ?? incident.severity) === breach.severity
              ? { threshold: breach.threshold }
              : {}),
            ...(decision.cooldownSuppressed
              ? { metadata: sql`${incidents.metadata} || '{"cooldownSuppressed": true}'::jsonb` }
              : {}),
          })
          .where(eq(incidents.id, incident.id))
          .returning();
        if (!updated) return { op: "none" as const, queued: 0 };
        const queued = await enqueue(tx, ctx, rule, host, updated, decision.notify, now);
        return { op: "updated" as const, queued };
      }
      case "resolve": {
        if (!incident) return { op: "none" as const, queued: 0 };
        const recovered = result.state === "ok" ? result.value : null;
        const [resolved] = await tx
          .update(incidents)
          .set({
            status: "resolved",
            resolvedAt: now,
            lastEvaluatedAt: now,
            metadata: sql`${incidents.metadata} || ${JSON.stringify({ recoveredValue: recovered })}::jsonb`,
          })
          .where(eq(incidents.id, incident.id))
          .returning();
        if (!resolved) return { op: "none" as const, queued: 0 };
        const queued = await enqueue(tx, ctx, rule, host, resolved, decision.notify, now);
        return { op: "resolved" as const, queued };
      }
    }
  });
}

/** Inserts outbox rows (one per recipient). Unique dedupe keys make this idempotent. */
async function enqueue(
  tx: Transaction,
  ctx: EngineContext,
  rule: RuleRow,
  host: HostRow,
  incident: IncidentRow,
  intents: NotifyIntent[],
  now: Date,
): Promise<number> {
  if (intents.length === 0) return 0;
  const rows = intents.flatMap((intent) => {
    const recipients = intent.audience === "escalation" ? rule.escalationRecipients : ctx.recipients;
    return recipients.map((recipient) => ({
      incidentId: incident.id,
      kind: intent.kind,
      recipient,
      dedupeKey: `incident:${incident.id}:${intent.key}:${digits(recipient)}`,
      maxAttempts: ctx.maxAttempts,
      payload: buildIncidentPayload({
        kind: intent.kind,
        severity: incident.severity,
        hostLabel: host.displayName ?? host.name,
        service: serviceLabel(rule.name, incident.resource),
        incidentId: incident.id,
        detectedAt: incident.firedAt ?? incident.startedAt,
        summary: incident.summary,
        suggestedAction: rule.suggestedAction,
        now,
        timeZone: ctx.timeZone,
      }),
    }));
  });
  if (rows.length === 0) return 0;
  const inserted = await tx
    .insert(notifications)
    .values(rows)
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id });
  if (inserted.length > 0) {
    await tx
      .update(incidents)
      .set({
        lastNotifiedAt: now,
        notificationCount: sql`${incidents.notificationCount} + ${inserted.length}`,
      })
      .where(eq(incidents.id, incident.id));
  }
  return inserted.length;
}

/** Disabled rules/hosts no longer evaluate, so their open incidents are closed (without paging). */
async function closeOutOfScopeIncidents(ctx: EngineContext, rules: RuleRow[], hosts: HostRow[], now: Date) {
  const disabledRules = rules.filter((r) => !r.enabled).map((r) => r.id);
  const disabledHosts = hosts.filter((h) => !h.enabled).map((h) => h.id);
  if (disabledRules.length === 0 && disabledHosts.length === 0) return;
  const scope = or(
    disabledRules.length > 0 ? inArray(incidents.ruleId, disabledRules) : undefined,
    disabledHosts.length > 0 ? inArray(incidents.hostId, disabledHosts) : undefined,
  );
  await ctx.db.transaction(async (tx) => {
    await tx.delete(incidents).where(and(eq(incidents.status, "pending"), scope));
    await tx
      .update(incidents)
      .set({
        status: "resolved",
        resolvedAt: now,
        metadata: sql`${incidents.metadata} || '{"resolvedReason": "rule or host disabled"}'::jsonb`,
      })
      .where(and(inArray(incidents.status, ["firing", "acknowledged"]), scope));
  });
}
