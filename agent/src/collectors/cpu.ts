import { type MetricSample, sample, unavailable } from "../shared";

/** Aggregate jiffies from the first `cpu` line of /proc/stat. */
export interface CpuTimes {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
}

export function parseProcStat(content: string): CpuTimes {
  const line = content.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) throw new Error("aggregate cpu line not found in /proc/stat");
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error("malformed cpu line in /proc/stat");
  }
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
  // guest/guest_nice (fields 9-10) are already included in user/nice, so they are not added again.
  return { user, nice, system, idle, iowait, irq, softirq, steal };
}

export interface CpuUsage {
  usagePercent: number;
  iowaitPercent: number;
  stealPercent: number;
}

/**
 * Utilisation between two samples: busy = total - (idle + iowait).
 * Returns null when counters did not advance or went backwards (reboot, counter reset).
 */
export function computeCpuUsage(prev: CpuTimes, curr: CpuTimes): CpuUsage | null {
  const total = (t: CpuTimes) => t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq + t.steal;
  const dTotal = total(curr) - total(prev);
  const dIdle = curr.idle + curr.iowait - (prev.idle + prev.iowait);
  const dIowait = curr.iowait - prev.iowait;
  const dSteal = curr.steal - prev.steal;
  if (dTotal <= 0 || dIdle < 0 || dIowait < 0 || dSteal < 0 || dIdle > dTotal) return null;
  const pct = (n: number) => Math.min(100, Math.max(0, (n / dTotal) * 100));
  return { usagePercent: pct(dTotal - dIdle), iowaitPercent: pct(dIowait), stealPercent: pct(dSteal) };
}

/**
 * Keeps the previous counter sample between collection cycles, so measuring CPU never blocks:
 * utilisation is the average over the whole interval since the last cycle.
 */
export class CpuCollector {
  private previous: CpuTimes | null = null;

  constructor(private readonly readStat: () => Promise<string>) {}

  /** Take the baseline sample (called at agent start-up). */
  async prime(): Promise<void> {
    try {
      this.previous = parseProcStat(await this.readStat());
    } catch {
      this.previous = null;
    }
  }

  async collect(): Promise<MetricSample[]> {
    let current: CpuTimes;
    try {
      current = parseProcStat(await this.readStat());
    } catch (error) {
      return [
        unavailable("cpu.usage_percent", error),
        unavailable("cpu.iowait_percent", error),
        unavailable("cpu.steal_percent", error),
      ];
    }
    const prev = this.previous;
    this.previous = current;
    const usage = prev ? computeCpuUsage(prev, current) : null;
    if (!usage) {
      const reason = prev ? "cpu counters did not advance" : "no baseline sample yet";
      return [
        unavailable("cpu.usage_percent", reason),
        unavailable("cpu.iowait_percent", reason),
        unavailable("cpu.steal_percent", reason),
      ];
    }
    return [
      sample("cpu.usage_percent", round(usage.usagePercent)),
      sample("cpu.iowait_percent", round(usage.iowaitPercent)),
      sample("cpu.steal_percent", round(usage.stealPercent)),
    ];
  }
}

export const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
