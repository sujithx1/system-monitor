import { describe, expect, test } from "bun:test";
import { CpuCollector, computeCpuUsage, parseProcStat } from "../../apps/agent/src/collectors/cpu";
import { collectDisks, computeDiskUsage, parseProcMounts } from "../../apps/agent/src/collectors/disk";
import { parseContainers } from "../../apps/agent/src/collectors/docker";
import { collectMemory, computeMemory, parseMeminfo } from "../../apps/agent/src/collectors/memory";
import { parseLoadavg, parseUptime } from "../../apps/agent/src/collectors/system";
import { MEMINFO, MEMINFO_NO_AVAILABLE, PROC_MOUNTS, PROC_STAT_1, PROC_STAT_2 } from "../fixtures/proc";

describe("CPU", () => {
  test("parses the aggregate cpu line", () => {
    expect(parseProcStat(PROC_STAT_1)).toEqual({
      user: 10000,
      nice: 500,
      system: 3000,
      idle: 80000,
      iowait: 1000,
      irq: 0,
      softirq: 200,
      steal: 300,
    });
  });

  test("utilisation is computed from the difference of two samples", () => {
    const usage = computeCpuUsage(parseProcStat(PROC_STAT_1), parseProcStat(PROC_STAT_2));
    expect(usage?.usagePercent).toBeCloseTo(75, 5);
    expect(usage?.iowaitPercent).toBeCloseTo(5, 5);
    expect(usage?.stealPercent).toBe(0);
  });

  test("counter reset (reboot) yields null instead of a bogus value", () => {
    expect(computeCpuUsage(parseProcStat(PROC_STAT_2), parseProcStat(PROC_STAT_1))).toBeNull();
    expect(computeCpuUsage(parseProcStat(PROC_STAT_1), parseProcStat(PROC_STAT_1))).toBeNull();
  });

  test("rejects malformed input", () => {
    expect(() => parseProcStat("intr 1\n")).toThrow();
    expect(() => parseProcStat("cpu  a b c d\n")).toThrow();
  });

  test("collector reports unavailable – not zero – without a baseline or on read errors", async () => {
    const reads = [PROC_STAT_1, PROC_STAT_2];
    const c = new CpuCollector(async () => reads.shift() ?? PROC_STAT_2);
    const first = await c.collect(); // no prime() → no baseline
    expect(first.every((s) => s.status === "unavailable" && s.value === null)).toBe(true);
    const second = await c.collect();
    expect(second.find((s) => s.name === "cpu.usage_percent")?.value).toBe(75);

    const broken = new CpuCollector(async () => {
      throw new Error("EACCES");
    });
    const out = await broken.collect();
    expect(out[0]).toMatchObject({ status: "unavailable", value: null, error: "EACCES" });
  });

  test("prime() provides the baseline so the first cycle already has a value", async () => {
    const reads = [PROC_STAT_1, PROC_STAT_2];
    const c = new CpuCollector(async () => reads.shift() ?? "");
    await c.prime();
    expect((await c.collect()).find((s) => s.name === "cpu.usage_percent")?.value).toBe(75);
  });
});

describe("memory", () => {
  test("uses MemAvailable, not MemFree", () => {
    const m = computeMemory(parseMeminfo(MEMINFO));
    expect(m.totalBytes).toBe(16384000 * 1024);
    expect(m.availableBytes).toBe(4096000 * 1024);
    expect(m.usagePercent).toBeCloseTo(75, 5);
    expect(m.estimated).toBe(false);
    expect(m.swapUsagePercent).toBeCloseTo(25, 5);
  });

  test("estimates availability on kernels without MemAvailable", () => {
    const m = computeMemory(parseMeminfo(MEMINFO_NO_AVAILABLE));
    // free + buffers + cached + sreclaimable - shmem = 360000 kB available of 1000000
    expect(m.availableBytes).toBe(360000 * 1024);
    expect(m.usagePercent).toBeCloseTo(64, 5);
    expect(m.estimated).toBe(true);
    expect(m.swapUsagePercent).toBeNull();
  });

  test("missing MemTotal is reported as unavailable", async () => {
    const out = await collectMemory(async () => "MemFree: 1 kB");
    expect(out).toEqual([
      expect.objectContaining({ name: "mem.usage_percent", status: "unavailable", value: null }),
    ]);
  });
});

describe("disk", () => {
  const stat = {
    bsize: 4096n,
    blocks: 1_000_000n,
    bfree: 100_000n, // includes 50_000 reserved blocks
    bavail: 50_000n,
    files: 500_000n,
    ffree: 400_000n,
  };

  test("matches df: used / (used + available) excluding reserved blocks", () => {
    const d = computeDiskUsage(stat);
    expect(d.totalBytes).toBe(4096 * 1_000_000);
    expect(d.usedBytes).toBe(4096 * 900_000);
    expect(d.availableBytes).toBe(4096 * 50_000);
    expect(d.freeBytes).toBe(4096 * 100_000);
    expect(d.usagePercent).toBeCloseTo((900_000 / 950_000) * 100, 6);
  });

  test("inode utilisation", () => {
    const d = computeDiskUsage(stat);
    expect(d.inodesTotal).toBe(500_000);
    expect(d.inodesUsed).toBe(100_000);
    expect(d.inodeUsagePercent).toBeCloseTo(20, 6);
  });

  test("filesystems without fixed inodes report inode usage as not applicable", () => {
    expect(computeDiskUsage({ ...stat, files: 0n, ffree: 0n }).inodeUsagePercent).toBeNull();
  });

  test("zero-capacity filesystem is an error, not 0%", () => {
    expect(() => computeDiskUsage({ ...stat, blocks: 0n })).toThrow();
  });

  test("per-mount failures become unavailable samples for that mount only", async () => {
    const out = await collectDisks(["/", "/missing"], async (p) => {
      if (p === "/missing") throw new Error("ENOENT: no such file or directory");
      return stat;
    });
    expect(out.find((s) => s.name === "disk.usage_percent" && s.resource === "/")?.status).toBe("ok");
    expect(out.find((s) => s.name === "disk.usage_percent" && s.resource === "/missing")).toMatchObject({
      status: "unavailable",
      value: null,
    });
  });

  test("auto mount discovery keeps one mount per real filesystem and decodes escapes", () => {
    expect(parseProcMounts(PROC_MOUNTS)).toEqual(["/", "/mnt/with space", "/var/lib/postgresql"]);
  });
});

describe("system", () => {
  test("load average and uptime", () => {
    expect(parseLoadavg("0.52 0.58 0.59 1/467 12345\n")).toEqual([0.52, 0.58, 0.59]);
    expect(parseUptime("350735.47 234388.90\n")).toBeCloseTo(350735.47);
    expect(() => parseLoadavg("garbage")).toThrow();
  });

  test("docker container states", () => {
    const out = parseContainers([
      { Names: ["/api"], State: "running", Status: "Up 2 hours (healthy)" },
      { Names: ["/db"], State: "exited", Status: "Exited (1) 3 minutes ago" },
    ]);
    expect(out).toEqual([
      { name: "container.running", resource: "api", status: "ok", value: 1 },
      { name: "container.healthy", resource: "api", status: "ok", value: 1 },
      { name: "container.running", resource: "db", status: "ok", value: 0 },
    ]);
  });
});
