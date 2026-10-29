import { availableParallelism } from "node:os";
import { type MetricSample, sample, unavailable } from "../shared";

export function parseLoadavg(content: string): [number, number, number] {
  const [a, b, c] = content.trim().split(/\s+/).map(Number);
  if (![a, b, c].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) {
    throw new Error("malformed /proc/loadavg");
  }
  return [a as number, b as number, c as number];
}

export function parseUptime(content: string): number {
  const seconds = Number(content.trim().split(/\s+/)[0]);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("malformed /proc/uptime");
  return seconds;
}

export async function collectSystem(read: (file: string) => Promise<string>): Promise<MetricSample[]> {
  const out: MetricSample[] = [sample("cpu.count", availableParallelism())];
  try {
    const [l1, l5, l15] = parseLoadavg(await read("loadavg"));
    out.push(sample("load.1m", l1), sample("load.5m", l5), sample("load.15m", l15));
  } catch (error) {
    out.push(unavailable("load.1m", error));
  }
  try {
    out.push(sample("system.uptime_seconds", Math.floor(parseUptime(await read("uptime")))));
  } catch (error) {
    out.push(unavailable("system.uptime_seconds", error));
  }
  return out;
}
