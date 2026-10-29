import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { alertRules, notifications } from "../../db";
import { createRuleSchema, ruleSemanticsSchema, updateRuleSchema } from "../../shared";
import type { AppEnv, Deps } from "../context";
import { audit } from "../lib/audit";
import { toRuleDto } from "../lib/dto";
import { HttpError, notFound, parseJson, pgErrorCode, uuidParam, validationError } from "../lib/errors";
import { RateLimiter, rateLimit } from "../lib/rate-limit";
import { requireSameOrigin, requireUser } from "../middleware/auth";

export const testSchema = z.object({ recipient: z.string().optional() }).strict();
const digits = (p: string) => p.replace(/\D/g, "");

function mapWriteError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === "23505") throw new HttpError(409, "conflict", "a rule with this name already exists");
  if (code === "23503")
    throw new HttpError(422, "validation_error", "hostId does not reference an existing host");
  throw error;
}

export function ruleRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const testLimiter = new RateLimiter(5, 3600_000);

  app.get("/alerts/rules", requireUser(deps), async (c) => {
    const rows = await deps.db.select().from(alertRules).orderBy(asc(alertRules.name));
    return c.json({ items: rows.map(toRuleDto) });
  });

  app.post("/alerts/rules", requireSameOrigin(deps), requireUser(deps, "admin"), async (c) => {
    const body = await parseJson(c, createRuleSchema);
    const user = c.get("user");
    const rule = await deps.db
      .transaction(async (tx) => {
        const [row] = await tx.insert(alertRules).values(body).returning();
        if (!row) throw new Error("rule insert returned no row");
        await audit(tx, {
          actorType: "user",
          actorId: user.id,
          action: "rule.create",
          targetType: "alert_rule",
          targetId: row.id,
          ip: c.get("ip"),
          metadata: { rule: body },
        });
        return row;
      })
      .catch(mapWriteError);
    return c.json(toRuleDto(rule), 201);
  });

  app.patch("/alerts/rules/:id", requireSameOrigin(deps), requireUser(deps, "admin"), async (c) => {
    const id = uuidParam(c, "id");
    const patch = await parseJson(c, updateRuleSchema);
    const user = c.get("user");
    const rule = await deps.db
      .transaction(async (tx) => {
        const [current] = await tx.select().from(alertRules).where(eq(alertRules.id, id)).for("update");
        if (!current) throw notFound("alert rule");
        const merged = { ...current, ...patch };
        const check = ruleSemanticsSchema.safeParse(merged);
        if (!check.success) throw validationError(check.error);
        const [row] = await tx.update(alertRules).set(patch).where(eq(alertRules.id, id)).returning();
        if (!row) throw notFound("alert rule");
        const before = Object.fromEntries(
          Object.keys(patch).map((k) => [k, current[k as keyof typeof current]]),
        );
        await audit(tx, {
          actorType: "user",
          actorId: user.id,
          action: "rule.update",
          targetType: "alert_rule",
          targetId: id,
          ip: c.get("ip"),
          metadata: { before, after: patch },
        });
        return row;
      })
      .catch(mapWriteError);
    return c.json(toRuleDto(rule));
  });

  /**
   * Queue a test message. Only numbers already configured in WHATSAPP_RECIPIENT are allowed,
   * so this endpoint cannot be used to message arbitrary phone numbers.
   */
  app.post(
    "/alerts/test",
    requireSameOrigin(deps),
    requireUser(deps, "admin"),
    rateLimit(testLimiter, (c) => `test:${c.get("user").id}`),
    async (c) => {
      const body = await parseJson(c, testSchema);
      const allowed = deps.config.whatsapp.recipients;
      if (allowed.length === 0) {
        throw new HttpError(422, "no_recipient_configured", "WHATSAPP_RECIPIENT is not configured");
      }
      const recipient = body.recipient
        ? allowed.find((r) => digits(r) === digits(body.recipient as string))
        : allowed[0];
      if (!recipient)
        throw new HttpError(403, "recipient_not_allowed", "recipient is not an authorized recipient");
      const user = c.get("user");
      const now = deps.now?.() ?? new Date();
      const id = crypto.randomUUID();
      await deps.db.transaction(async (tx) => {
        await tx.insert(notifications).values({
          id,
          kind: "test",
          recipient,
          dedupeKey: `test:${id}`,
          maxAttempts: 3,
          payload: {
            severityLabel: "TEST",
            host: "system-monitor",
            service: "Notification test",
            incidentId: id.slice(0, 8),
            detectedAt: `${now.toISOString().replace("T", " ").slice(0, 19)} UTC`,
            details: `Test message requested by ${user.email}`,
            suggestedAction: "No action required",
          },
        });
        await audit(tx, {
          actorType: "user",
          actorId: user.id,
          action: "notification.test",
          targetType: "notification",
          targetId: id,
          ip: c.get("ip"),
        });
      });
      return c.json({ notificationId: id, status: "queued" }, 202);
    },
  );

  return app;
}
