import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { notifications } from "../../db";
import { NOTIFICATION_KINDS, NOTIFICATION_STATUSES, type NotificationDto, type Page } from "../../shared";
import type { AppEnv, Deps } from "../context";
import { toNotificationDto } from "../lib/dto";
import { parseQuery } from "../lib/errors";
import { csvList, decodeCursor, pageQuery, toPage } from "../lib/pagination";
import { requireUser } from "../middleware/auth";

const listQuery = z
  .object({
    ...pageQuery,
    status: csvList(z.enum(NOTIFICATION_STATUSES)),
    kind: csvList(z.enum(NOTIFICATION_KINDS)),
    incidentId: z.uuid().optional(),
  })
  .strict();

export function notificationRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.get("/notifications", requireUser(deps), async (c) => {
    const q = parseQuery(c, listQuery);
    const conditions: SQL[] = [];
    if (q.status) conditions.push(inArray(notifications.status, q.status));
    if (q.kind) conditions.push(inArray(notifications.kind, q.kind));
    if (q.incidentId) conditions.push(eq(notifications.incidentId, q.incidentId));
    const cursor = decodeCursor(q.cursor);
    if (cursor) {
      conditions.push(
        sql`(${notifications.createdAt}, ${notifications.id}) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await deps.db
      .select()
      .from(notifications)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(q.limit + 1);
    const page = toPage(rows, q.limit, (r) => ({ t: r.createdAt, id: r.id }));
    const body: Page<NotificationDto> = {
      items: page.items.map((n) => toNotificationDto(n)),
      nextCursor: page.nextCursor,
    };
    return c.json(body);
  });

  return app;
}
