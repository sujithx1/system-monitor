import {
  type Database,
  incidents,
  notificationAttempts,
  notifications,
  pgErrorCode,
} from "@system-monitor/database";
import type { Logger } from "@system-monitor/shared";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { backoffDelayMs } from "./backoff";
import type { NotificationProvider, SendOutcome } from "./whatsapp";

type NotificationRow = typeof notifications.$inferSelect;

export interface DispatcherContext {
  db: Database;
  log: Logger;
  provider: NotificationProvider;
  workerId: string;
  now: () => Date;
  batchSize?: number;
  /** Lease length; a crashed worker's claims become claimable again after this. */
  leaseMs?: number;
  random?: () => number;
}

export interface DispatchStats {
  claimed: number;
  accepted: number;
  retrying: number;
  failed: number;
  cancelled: number;
}

/**
 * Claims due notifications with FOR UPDATE SKIP LOCKED and leases them to this worker. Rows
 * stuck in `sending` past their lease (worker crashed mid-send) are reclaimed.
 */
export async function claimDue(ctx: DispatcherContext): Promise<NotificationRow[]> {
  const now = ctx.now();
  const leaseUntil = new Date(now.getTime() + (ctx.leaseMs ?? 120_000));
  return ctx.db.transaction(async (tx) => {
    const due = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        or(
          and(inArray(notifications.status, ["queued", "retrying"]), lte(notifications.nextAttemptAt, now)),
          and(eq(notifications.status, "sending"), lte(notifications.lockedUntil, now)),
        ),
      )
      .orderBy(asc(notifications.nextAttemptAt))
      .limit(ctx.batchSize ?? 10)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(notifications)
      .set({
        status: "sending",
        lockedBy: ctx.workerId,
        lockedUntil: leaseUntil,
        attemptCount: sql`${notifications.attemptCount} + 1`,
      })
      .where(
        inArray(
          notifications.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
  });
}

export async function dispatchDue(ctx: DispatcherContext): Promise<DispatchStats> {
  const stats: DispatchStats = { claimed: 0, accepted: 0, retrying: 0, failed: 0, cancelled: 0 };
  const claimed = await claimDue(ctx);
  stats.claimed = claimed.length;
  // Small, bounded concurrency keeps us well under WhatsApp throughput limits.
  const queue = [...claimed];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let n = queue.shift(); n; n = queue.shift()) {
      const result = await processOne(ctx, n).catch((error) => {
        ctx.log.error("notification processing failed", { notificationId: n.id, error });
        return "retrying" as const;
      });
      stats[result]++;
    }
  });
  await Promise.all(workers);
  return stats;
}

async function finish(
  ctx: DispatcherContext,
  n: NotificationRow,
  set: Partial<typeof notifications.$inferInsert>,
) {
  // Guarded by the lease: if another worker reclaimed the row meanwhile, this update is a no-op.
  await ctx.db
    .update(notifications)
    .set({ ...set, lockedBy: null, lockedUntil: null })
    .where(
      and(
        eq(notifications.id, n.id),
        eq(notifications.lockedBy, ctx.workerId),
        eq(notifications.status, "sending"),
      ),
    );
}

async function processOne(
  ctx: DispatcherContext,
  n: NotificationRow,
): Promise<keyof Omit<DispatchStats, "claimed">> {
  const now = ctx.now();
  if (n.attemptCount > n.maxAttempts) {
    await finish(ctx, n, {
      status: "failed",
      failedAt: now,
      lastError: n.lastError ?? "maximum attempts exceeded",
    });
    return "failed";
  }

  // Reminders and escalations only make sense while the incident is still firing.
  if ((n.kind === "reminder" || n.kind === "escalation") && n.incidentId) {
    const [incident] = await ctx.db
      .select({ status: incidents.status })
      .from(incidents)
      .where(eq(incidents.id, n.incidentId));
    if (incident?.status !== "firing") {
      await finish(ctx, n, {
        status: "cancelled",
        lastError: `cancelled: incident is ${incident?.status ?? "deleted"}`,
      });
      return "cancelled";
    }
  }

  const startedAt = ctx.now();
  const t0 = performance.now();
  let outcome: SendOutcome;
  try {
    outcome = await ctx.provider.send(n.recipient, n.payload);
  } catch (error) {
    outcome = {
      kind: "retryable",
      httpStatus: null,
      errorCode: "internal_error",
      errorMessage: String(error).slice(0, 300),
    };
  }
  const durationMs = Math.round(performance.now() - t0);
  const finishedAt = ctx.now();

  await ctx.db
    .insert(notificationAttempts)
    .values({
      notificationId: n.id,
      attemptNumber: n.attemptCount,
      workerId: ctx.workerId,
      startedAt,
      finishedAt,
      durationMs,
      httpStatus: outcome.httpStatus,
      outcome: outcome.kind,
      errorCode: outcome.kind === "accepted" ? null : outcome.errorCode,
      errorMessage: outcome.kind === "accepted" ? null : outcome.errorMessage,
      providerMessageId: outcome.kind === "accepted" ? outcome.messageId : null,
    })
    .onConflictDoNothing();

  const log = ctx.log.child({ notificationId: n.id, kind: n.kind, attempt: n.attemptCount });
  if (outcome.kind === "accepted") {
    try {
      await finish(ctx, n, {
        status: "accepted",
        providerMessageId: outcome.messageId,
        acceptedAt: finishedAt,
        lastError: null,
      });
    } catch (error) {
      // The message WAS sent. Never leave it "sending" (that would re-send it after the lease):
      // record acceptance without the conflicting provider id instead.
      if (pgErrorCode(error) !== "23505") throw error;
      await finish(ctx, n, {
        status: "accepted",
        acceptedAt: finishedAt,
        lastError: `duplicate provider message id ${outcome.messageId}`,
      });
      log.warn("provider returned an already-recorded message id", { messageId: outcome.messageId });
    }
    log.info("notification accepted by provider", { durationMs });
    return "accepted";
  }

  const lastError = `${outcome.errorCode}: ${outcome.errorMessage}`.slice(0, 500);
  if (outcome.errorCode === "190") log.error("WhatsApp access token rejected – rotate WHATSAPP_ACCESS_TOKEN");
  if (outcome.kind === "retryable" && n.attemptCount < n.maxAttempts) {
    const delay = Math.max(backoffDelayMs(n.attemptCount, {}, ctx.random), outcome.retryAfterMs ?? 0);
    await finish(ctx, n, {
      status: "retrying",
      nextAttemptAt: new Date(finishedAt.getTime() + delay),
      lastError,
    });
    log.warn("notification send failed; will retry", {
      errorCode: outcome.errorCode,
      httpStatus: outcome.httpStatus,
      retryInMs: delay,
    });
    return "retrying";
  }
  await finish(ctx, n, { status: "failed", failedAt: finishedAt, lastError });
  log.error("notification permanently failed", {
    errorCode: outcome.errorCode,
    httpStatus: outcome.httpStatus,
  });
  return "failed";
}
