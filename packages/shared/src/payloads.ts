import { z } from "zod";
import { METRIC_NAMES, METRICS, type MetricName } from "./metrics";

export const MAX_METRICS_PER_SNAPSHOT = 1000;

/** Printable resource identifiers such as "/", "/var/lib/postgresql", "main", "api-health". */
const resourceSchema = z
  .string()
  .max(256)
  .regex(/^[\p{L}\p{N}\p{P}\p{S} ]*$/u, "resource contains control characters")
  .default("");

const agentVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z.+_-]+$/, "invalid agent version");

const hostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$/, "invalid hostname");

export const metricSampleSchema = z
  .object({
    name: z.enum(METRIC_NAMES),
    resource: resourceSchema,
    status: z.enum(["ok", "unavailable"]),
    value: z.number().finite().nullable(),
    error: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((sample, ctx) => {
    if (sample.status === "ok" && sample.value === null) {
      ctx.addIssue({ code: "custom", message: "value is required when status is ok", path: ["value"] });
    }
    if (sample.status === "unavailable" && sample.value !== null) {
      ctx.addIssue({ code: "custom", message: "value must be null when unavailable", path: ["value"] });
    }
    if (sample.value === null) return;
    const unit = METRICS[sample.name].unit;
    if (unit === "percent" && (sample.value < 0 || sample.value > 100)) {
      ctx.addIssue({ code: "custom", message: "percent must be within 0..100", path: ["value"] });
    }
    if (unit === "boolean" && sample.value !== 0 && sample.value !== 1) {
      ctx.addIssue({ code: "custom", message: "boolean metric must be 0 or 1", path: ["value"] });
    }
    if (unit !== "boolean" && unit !== "percent" && sample.value < 0) {
      ctx.addIssue({ code: "custom", message: "value must not be negative", path: ["value"] });
    }
  });

export type MetricSample = z.infer<typeof metricSampleSchema>;

export const metricSnapshotSchema = z
  .object({
    snapshotId: z.uuid(),
    agentVersion: agentVersionSchema,
    hostname: hostnameSchema,
    collectedAt: z.iso.datetime({ offset: true }),
    metrics: z.array(metricSampleSchema).min(1).max(MAX_METRICS_PER_SNAPSHOT),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const seen = new Set<string>();
    snapshot.metrics.forEach((m, i) => {
      const key = `${m.name}\u0000${m.resource}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", message: "duplicate metric/resource pair", path: ["metrics", i] });
      }
      seen.add(key);
    });
  });

export type MetricSnapshot = z.infer<typeof metricSnapshotSchema>;

export const heartbeatSchema = z
  .object({
    agentVersion: agentVersionSchema,
    hostname: hostnameSchema,
    sentAt: z.iso.datetime({ offset: true }),
    uptimeSeconds: z.number().finite().nonnegative().nullable().optional(),
  })
  .strict();

export type Heartbeat = z.infer<typeof heartbeatSchema>;

export function sample(name: MetricName, value: number, resource = ""): MetricSample {
  return { name, resource, status: "ok", value };
}

export function unavailable(name: MetricName, error: unknown, resource = ""): MetricSample {
  return { name, resource, status: "unavailable", value: null, error: describeError(error) };
}

export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\p{Cc}+/gu, " ").slice(0, 500);
}
