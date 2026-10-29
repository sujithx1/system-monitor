import { type MetricSample, sample, unavailable } from "../shared";
import { round } from "./cpu";

/** Parse /proc/meminfo into bytes (values there are in kB = KiB). */
export function parseMeminfo(content: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of content.split("\n")) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?$/.exec(line.trim());
    if (m?.[1] && m[2]) out.set(m[1], Number(m[2]) * (line.includes("kB") ? 1024 : 1));
  }
  return out;
}

export interface MemoryStats {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  usagePercent: number;
  /** true when MemAvailable was missing (kernels < 3.14) and had to be estimated. */
  estimated: boolean;
  swapUsagePercent: number | null;
}

export function computeMemory(info: Map<string, number>): MemoryStats {
  const total = info.get("MemTotal");
  if (!total || total <= 0) throw new Error("MemTotal missing from /proc/meminfo");
  let available = info.get("MemAvailable");
  let estimated = false;
  if (available === undefined) {
    // Conservative fallback; page cache and reclaimable slab can usually be freed.
    available =
      (info.get("MemFree") ?? 0) +
      (info.get("Buffers") ?? 0) +
      (info.get("Cached") ?? 0) +
      (info.get("SReclaimable") ?? 0) -
      (info.get("Shmem") ?? 0);
    estimated = true;
  }
  available = Math.min(Math.max(available, 0), total);
  const used = total - available;
  const swapTotal = info.get("SwapTotal") ?? 0;
  const swapFree = info.get("SwapFree") ?? 0;
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: used,
    usagePercent: (used / total) * 100,
    estimated,
    swapUsagePercent: swapTotal > 0 ? ((swapTotal - Math.min(swapFree, swapTotal)) / swapTotal) * 100 : null,
  };
}

export async function collectMemory(readMeminfo: () => Promise<string>): Promise<MetricSample[]> {
  try {
    const m = computeMemory(parseMeminfo(await readMeminfo()));
    const out = [
      sample("mem.usage_percent", round(m.usagePercent)),
      sample("mem.total_bytes", m.totalBytes),
      sample("mem.available_bytes", m.availableBytes),
      sample("mem.used_bytes", m.usedBytes),
    ];
    if (m.swapUsagePercent !== null) out.push(sample("swap.usage_percent", round(m.swapUsagePercent)));
    return out;
  } catch (error) {
    return [unavailable("mem.usage_percent", error)];
  }
}
