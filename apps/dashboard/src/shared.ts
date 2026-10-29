/**
 * Browser-safe subset of @system-monitor/shared.
 *
 * `tsconfig.json` maps the bare specifier "@system-monitor/shared" to this file so that the
 * dashboard never pulls zod schemas or the Node logger into the bundle. Only the pure metric
 * helpers are imported as runtime values; everything else is type-only.
 */
export type * from "../../../packages/shared/src/api-types";
export type { MetricDefinition, MetricName, MetricUnit } from "../../../packages/shared/src/metrics";
export {
  formatBytes,
  formatDuration,
  formatMetricValue,
  METRICS,
} from "../../../packages/shared/src/metrics";
export type { Comparator, IncidentStatus, RuleKind, Severity } from "../../../packages/shared/src/rules";
