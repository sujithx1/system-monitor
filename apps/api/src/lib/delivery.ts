import type { NotificationStatus } from "@system-monitor/shared";
import { z } from "zod";

/** Subset of the WhatsApp Cloud API webhook payload that carries message status updates. */
export const whatsappWebhookSchema = z.object({
  object: z.string(),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              field: z.string(),
              value: z
                .object({
                  statuses: z
                    .array(
                      z.object({
                        id: z.string().max(200),
                        status: z.string().max(40),
                        timestamp: z
                          .string()
                          .regex(/^\d{1,12}$/)
                          .optional(),
                        errors: z
                          .array(
                            z.object({
                              code: z.number().optional(),
                              title: z.string().optional(),
                              message: z.string().optional(),
                            }),
                          )
                          .optional(),
                      }),
                    )
                    .max(1000)
                    .optional(),
                })
                .loose(),
            }),
          )
          .max(100),
      }),
    )
    .max(100),
});

export type DeliveryEvent = {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  at: Date;
  error: string | null;
};

export function extractDeliveryEvents(
  payload: z.infer<typeof whatsappWebhookSchema>,
  now: Date,
): DeliveryEvent[] {
  const events: DeliveryEvent[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      for (const s of change.value.statuses ?? []) {
        if (s.status !== "sent" && s.status !== "delivered" && s.status !== "read" && s.status !== "failed")
          continue;
        const err = s.errors?.[0];
        events.push({
          providerMessageId: s.id,
          status: s.status,
          at: s.timestamp ? new Date(Number(s.timestamp) * 1000) : now,
          error: err
            ? `${err.code ?? "unknown"}: ${err.title ?? err.message ?? "delivery failed"}`.slice(0, 500)
            : null,
        });
      }
    }
  }
  return events;
}

const RANK: Partial<Record<NotificationStatus, number>> = { accepted: 1, sent: 2, delivered: 3, read: 4 };

/**
 * Status updates can arrive out of order; only move forward (accepted → sent → delivered → read).
 * `failed` from the provider is terminal unless the message was already delivered/read.
 */
export function nextDeliveryStatus(
  current: NotificationStatus,
  incoming: DeliveryEvent["status"],
): NotificationStatus | null {
  if (current === "failed" || current === "cancelled") return null;
  const currentRank = RANK[current] ?? 0;
  if (incoming === "failed") return currentRank >= 3 ? null : "failed";
  return (RANK[incoming] ?? 0) > currentRank ? incoming : null;
}
