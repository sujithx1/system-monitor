import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import type { AgentConfig } from "@system-monitor/config";
import { type Logger, type MetricSample, type MetricSnapshot, unavailable } from "@system-monitor/shared";
import { collectBackupMarkers } from "./collectors/backup";
import { CpuCollector } from "./collectors/cpu";
import { collectDisks, parseProcMounts } from "./collectors/disk";
import { collectDocker } from "./collectors/docker";
import { checkHttp } from "./collectors/http";
import { collectMemory } from "./collectors/memory";
import { checkPostgres } from "./collectors/postgres";
import { collectSystem } from "./collectors/system";
import { withTimeout } from "./collectors/timeout";
import { AGENT_VERSION } from "./version";

export function safeHostname(): string {
  const h = hostname()
    .replace(/[^A-Za-z0-9.-]/g, "-")
    .slice(0, 253);
  return h || "unknown";
}

/**
 * Runs every collector concurrently and isolates failures: one broken collector produces
 * `unavailable` samples for its own metrics but never aborts the snapshot.
 */
export class SnapshotCollector {
  private readonly cpu: CpuCollector;
  private readonly readProc: (file: string) => Promise<string>;

  constructor(
    private readonly config: AgentConfig,
    private readonly log: Logger,
  ) {
    this.readProc = (file) => readFile(`${config.procRoot}/${file}`, "utf8");
    this.cpu = new CpuCollector(() => this.readProc("stat"));
  }

  prime(): Promise<void> {
    return this.cpu.prime();
  }

  private async mounts(): Promise<string[]> {
    if (this.config.mounts !== "auto") return this.config.mounts;
    return parseProcMounts(await this.readProc("mounts"));
  }

  async collect(): Promise<MetricSnapshot> {
    const collectedAt = new Date().toISOString();
    const budget = Math.max(2000, this.config.intervalSeconds * 1000 - 5000);
    const userAgent = `system-monitor-agent/${AGENT_VERSION}`;
    const tasks: Array<{ name: string; run: () => Promise<MetricSample[]>; fallback: MetricSample["name"] }> =
      [
        { name: "cpu", run: () => this.cpu.collect(), fallback: "cpu.usage_percent" },
        {
          name: "memory",
          run: () => collectMemory(() => this.readProc("meminfo")),
          fallback: "mem.usage_percent",
        },
        { name: "system", run: () => collectSystem(this.readProc), fallback: "load.1m" },
        { name: "disk", run: async () => collectDisks(await this.mounts()), fallback: "disk.usage_percent" },
        ...this.config.postgres.targets.map((t) => ({
          name: `postgres:${t.name}`,
          run: () => checkPostgres(t, this.config.postgres),
          fallback: "pg.up" as const,
        })),
        ...this.config.httpChecks.map((c) => ({
          name: `http:${c.name}`,
          run: () => checkHttp(c, userAgent),
          fallback: "http.up" as const,
        })),
        ...(this.config.dockerSocket
          ? [
              {
                name: "docker",
                run: () => collectDocker(this.config.dockerSocket as string, 5000),
                fallback: "container.running" as const,
              },
            ]
          : []),
        ...(this.config.backupMarkers.length > 0
          ? [
              {
                name: "backup",
                run: () => collectBackupMarkers(this.config.backupMarkers),
                fallback: "backup.age_seconds" as const,
              },
            ]
          : []),
      ];

    const results = await Promise.allSettled(
      tasks.map((t) => withTimeout(t.run(), budget, `${t.name} collector`)),
    );
    const metrics: MetricSample[] = [];
    results.forEach((result, i) => {
      const task = tasks[i];
      if (!task) return;
      if (result.status === "fulfilled") {
        metrics.push(...result.value);
      } else {
        this.log.warn("collector failed", { collector: task.name, error: result.reason });
        const resource = task.name.includes(":") ? task.name.split(":")[1] : "";
        metrics.push(unavailable(task.fallback, result.reason, resource));
      }
    });

    // Defensive de-duplication (the API rejects duplicate metric/resource pairs).
    const seen = new Set<string>();
    const unique = metrics.filter((m) => {
      const key = `${m.name}\u0000${m.resource}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      snapshotId: crypto.randomUUID(),
      agentVersion: AGENT_VERSION,
      hostname: safeHostname(),
      collectedAt,
      metrics: unique,
    };
  }
}
