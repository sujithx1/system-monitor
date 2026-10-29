import { and, asc, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { agents, alertRules, incidents, metricSamples, monitoredHosts, users } from "../../db";
import {
  type CreatedHostDto,
  type HostDetailDto,
  type LatestMetricDto,
  METRIC_NAMES,
  type MetricHistoryDto,
  type MetricName,
  type MetricSeriesDto,
} from "../../shared";
import type { AppEnv, Deps } from "../context";
import { audit } from "../lib/audit";
import { AGENT_TOKEN_PREFIX, generateToken, sha256Hex } from "../lib/crypto";
import { toAgentDto, toIncidentDto } from "../lib/dto";
import { HttpError, notFound, parseJson, parseQuery, pgErrorCode, uuidParam } from "../lib/errors";
import { getHost, loadHostSummaries } from "../lib/hosts";
import { csvList, decodeCursor } from "../lib/pagination";
import { requireSameOrigin, requireUser } from "../middleware/auth";

const hostName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, "lowercase letters, digits, . _ - (max 63)");
export const createHostSchema = z
  .object({
    name: hostName,
    displayName: z.string().trim().max(120).nullable().default(null),
    description: z.string().trim().max(1000).nullable().default(null),
    environment: z.string().trim().max(40).nullable().default(null),
  })
  .strict();
export const updateHostSchema = z
  .object({
    displayName: z.string().trim().max(120).nullable(),
    description: z.string().trim().max(1000).nullable(),
    environment: z.string().trim().max(40).nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "at least one field is required");
export const agentNameSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/) }).strict();

const MAX_RANGE_MS = 31 * 24 * 3600_000;
const historyQuery = z
  .object({
    metrics: csvList(z.enum(METRIC_NAMES)),
    resource: z.string().max(256).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    /** Bucket width in seconds; 0 = raw samples (paginated). Omitted = chosen automatically. */
    step: z.coerce.number().int().min(0).max(86_400).optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(2000),
    cursor: z.string().max(200).optional(),
  })
  .strict();

const DEFAULT_CHART_METRICS: MetricName[] = [
  "cpu.usage_percent",
  "mem.usage_percent",
  "disk.usage_percent",
  "pg.latency_ms",
  "http.latency_ms",
];

async function issueAgent(
  tx: Parameters<Parameters<Deps["db"]["transaction"]>[0]>[0],
  hostId: string,
  name: string,
) {
  const token = generateToken(AGENT_TOKEN_PREFIX);
  try {
    const [agent] = await tx
      .insert(agents)
      .values({ hostId, name, tokenHash: sha256Hex(token), tokenPrefix: token.slice(0, 12) })
      .returning();
    if (!agent) throw new Error("agent insert returned no row");
    return { agent, token };
  } catch (error) {
    if (pgErrorCode(error) === "23505")
      throw new HttpError(409, "conflict", "an agent with this name already exists");
    throw error;
  }
}

export function hostRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const now = () => deps.now?.() ?? new Date();
  const offline = deps.config.health.heartbeatOfflineSeconds;

  app.get("/hosts", requireUser(deps), async (c) => {
    const hosts = await deps.db.select().from(monitoredHosts).orderBy(asc(monitoredHosts.name));
    return c.json({ items: await loadHostSummaries(deps.db, hosts, now(), offline) });
  });

  app.post("/hosts", requireSameOrigin(deps), requireUser(deps, "admin"), async (c) => {
    const body = await parseJson(c, createHostSchema);
    const user = c.get("user");
    const created = await deps.db.transaction(async (tx) => {
      const [host] = await tx.insert(monitoredHosts).values(body).onConflictDoNothing().returning();
      if (!host) throw new HttpError(409, "conflict", "a host with this name already exists");
      const issued = await issueAgent(tx, host.id, "default");
      await audit(tx, {
        actorType: "user",
        actorId: user.id,
        action: "host.create",
        targetType: "host",
        targetId: host.id,
        ip: c.get("ip"),
        metadata: { name: host.name, agentId: issued.agent.id },
      });
      return { host, ...issued };
    });
    const [summary] = await loadHostSummaries(deps.db, [created.host], now(), offline);
    if (!summary) throw new Error("host summary missing");
    const dto: CreatedHostDto = {
      host: summary,
      agent: toAgentDto(created.agent),
      agentToken: created.token,
    };
    return c.json(dto, 201);
  });

  app.get("/hosts/:id", requireUser(deps), async (c) => {
    const host = await getHost(deps.db, uuidParam(c, "id"));
    if (!host) throw notFound("host");
    const [summary] = await loadHostSummaries(deps.db, [host], now(), offline);
    if (!summary) throw notFound("host");
    const agentRows = await deps.db
      .select()
      .from(agents)
      .where(eq(agents.hostId, host.id))
      .orderBy(asc(agents.createdAt));
    const latest = await deps.db
      .selectDistinctOn([metricSamples.metric, metricSamples.resource])
      .from(metricSamples)
      .where(
        and(
          eq(metricSamples.hostId, host.id),
          gt(metricSamples.collectedAt, new Date(now().getTime() - 15 * 60_000)),
        ),
      )
      .orderBy(metricSamples.metric, metricSamples.resource, desc(metricSamples.collectedAt));
    const incidentRows = await deps.db
      .select({ incident: incidents, ruleName: alertRules.name, ackEmail: users.email })
      .from(incidents)
      .innerJoin(alertRules, eq(alertRules.id, incidents.ruleId))
      .leftJoin(users, eq(users.id, incidents.acknowledgedBy))
      .where(eq(incidents.hostId, host.id))
      .orderBy(desc(incidents.startedAt))
      .limit(25);

    const dto: HostDetailDto = {
      ...summary,
      description: host.description,
      createdAt: host.createdAt.toISOString(),
      agents: agentRows.map(toAgentDto),
      metrics: latest.map(
        (m): LatestMetricDto => ({
          metric: m.metric as MetricName,
          resource: m.resource,
          value: m.value,
          status: m.status,
          error: m.error,
          collectedAt: m.collectedAt.toISOString(),
        }),
      ),
      incidents: incidentRows.map((r) =>
        toIncidentDto(r.incident, {
          ruleName: r.ruleName,
          hostName: host.name,
          acknowledgedByEmail: r.ackEmail,
        }),
      ),
    };
    return c.json(dto);
  });

  app.patch("/hosts/:id", requireSameOrigin(deps), requireUser(deps, "admin"), async (c) => {
    const id = uuidParam(c, "id");
    const body = await parseJson(c, updateHostSchema);
    const user = c.get("user");
    const host = await deps.db.transaction(async (tx) => {
      const [row] = await tx.update(monitoredHosts).set(body).where(eq(monitoredHosts.id, id)).returning();
      if (!row) throw notFound("host");
      await audit(tx, {
        actorType: "user",
        actorId: user.id,
        action: "host.update",
        targetType: "host",
        targetId: id,
        ip: c.get("ip"),
        metadata: { changes: body },
      });
      return row;
    });
    const [summary] = await loadHostSummaries(deps.db, [host], now(), offline);
    return c.json(summary);
  });

  /** Issue an additional agent credential (e.g. for rotation); the token is returned once. */
  app.post("/hosts/:id/agents", requireSameOrigin(deps), requireUser(deps, "admin"), async (c) => {
    const hostId = uuidParam(c, "id");
    const body = await parseJson(c, agentNameSchema);
    const user = c.get("user");
    const issued = await deps.db.transaction(async (tx) => {
      const [host] = await tx
        .select({ id: monitoredHosts.id })
        .from(monitoredHosts)
        .where(eq(monitoredHosts.id, hostId));
      if (!host) throw notFound("host");
      const result = await issueAgent(tx, hostId, body.name);
      await audit(tx, {
        actorType: "user",
        actorId: user.id,
        action: "agent.create",
        targetType: "agent",
        targetId: result.agent.id,
        ip: c.get("ip"),
        metadata: { hostId },
      });
      return result;
    });
    return c.json({ agent: toAgentDto(issued.agent), agentToken: issued.token }, 201);
  });

  app.post("/agents/:id/revoke", requireSameOrigin(deps), requireUser(deps, "admin"), async (c) => {
    const id = uuidParam(c, "id");
    const user = c.get("user");
    const agent = await deps.db.transaction(async (tx) => {
      const [row] = await tx
        .update(agents)
        .set({ enabled: false, revokedAt: sql`coalesce(${agents.revokedAt}, now())` })
        .where(eq(agents.id, id))
        .returning();
      if (!row) throw notFound("agent");
      await audit(tx, {
        actorType: "user",
        actorId: user.id,
        action: "agent.revoke",
        targetType: "agent",
        targetId: id,
        ip: c.get("ip"),
      });
      return row;
    });
    return c.json({ agent: toAgentDto(agent) });
  });

  app.get("/hosts/:id/metrics", requireUser(deps), async (c) => {
    const hostId = uuidParam(c, "id");
    const q = parseQuery(c, historyQuery);
    const host = await getHost(deps.db, hostId);
    if (!host) throw notFound("host");
    const to = q.to ? new Date(q.to) : now();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 3600_000);
    if (from >= to) throw new HttpError(422, "validation_error", "from must be before to");
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw new HttpError(422, "validation_error", "time range cannot exceed 31 days");
    }
    const metrics = q.metrics ?? DEFAULT_CHART_METRICS;
    const rangeSeconds = (to.getTime() - from.getTime()) / 1000;
    const step = q.step ?? (rangeSeconds <= 2 * 3600 ? 0 : Math.max(60, Math.ceil(rangeSeconds / 360)));

    const conditions = [
      eq(metricSamples.hostId, hostId),
      inArray(metricSamples.metric, metrics),
      gte(metricSamples.collectedAt, from),
      lte(metricSamples.collectedAt, to),
    ];
    if (q.resource !== undefined) conditions.push(eq(metricSamples.resource, q.resource));

    const seriesMap = new Map<string, MetricSeriesDto>();
    const push = (
      metric: string,
      resource: string,
      t: Date,
      value: number | null,
      maxValue: number | null,
    ) => {
      const key = `${metric}\u0000${resource}`;
      let s = seriesMap.get(key);
      if (!s) {
        s = { metric: metric as MetricName, resource, points: [] };
        seriesMap.set(key, s);
      }
      s.points.push({ t: t.toISOString(), value, max: maxValue });
    };

    let nextCursor: string | null = null;
    if (step === 0) {
      // Raw samples, ascending, keyset-paginated on (collected_at, id).
      const cursor = decodeCursor(q.cursor);
      if (cursor) {
        conditions.push(
          sql`(${metricSamples.collectedAt}, ${metricSamples.id}) > (${cursor.t}::timestamptz, ${cursor.id}::uuid)`,
        );
      }
      const rows = await deps.db
        .select({
          id: metricSamples.id,
          metric: metricSamples.metric,
          resource: metricSamples.resource,
          value: metricSamples.value,
          collectedAt: metricSamples.collectedAt,
        })
        .from(metricSamples)
        .where(and(...conditions))
        .orderBy(asc(metricSamples.collectedAt), asc(metricSamples.id))
        .limit(q.limit + 1);
      for (const r of rows.slice(0, q.limit)) push(r.metric, r.resource, r.collectedAt, r.value, r.value);
      const last = rows[q.limit - 1];
      if (rows.length > q.limit && last) {
        nextCursor = Buffer.from(JSON.stringify({ t: last.collectedAt.toISOString(), id: last.id })).toString(
          "base64url",
        );
      }
    } else {
      // `step` is a validated integer; inlining it keeps SELECT and GROUP BY expressions identical.
      const width = sql.raw(String(Math.trunc(step)));
      const bucket = sql<Date>`date_bin(make_interval(secs => ${width}), ${metricSamples.collectedAt}, timestamptz '2000-01-01')`;
      const rows = await deps.db
        .select({
          metric: metricSamples.metric,
          resource: metricSamples.resource,
          bucket: bucket.mapWith((v: string | Date) => new Date(v)),
          avg: sql<number | null>`avg(${metricSamples.value})`.mapWith((v) =>
            v === null ? null : Number(v),
          ),
          max: sql<number | null>`max(${metricSamples.value})`.mapWith((v) =>
            v === null ? null : Number(v),
          ),
        })
        .from(metricSamples)
        .where(and(...conditions))
        .groupBy(metricSamples.metric, metricSamples.resource, bucket)
        .orderBy(metricSamples.metric, metricSamples.resource, bucket)
        .limit(50_000);
      for (const r of rows) push(r.metric, r.resource, r.bucket, r.avg, r.max);
    }

    const dto: MetricHistoryDto & { nextCursor: string | null } = {
      hostId,
      from: from.toISOString(),
      to: to.toISOString(),
      stepSeconds: step === 0 ? null : step,
      series: [...seriesMap.values()],
      nextCursor,
    };
    return c.json(dto);
  });

  return app;
}
