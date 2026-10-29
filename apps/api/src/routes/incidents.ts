import {
  alertRules,
  incidents,
  monitoredHosts,
  notificationAttempts,
  notifications,
  users,
} from "@system-monitor/database";
import {
  INCIDENT_STATUSES,
  type IncidentDetailDto,
  type IncidentDto,
  type Page,
  SEVERITIES,
} from "@system-monitor/shared";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Deps } from "../context";
import { audit } from "../lib/audit";
import { toIncidentDto, toNotificationDto, toRuleDto } from "../lib/dto";
import { HttpError, notFound, parseJson, parseQuery, uuidParam } from "../lib/errors";
import { csvList, decodeCursor, pageQuery, toPage } from "../lib/pagination";
import { requireSameOrigin, requireUser } from "../middleware/auth";

const listQuery = z
  .object({
    ...pageQuery,
    status: csvList(z.enum(INCIDENT_STATUSES)),
    severity: csvList(z.enum(SEVERITIES)),
    hostId: z.uuid().optional(),
    ruleId: z.uuid().optional(),
  })
  .strict();

export const ackSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();

export function incidentRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  const baseSelect = () =>
    deps.db
      .select({
        incident: incidents,
        ruleName: alertRules.name,
        hostName: monitoredHosts.name,
        ackEmail: users.email,
      })
      .from(incidents)
      .innerJoin(alertRules, eq(alertRules.id, incidents.ruleId))
      .innerJoin(monitoredHosts, eq(monitoredHosts.id, incidents.hostId))
      .leftJoin(users, eq(users.id, incidents.acknowledgedBy));

  const toDto = (r: {
    incident: typeof incidents.$inferSelect;
    ruleName: string;
    hostName: string;
    ackEmail: string | null;
  }) =>
    toIncidentDto(r.incident, {
      ruleName: r.ruleName,
      hostName: r.hostName,
      acknowledgedByEmail: r.ackEmail,
    });

  app.get("/incidents", requireUser(deps), async (c) => {
    const q = parseQuery(c, listQuery);
    const conditions: SQL[] = [];
    if (q.status) conditions.push(inArray(incidents.status, q.status));
    if (q.severity) conditions.push(inArray(incidents.severity, q.severity));
    if (q.hostId) conditions.push(eq(incidents.hostId, q.hostId));
    if (q.ruleId) conditions.push(eq(incidents.ruleId, q.ruleId));
    const cursor = decodeCursor(q.cursor);
    if (cursor) {
      conditions.push(
        sql`(${incidents.startedAt}, ${incidents.id}) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await baseSelect()
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(incidents.startedAt), desc(incidents.id))
      .limit(q.limit + 1);
    const page = toPage(rows, q.limit, (r) => ({ t: r.incident.startedAt, id: r.incident.id }));
    const body: Page<IncidentDto> = { items: page.items.map(toDto), nextCursor: page.nextCursor };
    return c.json(body);
  });

  app.get("/incidents/:id", requireUser(deps), async (c) => {
    const id = uuidParam(c, "id");
    const [row] = await baseSelect().where(eq(incidents.id, id)).limit(1);
    if (!row) throw notFound("incident");
    const [rule] = await deps.db.select().from(alertRules).where(eq(alertRules.id, row.incident.ruleId));
    const notes = await deps.db
      .select()
      .from(notifications)
      .where(eq(notifications.incidentId, id))
      .orderBy(asc(notifications.createdAt));
    const attempts =
      notes.length > 0
        ? await deps.db
            .select()
            .from(notificationAttempts)
            .where(
              inArray(
                notificationAttempts.notificationId,
                notes.map((n) => n.id),
              ),
            )
            .orderBy(asc(notificationAttempts.attemptNumber))
        : [];
    const dto: IncidentDetailDto = {
      ...toDto(row),
      rule: rule ? toRuleDto(rule) : null,
      notifications: notes.map((n) =>
        toNotificationDto(
          n,
          attempts.filter((a) => a.notificationId === n.id),
        ),
      ),
    };
    return c.json(dto);
  });

  app.post(
    "/incidents/:id/acknowledge",
    requireSameOrigin(deps),
    requireUser(deps, "operator"),
    async (c) => {
      const id = uuidParam(c, "id");
      // The body is optional: acknowledging without a note needs no payload.
      const hasJson = (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");
      const body = hasJson ? await parseJson(c, ackSchema) : {};
      const user = c.get("user");
      const now = deps.now?.() ?? new Date();
      await deps.db.transaction(async (tx) => {
        const [incident] = await tx.select().from(incidents).where(eq(incidents.id, id)).for("update");
        if (!incident) throw notFound("incident");
        if (incident.status === "acknowledged") {
          throw new HttpError(409, "already_acknowledged", "incident is already acknowledged");
        }
        if (incident.status !== "firing") {
          throw new HttpError(
            409,
            "invalid_state",
            `cannot acknowledge an incident that is ${incident.status}`,
          );
        }
        await tx
          .update(incidents)
          .set({
            status: "acknowledged",
            acknowledgedAt: now,
            acknowledgedBy: user.id,
            metadata: sql`${incidents.metadata} || ${JSON.stringify({ ackNote: body.note ?? null })}::jsonb`,
          })
          .where(eq(incidents.id, id));
        // Acknowledgement stops reminders/escalations that have not been sent yet.
        await tx
          .update(notifications)
          .set({
            status: "cancelled",
            lastError: "cancelled: incident acknowledged",
            lockedBy: null,
            lockedUntil: null,
          })
          .where(
            and(
              eq(notifications.incidentId, id),
              inArray(notifications.kind, ["reminder", "escalation"]),
              inArray(notifications.status, ["queued", "retrying"]),
            ),
          );
        await audit(tx, {
          actorType: "user",
          actorId: user.id,
          action: "incident.acknowledge",
          targetType: "incident",
          targetId: id,
          ip: c.get("ip"),
        });
      });
      const [row] = await baseSelect().where(eq(incidents.id, id)).limit(1);
      if (!row) throw notFound("incident");
      return c.json(toDto(row));
    },
  );

  return app;
}
