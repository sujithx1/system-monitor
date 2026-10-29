import { and, count, desc, eq, gt, inArray } from "drizzle-orm";
import { type Database, incidents, metricSamples, monitoredHosts } from "../../db";
import type { HostHealth, HostSummaryDto } from "../../shared";

type HostRow = typeof monitoredHosts.$inferSelect;

export function computeHealth(
  host: Pick<HostRow, "enabled" | "lastHeartbeatAt">,
  worstActive: "warning" | "critical" | null,
  now: Date,
  offlineAfterSeconds: number,
): HostHealth {
  if (!host.enabled) return "disabled";
  if (!host.lastHeartbeatAt) return "unknown";
  if (now.getTime() - host.lastHeartbeatAt.getTime() > offlineAfterSeconds * 1000) return "offline";
  if (worstActive === "critical") return "critical";
  if (worstActive === "warning") return "warning";
  return "healthy";
}

const KEY_METRICS = ["cpu.usage_percent", "mem.usage_percent", "disk.usage_percent"] as const;

/** Builds host summaries (health, active incident counts, latest key metrics) in three queries. */
export async function loadHostSummaries(
  db: Database,
  hosts: HostRow[],
  now: Date,
  offlineAfterSeconds: number,
): Promise<HostSummaryDto[]> {
  if (hosts.length === 0) return [];
  const ids = hosts.map((h) => h.id);

  const activeRows = await db
    .select({ hostId: incidents.hostId, severity: incidents.severity, n: count() })
    .from(incidents)
    .where(and(inArray(incidents.hostId, ids), inArray(incidents.status, ["firing", "acknowledged"])))
    .groupBy(incidents.hostId, incidents.severity);

  const recent = new Date(now.getTime() - 10 * 60_000);
  const latestRows = await db
    .selectDistinctOn([metricSamples.hostId, metricSamples.metric, metricSamples.resource], {
      hostId: metricSamples.hostId,
      metric: metricSamples.metric,
      value: metricSamples.value,
    })
    .from(metricSamples)
    .where(
      and(
        inArray(metricSamples.hostId, ids),
        inArray(metricSamples.metric, [...KEY_METRICS]),
        gt(metricSamples.collectedAt, recent),
      ),
    )
    .orderBy(
      metricSamples.hostId,
      metricSamples.metric,
      metricSamples.resource,
      desc(metricSamples.collectedAt),
    );

  return hosts.map((h) => {
    const active = activeRows.filter((r) => r.hostId === h.id);
    const worst = active.some((r) => r.severity === "critical")
      ? "critical"
      : active.length > 0
        ? "warning"
        : null;
    const latest = latestRows.filter((r) => r.hostId === h.id);
    const pick = (metric: string) => latest.find((r) => r.metric === metric)?.value ?? null;
    const disks = latest.filter((r) => r.metric === "disk.usage_percent" && r.value !== null);
    return {
      id: h.id,
      name: h.name,
      displayName: h.displayName,
      environment: h.environment,
      enabled: h.enabled,
      health: computeHealth(h, worst, now, offlineAfterSeconds),
      lastHeartbeatAt: h.lastHeartbeatAt?.toISOString() ?? null,
      lastMetricsAt: h.lastMetricsAt?.toISOString() ?? null,
      agentVersion: h.lastAgentVersion,
      hostname: h.lastHostname,
      activeIncidents: active.reduce((sum, r) => sum + Number(r.n), 0),
      latest: {
        cpu: pick("cpu.usage_percent"),
        memory: pick("mem.usage_percent"),
        diskMax: disks.length > 0 ? Math.max(...disks.map((d) => d.value as number)) : null,
      },
    };
  });
}

export async function getHost(db: Database, id: string): Promise<HostRow | undefined> {
  const [row] = await db.select().from(monitoredHosts).where(eq(monitoredHosts.id, id)).limit(1);
  return row;
}
