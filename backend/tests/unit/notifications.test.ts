import { describe, expect, test } from "bun:test";
import { extractDeliveryEvents, nextDeliveryStatus, whatsappWebhookSchema } from "../../src/api/lib/delivery";
import type { NotificationPayload } from "../../src/db";
import { backoffDelayMs } from "../../src/worker/notifications/backoff";
import { buildIncidentPayload } from "../../src/worker/notifications/payload";
import {
  classifyProviderError,
  sanitizeTemplateParam,
  WhatsAppClient,
} from "../../src/worker/notifications/whatsapp";

const payload: NotificationPayload = {
  severityLabel: "CRITICAL",
  host: "db-prod-1",
  service: "Disk usage (/var/lib/postgresql)",
  incidentId: "0b1c2d3e-0000-4000-8000-000000000000",
  detectedAt: "28 Oct 2026, 12:00:00 UTC",
  details: "Disk usage on /var/lib/postgresql is 96.4%\n(critical > 95.0%)",
  suggestedAction: "Free space. Do not delete WAL files.",
};
const options = {
  accessToken: "EAAG-super-secret-token",
  phoneNumberId: "123456789",
  apiVersion: "v23.0",
  templateName: "system_alert",
  templateLanguage: "en",
  graphBaseUrl: "https://graph.example.test",
  timeoutMs: 100,
};

type Call = { url: string; init: RequestInit };
function mockFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("WhatsApp Cloud API client", () => {
  test("sends an approved template with ordered, sanitised parameters", async () => {
    const { fn, calls } = mockFetch(() =>
      json({ messaging_product: "whatsapp", messages: [{ id: "wamid.ABC" }] }),
    );
    const result = await new WhatsAppClient(options, fn).send("+91 98765-43210", payload);
    expect(result).toEqual({ kind: "accepted", messageId: "wamid.ABC", httpStatus: 200 });
    const call = calls[0];
    expect(call?.url).toBe("https://graph.example.test/v23.0/123456789/messages");
    expect(new Headers(call?.init.headers).get("authorization")).toBe("Bearer EAAG-super-secret-token");
    const body = JSON.parse(String(call?.init.body));
    expect(body).toMatchObject({ messaging_product: "whatsapp", to: "919876543210", type: "template" });
    expect(body.template.name).toBe("system_alert");
    const params = body.template.components[0].parameters.map((p: { text: string }) => p.text);
    expect(params).toHaveLength(7);
    expect(params[0]).toBe("CRITICAL");
    expect(params[5]).toBe("Disk usage on /var/lib/postgresql is 96.4% (critical > 95.0%)");
  });

  test("throttling (429 / 130429) is retryable and honours Retry-After", async () => {
    const { fn } = mockFetch(() =>
      json({ error: { code: 130429, message: "Rate limit hit" } }, 429, { "retry-after": "30" }),
    );
    const r = await new WhatsAppClient(options, fn).send("+919876543210", payload);
    expect(r).toMatchObject({
      kind: "retryable",
      httpStatus: 429,
      errorCode: "130429",
      retryAfterMs: 30_000,
    });
  });

  test("template errors are permanent", async () => {
    const { fn } = mockFetch(() =>
      json({ error: { code: 132001, message: "Template name does not exist in the translation" } }, 404),
    );
    expect(await new WhatsAppClient(options, fn).send("+919876543210", payload)).toMatchObject({
      kind: "permanent",
      errorCode: "132001",
    });
  });

  test("provider 5xx and HTML error pages are retryable", async () => {
    const { fn } = mockFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await new WhatsAppClient(options, fn).send("+919876543210", payload)).toMatchObject({
      kind: "retryable",
      errorCode: "http_502",
    });
  });

  test("timeouts are retryable", async () => {
    const fn = (async (_url: string, init?: RequestInit) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as unknown as typeof fetch;
    expect(await new WhatsAppClient(options, fn).send("+919876543210", payload)).toMatchObject({
      kind: "retryable",
      errorCode: "timeout",
    });
  });

  test("an accepted HTTP response without a message id is not treated as sent", async () => {
    const { fn } = mockFetch(() => json({ messaging_product: "whatsapp" }));
    expect(await new WhatsAppClient(options, fn).send("+919876543210", payload)).toMatchObject({
      kind: "retryable",
      errorCode: "missing_message_id",
    });
  });

  test("error results never contain the access token", async () => {
    const { fn } = mockFetch(() => {
      throw new Error("connect ECONNREFUSED graph.example.test:443");
    });
    const r = await new WhatsAppClient(options, fn).send("+919876543210", payload);
    expect(JSON.stringify(r)).not.toContain(options.accessToken);
    expect(r).toMatchObject({ kind: "retryable", errorCode: "network_error" });
  });

  test("error classification", () => {
    expect(classifyProviderError(400, 131026)).toBe("permanent"); // undeliverable
    expect(classifyProviderError(401, 190)).toBe("retryable"); // token expired: retry after rotation
    expect(classifyProviderError(503, null)).toBe("retryable");
    expect(classifyProviderError(400, 100)).toBe("permanent");
  });

  test("template parameter sanitising", () => {
    expect(sanitizeTemplateParam("a\n\tb     c")).toBe("a b c");
    expect(sanitizeTemplateParam("   ")).toBe("-");
    expect(sanitizeTemplateParam("x".repeat(500))).toHaveLength(200);
  });
});

describe("retry backoff", () => {
  test("grows exponentially with jitter and is capped", () => {
    expect(backoffDelayMs(1, {}, () => 0)).toBe(2_500);
    expect(backoffDelayMs(1, {}, () => 1)).toBe(5_000);
    expect(backoffDelayMs(4, {}, () => 0.5)).toBe(30_000);
    expect(backoffDelayMs(30, {}, () => 1)).toBe(15 * 60_000);
    for (let i = 1; i < 12; i++) expect(backoffDelayMs(i)).toBeGreaterThan(0);
  });
});

describe("message payloads", () => {
  test("recovery messages say how long the incident lasted", () => {
    const p = buildIncidentPayload({
      kind: "recovery",
      severity: "critical",
      hostLabel: "db-prod-1",
      service: "CPU usage",
      incidentId: "x",
      detectedAt: new Date("2026-10-28T11:48:00Z"),
      summary: "CPU usage is 97.0%",
      suggestedAction: "Check processes",
      now: new Date("2026-10-28T12:00:00Z"),
      timeZone: "Asia/Kolkata",
    });
    expect(p.severityLabel).toBe("RESOLVED");
    expect(p.details).toBe("Recovered after 12m. Was: CPU usage is 97.0%");
    expect(p.detectedAt).toContain("17:18:00");
    expect(p.suggestedAction).toBe("No action required.");
  });
});

describe("delivery status webhooks", () => {
  test("only moves forward through accepted → sent → delivered → read", () => {
    expect(nextDeliveryStatus("accepted", "sent")).toBe("sent");
    expect(nextDeliveryStatus("delivered", "sent")).toBeNull();
    expect(nextDeliveryStatus("sent", "read")).toBe("read");
    expect(nextDeliveryStatus("sent", "failed")).toBe("failed");
    expect(nextDeliveryStatus("read", "failed")).toBeNull();
    expect(nextDeliveryStatus("cancelled", "delivered")).toBeNull();
  });

  test("extracts statuses from the Meta payload", () => {
    const body = whatsappWebhookSchema.parse({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                statuses: [
                  { id: "wamid.1", status: "delivered", timestamp: "1761652800", recipient_id: "91987" },
                  {
                    id: "wamid.2",
                    status: "failed",
                    timestamp: "1761652801",
                    errors: [{ code: 131026, title: "Message undeliverable" }],
                  },
                  { id: "wamid.3", status: "deleted" },
                ],
              },
            },
          ],
        },
      ],
    });
    const events = extractDeliveryEvents(body, new Date());
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      providerMessageId: "wamid.1",
      status: "delivered",
      at: new Date(1761652800 * 1000),
    });
    expect(events[1]).toMatchObject({ status: "failed", error: "131026: Message undeliverable" });
  });
});
