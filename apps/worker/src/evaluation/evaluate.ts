import type { Comparator, RuleKind, Severity } from "@system-monitor/shared";

/** One observation of a metric series; `value` is null when the agent could not measure it. */
export interface Point {
  t: Date;
  value: number | null;
  error?: string | null;
}

export interface RuleThresholds {
  kind: RuleKind;
  comparator: Comparator;
  warningThreshold: number | null;
  criticalThreshold: number | null;
  warningForSeconds: number;
  criticalForSeconds: number;
  windowSamples: number;
}

export type EvalResult =
  | { state: "nodata"; reason: string }
  | { state: "ok"; value: number | null }
  | {
      state: "pending" | "firing";
      severity: Severity;
      value: number;
      threshold: number;
      /** When the breach began (start of the continuous breaching run). */
      since: Date;
      /** Seconds the condition has held so far (threshold rules). */
      heldSeconds: number;
      lastError?: string | null;
    };

export interface EvalOptions {
  now: Date;
  /** Latest data older than this means "no data" – never "ok" and never "resolved". */
  staleAfterMs: number;
  /** A gap larger than this between samples breaks a sustained-condition window. */
  maxGapMs: number;
}

export function compare(value: number, comparator: Comparator, threshold: number): boolean {
  switch (comparator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
  }
}

/**
 * Start time of the run of consecutive breaching samples that ends at the newest sample,
 * or null when the newest sample does not breach. `points` must be sorted ascending and
 * contain only measured values.
 */
export function breachStart(
  points: Array<{ t: Date; value: number }>,
  breaches: (v: number) => boolean,
  maxGapMs: number,
) {
  let start: Date | null = null;
  let later: Date | null = null;
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (!p || !breaches(p.value)) break;
    if (later && later.getTime() - p.t.getTime() > maxGapMs) break;
    start = p.t;
    later = p.t;
  }
  return start;
}

type Level = { severity: Severity; threshold: number; forSeconds: number };

function levels(rule: RuleThresholds): Level[] {
  const out: Level[] = [];
  if (rule.criticalThreshold !== null) {
    out.push({
      severity: "critical",
      threshold: rule.criticalThreshold,
      forSeconds: rule.criticalForSeconds,
    });
  }
  if (rule.warningThreshold !== null) {
    out.push({ severity: "warning", threshold: rule.warningThreshold, forSeconds: rule.warningForSeconds });
  }
  return out;
}

/**
 * Threshold rules. A level fires only when every sample over its `forSeconds` window breaches,
 * so a single CPU spike can never fire a 3-minute rule. Unmeasured samples are skipped (they do
 * not reset or extend a breach), but a long gap breaks continuity.
 */
export function evaluateThreshold(points: Point[], rule: RuleThresholds, opts: EvalOptions): EvalResult {
  const measured = points
    .filter((p): p is { t: Date; value: number } => p.value !== null)
    .sort((a, b) => a.t.getTime() - b.t.getTime());
  const latest = measured.at(-1);
  if (!latest) return { state: "nodata", reason: "no measured samples in window" };
  if (opts.now.getTime() - latest.t.getTime() > opts.staleAfterMs)
    return { state: "nodata", reason: "latest sample is stale" };

  let pending: EvalResult | null = null;
  for (const level of levels(rule)) {
    const start = breachStart(measured, (v) => compare(v, rule.comparator, level.threshold), opts.maxGapMs);
    if (!start) continue;
    const heldSeconds = (latest.t.getTime() - start.getTime()) / 1000;
    const base = {
      severity: level.severity,
      value: latest.value,
      threshold: level.threshold,
      since: start,
      heldSeconds,
    };
    if (heldSeconds >= level.forSeconds) return { state: "firing", ...base };
    pending ??= { state: "pending", ...base };
  }
  return pending ?? { state: "ok", value: latest.value };
}

/**
 * Check rules over 0/1 metrics (pg.up, http.up). A check that could not be performed counts as a
 * failure. Fires only while the newest check is failing:
 *   critical – newest `criticalThreshold` checks all failed (consecutive),
 *   warning  – at least `warningThreshold` failures among the last `windowSamples` checks.
 */
export function evaluateCheckFailures(points: Point[], rule: RuleThresholds, opts: EvalOptions): EvalResult {
  const sorted = [...points].sort((a, b) => a.t.getTime() - b.t.getTime());
  const latest = sorted.at(-1);
  if (!latest) return { state: "nodata", reason: "no checks in window" };
  if (opts.now.getTime() - latest.t.getTime() > opts.staleAfterMs)
    return { state: "nodata", reason: "latest check is stale" };

  const failed = (p: Point) => p.value !== 1;
  if (!failed(latest)) return { state: "ok", value: 1 };

  const window = sorted.slice(-rule.windowSamples);
  let consecutive = 0;
  let runStart = latest.t;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    if (!p || !failed(p)) break;
    consecutive++;
    runStart = p.t;
  }
  const failures = window.filter(failed).length;
  const firstFailure = window.find(failed)?.t ?? latest.t;
  const lastError = latest.error ?? null;

  if (rule.criticalThreshold !== null && consecutive >= rule.criticalThreshold) {
    return {
      state: "firing",
      severity: "critical",
      value: consecutive,
      threshold: rule.criticalThreshold,
      since: runStart,
      heldSeconds: 0,
      lastError,
    };
  }
  if (rule.warningThreshold !== null && failures >= rule.warningThreshold) {
    return {
      state: "firing",
      severity: "warning",
      value: failures,
      threshold: rule.warningThreshold,
      since: firstFailure,
      heldSeconds: 0,
      lastError,
    };
  }
  const threshold = Math.min(
    rule.warningThreshold ?? Number.POSITIVE_INFINITY,
    rule.criticalThreshold ?? Number.POSITIVE_INFINITY,
  );
  return {
    state: "pending",
    severity: "warning",
    value: consecutive,
    threshold,
    since: runStart,
    heldSeconds: 0,
    lastError,
  };
}

/** Heartbeat rules use the server-side receive time, so agent clock skew cannot hide an outage. */
export function evaluateHeartbeat(lastHeartbeatAt: Date | null, rule: RuleThresholds, now: Date): EvalResult {
  if (!lastHeartbeatAt) return { state: "nodata", reason: "host has never reported" };
  const age = Math.max(0, (now.getTime() - lastHeartbeatAt.getTime()) / 1000);
  for (const level of levels(rule)) {
    if (age > level.threshold) {
      return {
        state: "firing",
        severity: level.severity,
        value: Math.round(age),
        threshold: level.threshold,
        since: lastHeartbeatAt,
        heldSeconds: age,
      };
    }
  }
  return { state: "ok", value: Math.round(age) };
}
