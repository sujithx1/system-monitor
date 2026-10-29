import { z } from "zod";
import { isBooleanMetric, METRIC_NAMES } from "./metrics";

export const SEVERITIES = ["warning", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const INCIDENT_STATUSES = ["pending", "firing", "acknowledged", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const ACTIVE_INCIDENT_STATUSES = ["pending", "firing", "acknowledged"] as const;

/**
 * threshold       – compare the metric value with warning/critical thresholds; each level must hold
 *                   continuously for its `*ForSeconds` duration before the incident fires.
 * check_failures  – for 0/1 check metrics (pg.up, http.up, …): critical after `criticalThreshold`
 *                   consecutive failed checks, warning after `warningThreshold` failures within the
 *                   last `windowSamples` checks ("repeated failures").
 * heartbeat       – seconds since the host's last heartbeat as observed by the monitoring server.
 */
export const RULE_KINDS = ["threshold", "check_failures", "heartbeat"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const COMPARATORS = ["gt", "gte", "lt", "lte"] as const;
export type Comparator = (typeof COMPARATORS)[number];

const e164 = z.string().regex(/^\+?[1-9]\d{6,14}$/, "recipient must be an E.164 phone number");

const seconds = z
  .number()
  .int()
  .min(0)
  .max(7 * 24 * 3600);

const ruleFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable(),
  enabled: z.boolean(),
  kind: z.enum(RULE_KINDS),
  metric: z.enum(METRIC_NAMES).nullable(),
  hostId: z.uuid().nullable(),
  resource: z.string().max(256).nullable(),
  comparator: z.enum(COMPARATORS),
  warningThreshold: z.number().finite().nullable(),
  criticalThreshold: z.number().finite().nullable(),
  warningForSeconds: seconds,
  criticalForSeconds: seconds,
  windowSamples: z.number().int().min(1).max(100),
  cooldownSeconds: seconds,
  reminderIntervalSeconds: z
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 3600)
    .nullable(),
  escalationAfterSeconds: z
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 3600)
    .nullable(),
  escalationRecipients: z.array(e164).max(10),
  notifyWarning: z.boolean(),
  notifyOnRecovery: z.boolean(),
  suggestedAction: z.string().trim().max(300).nullable(),
};

type RuleShape = {
  kind: RuleKind;
  metric: (typeof METRIC_NAMES)[number] | null;
  warningThreshold: number | null;
  criticalThreshold: number | null;
  windowSamples: number;
};

export function validateRuleSemantics(rule: RuleShape, ctx: z.RefinementCtx): void {
  if (rule.warningThreshold === null && rule.criticalThreshold === null) {
    ctx.addIssue({
      code: "custom",
      message: "at least one threshold is required",
      path: ["criticalThreshold"],
    });
  }
  if (rule.kind === "heartbeat") {
    if (rule.metric !== null) {
      ctx.addIssue({ code: "custom", message: "heartbeat rules must not set a metric", path: ["metric"] });
    }
  } else if (rule.metric === null) {
    ctx.addIssue({ code: "custom", message: "metric is required", path: ["metric"] });
  }
  if (rule.kind === "check_failures") {
    if (rule.metric !== null && !isBooleanMetric(rule.metric)) {
      ctx.addIssue({
        code: "custom",
        message: "check_failures rules require a 0/1 check metric such as pg.up or http.up",
        path: ["metric"],
      });
    }
    for (const key of ["warningThreshold", "criticalThreshold"] as const) {
      const v = rule[key];
      if (v !== null && (!Number.isInteger(v) || v < 1 || v > 100)) {
        ctx.addIssue({ code: "custom", message: "failure counts must be integers 1..100", path: [key] });
      }
    }
    if (rule.warningThreshold !== null && rule.warningThreshold > rule.windowSamples) {
      ctx.addIssue({
        code: "custom",
        message: "warningThreshold cannot exceed windowSamples",
        path: ["warningThreshold"],
      });
    }
  }
  if (rule.kind === "heartbeat") {
    for (const key of ["warningThreshold", "criticalThreshold"] as const) {
      const v = rule[key];
      if (v !== null && v < 30) {
        ctx.addIssue({ code: "custom", message: "heartbeat thresholds must be >= 30 seconds", path: [key] });
      }
    }
  }
}

export const createRuleSchema = z
  .object({
    ...ruleFields,
    description: ruleFields.description.default(null),
    enabled: ruleFields.enabled.default(true),
    hostId: ruleFields.hostId.default(null),
    resource: ruleFields.resource.default(null),
    comparator: ruleFields.comparator.default("gt"),
    warningThreshold: ruleFields.warningThreshold.default(null),
    criticalThreshold: ruleFields.criticalThreshold.default(null),
    warningForSeconds: ruleFields.warningForSeconds.default(0),
    criticalForSeconds: ruleFields.criticalForSeconds.default(0),
    windowSamples: ruleFields.windowSamples.default(10),
    cooldownSeconds: ruleFields.cooldownSeconds.default(300),
    reminderIntervalSeconds: ruleFields.reminderIntervalSeconds.default(1800),
    escalationAfterSeconds: ruleFields.escalationAfterSeconds.default(null),
    escalationRecipients: ruleFields.escalationRecipients.default([]),
    notifyWarning: ruleFields.notifyWarning.default(true),
    notifyOnRecovery: ruleFields.notifyOnRecovery.default(true),
    suggestedAction: ruleFields.suggestedAction.default(null),
    metric: ruleFields.metric.default(null),
  })
  .strict()
  .superRefine(validateRuleSemantics);

export type CreateRuleInput = z.infer<typeof createRuleSchema>;

/** PATCH body; the merged result is re-validated with `validateRuleSemantics` server-side. */
export const updateRuleSchema = z
  .object(ruleFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "at least one field is required");

export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

export const ruleSemanticsSchema = z
  .object({
    kind: ruleFields.kind,
    metric: ruleFields.metric,
    warningThreshold: ruleFields.warningThreshold,
    criticalThreshold: ruleFields.criticalThreshold,
    windowSamples: ruleFields.windowSamples,
  })
  .superRefine(validateRuleSemantics);
