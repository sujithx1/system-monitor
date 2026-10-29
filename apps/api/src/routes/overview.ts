import { incidents, monitoredHosts, notifications, serviceHeartbeats } from "@system-monitor/database";
import type { HostHealth, OverviewDto } from "@system-monitor/shared";
import { and, count, desc, eq, gt, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context";
import { loadHostSummaries } from "../lib/hosts";
import { requireUser } from "../middleware/auth";

export function overviewRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const now = () => deps.now?.() ?? new Date();

  async function workerStatus(at: Date) {
    const [latest] = await deps.db
      .select({ lastSeenAt: serviceHeartbeats.lastSeenAt })
      .from(serviceHeartbeats)
      .where(eq(serviceHeartbeats.service, "worker"))
      .orderBy(desc(serviceHeartbeats.lastSeenAt))
      .limit(1);
    const lastSeenAt = latest?.lastSeenAt ?? null;
    const healthy =
      !!lastSeenAt && at.getTime() - lastSeenAt.getTime() <= deps.config.health.workerStaleSeconds * 1000;
    return { lastSeenAt: lastSeenAt?.toISOString() ?? null, healthy };
  }

  app.get("/overview", requireUser(deps), async (c) => {
    const at = now();
    const hosts = await deps.db.select().from(monitoredHosts);
    const summaries = await loadHostSummaries(deps.db, hosts, at, deps.config.health.heartbeatOfflineSeconds);
    const hostCounts: Record<HostHealth, number> = {
      healthy: 0,
      warning: 0,
      critical: 0,
      offline: 0,
      unknown: 0,
      disabled: 0,
    };
    for (const h of summaries) hostCounts[h.health]++;

    const incidentRows = await deps.db
      .select({ status: incidents.status, n: count() })
      .from(incidents)
      .where(inArray(incidents.status, ["pending", "firing", "acknowledged"]))
      .groupBy(incidents.status);
    const incidentCount = (s: string) => Number(incidentRows.find((r) => r.status === s)?.n ?? 0);

    const [queued] = await deps.db
      .select({ n: count() })
      .from(notifications)
      .where(inArray(notifications.status, ["queued", "retrying", "sending"]));
    const [failed] = await deps.db
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.status, "failed"),
          gt(notifications.updatedAt, new Date(at.getTime() - 86_400_000)),
        ),
      );

    const worker = await workerStatus(at);
    const status: OverviewDto["status"] =
      hostCounts.critical + hostCounts.offline > 0 || !worker.healthy
        ? "critical"
        : hostCounts.warning > 0
          ? "warning"
          : "healthy";
    const body: OverviewDto = {
      status,
      hosts: { total: summaries.length, ...hostCounts },
      incidents: {
        pending: incidentCount("pending"),
        firing: incidentCount("firing"),
        acknowledged: incidentCount("acknowledged"),
      },
      notifications: { queued: Number(queued?.n ?? 0), failedLast24h: Number(failed?.n ?? 0) },
      worker,
    };
    return c.json(body);
  });

  app.get("/system/status", requireUser(deps), async (c) => {
    const at = now();
    const workers = await deps.db
      .select()
      .from(serviceHeartbeats)
      .orderBy(desc(serviceHeartbeats.lastSeenAt))
      .limit(20);
    const queue = await deps.db
      .select({ status: notifications.status, n: count() })
      .from(notifications)
      .groupBy(notifications.status);
    return c.json({
      serverTime: at.toISOString(),
      worker: await workerStatus(at),
      workers: workers.map((w) => ({
        service: w.service,
        instanceId: w.instanceId,
        version: w.version,
        startedAt: w.startedAt.toISOString(),
        lastSeenAt: w.lastSeenAt.toISOString(),
        details: w.details,
      })),
      notificationQueue: Object.fromEntries(queue.map((q) => [q.status, Number(q.n)])),
    });
  });

  return app;
}
