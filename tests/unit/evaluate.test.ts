import { describe, expect, test } from "bun:test";
import {
  evaluateCheckFailures,
  evaluateHeartbeat,
  evaluateThreshold,
  type Point,
  type RuleThresholds,
} from "../../apps/worker/src/evaluation/evaluate";

const NOW = new Date("2026-10-28T12:00:00Z");
const opts = { now: NOW, staleAfterMs: 120_000, maxGapMs: 75_000 };
/** Samples every 30 s ending at `now`, oldest first. */
const series = (values: Array<number | null>, interval = 30): Point[] =>
  values.map((value, i) => ({
    t: new Date(NOW.getTime() - (values.length - 1 - i) * interval * 1000),
    value,
  }));

const cpu: RuleThresholds = {
  kind: "threshold",
  comparator: "gt",
  warningThreshold: 85,
  criticalThreshold: 95,
  warningForSeconds: 300,
  criticalForSeconds: 180,
  windowSamples: 10,
};

describe("sustained threshold windows", () => {
  test("a single CPU spike does not fire", () => {
    const r = evaluateThreshold(series([20, 20, 20, 20, 99]), cpu, opts);
    expect(r).toMatchObject({ state: "pending", severity: "critical", heldSeconds: 0 });
  });

  test("critical fires only after 3 minutes above 95%", () => {
    // 6 samples spanning 150 s – not yet held for 180 s.
    expect(evaluateThreshold(series([50, 96, 97, 98, 96, 97, 99]), cpu, opts)).toMatchObject({
      state: "pending",
      severity: "critical",
    });
    // 7 samples spanning 180 s.
    const r = evaluateThreshold(series([50, 96, 97, 98, 96, 97, 99, 97]), cpu, opts);
    expect(r).toMatchObject({
      state: "firing",
      severity: "critical",
      value: 97,
      threshold: 95,
      heldSeconds: 180,
    });
  });

  test("a dip below the threshold restarts the window", () => {
    const r = evaluateThreshold(series([96, 97, 98, 96, 90, 97, 99, 97]), cpu, opts);
    expect(r).toMatchObject({ state: "pending", severity: "critical", heldSeconds: 60 }); // 3 samples after the dip
  });

  test("warning fires after 5 minutes between 85 and 95", () => {
    const r = evaluateThreshold(series(Array(11).fill(90)), cpu, opts);
    expect(r).toMatchObject({ state: "firing", severity: "warning", heldSeconds: 300 });
  });

  test("critical breach not yet held still fires warning if warning duration is met", () => {
    const r = evaluateThreshold(series([...Array(10).fill(90), 99]), cpu, opts);
    expect(r).toMatchObject({ state: "firing", severity: "warning" });
  });

  test("a gap in data breaks continuity", () => {
    const points: Point[] = [
      { t: new Date(NOW.getTime() - 400_000), value: 99 },
      { t: new Date(NOW.getTime() - 370_000), value: 99 },
      // 4-minute gap (agent was down)
      { t: new Date(NOW.getTime() - 30_000), value: 99 },
      { t: NOW, value: 99 },
    ];
    expect(evaluateThreshold(points, cpu, opts)).toMatchObject({ state: "pending", heldSeconds: 30 });
  });

  test("unavailable samples are skipped, not treated as 0 or as a breach", () => {
    const r = evaluateThreshold(series([96, 97, null, 98, 96, null, 99, 97]), cpu, opts);
    expect(r).toMatchObject({ state: "firing", severity: "critical" });
  });

  test("stale data is nodata (never ok, so incidents are not resolved by silence)", () => {
    const old = series([10, 10]).map((p) => ({ ...p, t: new Date(p.t.getTime() - 600_000) }));
    expect(evaluateThreshold(old, cpu, opts).state).toBe("nodata");
    expect(evaluateThreshold([], cpu, opts).state).toBe("nodata");
    expect(evaluateThreshold(series([null, null]), cpu, opts).state).toBe("nodata");
  });

  test("instant rules (disk) fire on the latest sample", () => {
    const disk = { ...cpu, warningForSeconds: 0, criticalForSeconds: 0 };
    expect(evaluateThreshold(series([80, 96]), disk, opts)).toMatchObject({
      state: "firing",
      severity: "critical",
      value: 96,
    });
    expect(evaluateThreshold(series([96, 86]), disk, opts)).toMatchObject({
      state: "firing",
      severity: "warning",
    });
    expect(evaluateThreshold(series([96, 85]), disk, opts)).toEqual({ state: "ok", value: 85 });
  });

  test("lt comparator (e.g. low free space)", () => {
    const low = {
      ...cpu,
      comparator: "lt" as const,
      warningThreshold: 20,
      criticalThreshold: 5,
      warningForSeconds: 0,
      criticalForSeconds: 0,
    };
    expect(evaluateThreshold(series([3]), low, opts)).toMatchObject({
      state: "firing",
      severity: "critical",
    });
  });
});

describe("check failures", () => {
  const pg: RuleThresholds = {
    ...cpu,
    kind: "check_failures",
    warningThreshold: 2,
    criticalThreshold: 2,
    windowSamples: 10,
  };
  const api: RuleThresholds = { ...pg, criticalThreshold: 3 };

  test("PostgreSQL: two consecutive failures is critical", () => {
    expect(evaluateCheckFailures(series([1, 1, 0]), pg, opts)).toMatchObject({ state: "pending", value: 1 });
    expect(evaluateCheckFailures(series([1, 0, 0]), pg, opts)).toMatchObject({
      state: "firing",
      severity: "critical",
      value: 2,
    });
  });

  test("API: three consecutive failures is critical, repeated failures warning", () => {
    expect(evaluateCheckFailures(series([1, 0, 0]), api, opts)).toMatchObject({
      state: "firing",
      severity: "warning",
    });
    expect(evaluateCheckFailures(series([0, 0, 0]), api, opts)).toMatchObject({
      state: "firing",
      severity: "critical",
      value: 3,
    });
    expect(evaluateCheckFailures(series([0, 1, 1, 0]), api, opts)).toMatchObject({
      state: "firing",
      severity: "warning",
      value: 2,
    });
  });

  test("an unperformed check counts as a failure", () => {
    expect(evaluateCheckFailures(series([1, null, null]), pg, opts)).toMatchObject({
      state: "firing",
      severity: "critical",
    });
  });

  test("a successful latest check is ok and recovers", () => {
    expect(evaluateCheckFailures(series([0, 0, 0, 1]), api, opts)).toEqual({ state: "ok", value: 1 });
  });

  test("failures outside the window are forgotten", () => {
    const values = [0, ...Array(10).fill(1), 0];
    expect(evaluateCheckFailures(series(values), api, opts)).toMatchObject({ state: "pending" });
  });

  test("carries the last error for the incident summary", () => {
    const points = series([0, 0]).map((p) => ({ ...p, error: "connection refused" }));
    expect(evaluateCheckFailures(points, pg, opts)).toMatchObject({ lastError: "connection refused" });
  });
});

describe("heartbeat timeout", () => {
  const hb: RuleThresholds = { ...cpu, kind: "heartbeat", warningThreshold: 90, criticalThreshold: 180 };
  const ago = (s: number) => new Date(NOW.getTime() - s * 1000);

  test.each([
    [30, "ok", undefined],
    [90, "ok", undefined],
    [91, "firing", "warning"],
    [180, "firing", "warning"],
    [181, "firing", "critical"],
  ])("%is since last heartbeat → %s %s", (seconds, state, severity) => {
    const r = evaluateHeartbeat(ago(seconds), hb, NOW);
    expect(r.state).toBe(state as "ok" | "firing");
    if (severity) expect(r).toMatchObject({ severity });
  });

  test("never-seen hosts are nodata", () => {
    expect(evaluateHeartbeat(null, hb, NOW).state).toBe("nodata");
  });
});
