import { agents, metricSamples, metricSnapshots, monitoredHosts } from "@system-monitor/database";
import { heartbeatSchema, metricSnapshotSchema } from "@system-monitor/shared";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context";
import { HttpError, parseJson } from "../lib/errors";
import { RateLimiter, rateLimit } from "../lib/rate-limit";
import { requireAgent } from "../middleware/auth";

/**
 * Agent-facing endpoints. Payloads are untrusted: schema-validated, bounded in size, checked for
 * freshness (stale/replayed requests are refused) and de-duplicated per agent by snapshot id.
 * The host identity always comes from the agent credential, never from the payload.
 */
export function ingestRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const limiter = new RateLimiter(120, 60_000);
  const { maxSnapshotAgeSeconds, maxClockSkewSeconds } = deps.config.ingest;

  const agentOnly = [requireAgent(deps), rateLimit(limiter, (c) => `agent:${c.get("agent").id}`)] as const;

  const checkTimestamp = (at: Date, now: Date, what: string) => {
    if (at.getTime() - now.getTime() > maxClockSkewSeconds * 1000) {
      throw new HttpError(422, "clock_skew", `${what} is in the future; check NTP on the host`);
    }
    if (now.getTime() - at.getTime() > maxSnapshotAgeSeconds * 1000) {
      throw new HttpError(422, "stale_payload", `${what} is older than ${maxSnapshotAgeSeconds}s`);
    }
  };

  app.post("/agents/heartbeat", ...agentOnly, async (c) => {
    const body = await parseJson(c, heartbeatSchema);
    const now = deps.now?.() ?? new Date();
    checkTimestamp(new Date(body.sentAt), now, "sentAt");
    const agent = c.get("agent");
    await deps.db.transaction(async (tx) => {
      await tx
        .update(monitoredHosts)
        .set({ lastHeartbeatAt: now, lastAgentVersion: body.agentVersion, lastHostname: body.hostname })
        .where(eq(monitoredHosts.id, agent.hostId));
      await tx
        .update(agents)
        .set({ lastSeenAt: now, version: body.agentVersion, lastIp: c.get("ip") })
        .where(eq(agents.id, agent.id));
    });
    return c.json({ accepted: true, serverTime: now.toISOString() });
  });

  app.post("/metrics", ...agentOnly, async (c) => {
    const body = await parseJson(c, metricSnapshotSchema);
    const now = deps.now?.() ?? new Date();
    const collectedAt = new Date(body.collectedAt);
    checkTimestamp(collectedAt, now, "collectedAt");
    const agent = c.get("agent");

    const result = await deps.db.transaction(async (tx) => {
      const snapshotId = Bun.randomUUIDv7();
      const inserted = await tx
        .insert(metricSnapshots)
        .values({
          id: snapshotId,
          hostId: agent.hostId,
          agentId: agent.id,
          snapshotKey: body.snapshotId,
          agentVersion: body.agentVersion,
          collectedAt,
          sampleCount: body.metrics.length,
        })
        .onConflictDoNothing({ target: [metricSnapshots.agentId, metricSnapshots.snapshotKey] })
        .returning({ id: metricSnapshots.id });
      if (inserted.length === 0) return { duplicate: true, samples: 0 };

      await tx.insert(metricSamples).values(
        body.metrics.map((m) => ({
          id: Bun.randomUUIDv7(),
          snapshotId,
          hostId: agent.hostId,
          metric: m.name,
          resource: m.resource,
          status: m.status,
          value: m.value,
          error: m.error ?? null,
          collectedAt,
        })),
      );
      await tx
        .update(monitoredHosts)
        .set({
          lastHeartbeatAt: now,
          lastMetricsAt: sql`greatest(${monitoredHosts.lastMetricsAt}, ${collectedAt.toISOString()}::timestamptz)`,
          lastAgentVersion: body.agentVersion,
          lastHostname: body.hostname,
        })
        .where(eq(monitoredHosts.id, agent.hostId));
      await tx
        .update(agents)
        .set({ lastSeenAt: now, version: body.agentVersion, lastIp: c.get("ip") })
        .where(eq(agents.id, agent.id));
      return { duplicate: false, samples: body.metrics.length };
    });

    if (result.duplicate) return c.json({ accepted: true, duplicate: true, samples: 0 }, 200);
    return c.json({ accepted: true, duplicate: false, samples: result.samples }, 202);
  });

  return app;
}
