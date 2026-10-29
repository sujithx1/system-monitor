import {
  type Database,
  incidents,
  metricSamples,
  metricSnapshots,
  notifications,
  serviceHeartbeats,
  sessions,
} from "@system-monitor/database";
import { and, inArray, isNotNull, lt, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

export interface RetentionPolicy {
  metricsDays: number;
  incidentsDays: number;
  notificationsDays: number;
}

const DAY = 86_400_000;
const TERMINAL = ["accepted", "sent", "delivered", "read", "failed", "cancelled"] as const;

/** Deletes in bounded batches so retention never holds long locks on hot tables. */
async function deleteInBatches(
  db: Database,
  table: PgTable,
  id: PgColumn,
  where: SQL | undefined,
  batchSize = 5000,
) {
  let total = 0;
  for (;;) {
    const ids = db.select({ id }).from(table).where(where).limit(batchSize);
    const deleted = await db.delete(table).where(inArray(id, ids)).returning({ id });
    total += deleted.length;
    if (deleted.length < batchSize) return total;
  }
}

export async function applyRetention(db: Database, policy: RetentionPolicy, now: Date) {
  const metricsCutoff = new Date(now.getTime() - policy.metricsDays * DAY);
  return {
    samples: await deleteInBatches(
      db,
      metricSamples,
      metricSamples.id,
      lt(metricSamples.collectedAt, metricsCutoff),
    ),
    snapshots: await deleteInBatches(
      db,
      metricSnapshots,
      metricSnapshots.id,
      lt(metricSnapshots.collectedAt, metricsCutoff),
    ),
    notifications: await deleteInBatches(
      db,
      notifications,
      notifications.id,
      and(
        inArray(notifications.status, [...TERMINAL]),
        lt(notifications.createdAt, new Date(now.getTime() - policy.notificationsDays * DAY)),
      ),
    ),
    incidents: await deleteInBatches(
      db,
      incidents,
      incidents.id,
      and(
        isNotNull(incidents.resolvedAt),
        lt(incidents.resolvedAt, new Date(now.getTime() - policy.incidentsDays * DAY)),
      ),
    ),
    sessions: await deleteInBatches(db, sessions, sessions.id, lt(sessions.expiresAt, now)),
    heartbeats: await deleteInBatches(
      db,
      serviceHeartbeats,
      serviceHeartbeats.id,
      lt(serviceHeartbeats.lastSeenAt, new Date(now.getTime() - 7 * DAY)),
    ),
  };
}
