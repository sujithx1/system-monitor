import { notifications } from "@system-monitor/database";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context";
import { hmacSha256Hex, safeEqual } from "../lib/crypto";
import { extractDeliveryEvents, nextDeliveryStatus, whatsappWebhookSchema } from "../lib/delivery";
import { HttpError } from "../lib/errors";
import { RateLimiter, rateLimit } from "../lib/rate-limit";

/**
 * WhatsApp Cloud API webhook. Public by necessity (Meta calls it), so every POST must carry a
 * valid X-Hub-Signature-256 HMAC of the raw body made with the app secret.
 */
export function webhookRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const limiter = new RateLimiter(600, 60_000);
  const limited = rateLimit(limiter, (c) => `webhook:${c.get("ip")}`);

  app.get("/webhooks/whatsapp", limited, (c) => {
    const expected = deps.config.whatsapp.webhookVerifyToken;
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token") ?? "";
    const challenge = c.req.query("hub.challenge") ?? "";
    if (
      !expected ||
      mode !== "subscribe" ||
      !safeEqual(token, expected) ||
      !/^[\w-]{1,200}$/.test(challenge)
    ) {
      throw new HttpError(403, "forbidden", "webhook verification failed");
    }
    return c.text(challenge);
  });

  app.post("/webhooks/whatsapp", limited, async (c) => {
    const secret = deps.config.whatsapp.appSecret;
    if (!secret) throw new HttpError(503, "not_configured", "webhook is not configured");
    const raw = await c.req.text();
    const signature = c.req.header("x-hub-signature-256") ?? "";
    if (!safeEqual(signature, `sha256=${hmacSha256Hex(secret, raw)}`)) {
      throw new HttpError(401, "invalid_signature", "invalid webhook signature");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
    }
    const payload = whatsappWebhookSchema.safeParse(parsed);
    if (!payload.success) {
      // Acknowledge unknown shapes so Meta does not retry forever; log for investigation.
      c.get("log").warn("unrecognised whatsapp webhook payload");
      return c.json({ received: true });
    }

    const events = extractDeliveryEvents(payload.data, deps.now?.() ?? new Date());
    let applied = 0;
    for (const event of events) {
      await deps.db.transaction(async (tx) => {
        const [n] = await tx
          .select({ id: notifications.id, status: notifications.status })
          .from(notifications)
          .where(eq(notifications.providerMessageId, event.providerMessageId))
          .for("update");
        if (!n) return;
        const next = nextDeliveryStatus(n.status, event.status);
        if (!next) return;
        await tx
          .update(notifications)
          .set({
            status: next,
            ...(next === "sent" ? { sentAt: event.at } : {}),
            ...(next === "delivered" ? { deliveredAt: event.at } : {}),
            ...(next === "read" ? { readAt: event.at } : {}),
            ...(next === "failed" ? { failedAt: event.at, lastError: event.error ?? "delivery failed" } : {}),
          })
          .where(eq(notifications.id, n.id));
        applied++;
      });
    }
    c.get("log").info("whatsapp status webhook processed", { events: events.length, applied });
    return c.json({ received: true });
  });

  return app;
}
