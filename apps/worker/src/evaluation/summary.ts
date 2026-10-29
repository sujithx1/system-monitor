import {
  formatDuration,
  formatMetricValue,
  isMetricName,
  METRICS,
  type MetricName,
} from "@system-monitor/shared";
import type { EvalResult, RuleThresholds } from "./evaluate";

const SYMBOL = { gt: ">", gte: "≥", lt: "<", lte: "≤" } as const;

export function serviceLabel(ruleName: string, resource: string): string {
  return resource ? `${ruleName} (${resource})` : ruleName;
}

/** Human-readable one-line description of a breach, used for incidents and messages. */
export function summarize(
  rule: RuleThresholds & { name: string; metric: string | null },
  resource: string,
  result: Extract<EvalResult, { state: "pending" | "firing" }>,
): string {
  if (rule.kind === "heartbeat") {
    return `No heartbeat from agent for ${formatDuration(result.value)} (${result.severity} after ${formatDuration(result.threshold)})`;
  }
  const metric: MetricName | null = rule.metric && isMetricName(rule.metric) ? rule.metric : null;
  const label = metric ? METRICS[metric].label : rule.name;
  const where = resource ? ` on ${resource}` : "";
  if (rule.kind === "check_failures") {
    const err = result.lastError ? ` – ${result.lastError}` : "";
    return result.severity === "critical"
      ? `${label}${where}: ${result.value} consecutive failed checks${err}`
      : `${label}${where}: ${result.value} failed checks in the last ${rule.windowSamples}${err}`;
  }
  const fmt = (v: number) => (metric ? formatMetricValue(metric, v) : String(v));
  const held = result.heldSeconds >= 60 ? ` for ${formatDuration(result.heldSeconds)}` : "";
  return `${label}${where} is ${fmt(result.value)} (${result.severity} ${SYMBOL[rule.comparator]} ${fmt(result.threshold)})${held}`;
}
