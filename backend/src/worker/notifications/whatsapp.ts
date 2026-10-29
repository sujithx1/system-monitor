import type { NotificationPayload } from "../../db";
import { describeError } from "../../shared";

export type SendOutcome =
  | { kind: "accepted"; messageId: string; httpStatus: number }
  | {
      kind: "retryable" | "permanent";
      httpStatus: number | null;
      errorCode: string;
      errorMessage: string;
      retryAfterMs?: number;
    };

export interface NotificationProvider {
  send(to: string, payload: NotificationPayload): Promise<SendOutcome>;
}

export interface WhatsAppOptions {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  templateName: string;
  templateLanguage: string;
  graphBaseUrl: string;
  timeoutMs: number;
}

/**
 * Error codes that are worth retrying (throttling, temporary outages). Everything else, e.g.
 * 131026 (undeliverable) or 132001 (template missing), will not succeed by retrying.
 * 190 (expired/invalid token) is retried so queued alerts go out once the token is fixed.
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 80007, 130429, 131000, 131016, 131048, 131056, 133004, 190]);

export function classifyProviderError(
  httpStatus: number | null,
  code: number | null,
): "retryable" | "permanent" {
  if (code !== null && RETRYABLE_CODES.has(code)) return "retryable";
  if (httpStatus === null || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500)
    return "retryable";
  return "permanent";
}

/**
 * Template parameters may not contain newlines/tabs or more than four consecutive spaces,
 * and must not be empty.
 */
export function sanitizeTemplateParam(value: string, maxLength = 200): string {
  const cleaned = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : "-";
}

/** Order must match the approved template body: {{1}}..{{7}}. */
export function templateParameters(p: NotificationPayload): string[] {
  return [p.severityLabel, p.host, p.service, p.incidentId, p.detectedAt, p.details, p.suggestedAction].map(
    (v) => sanitizeTemplateParam(v),
  );
}

interface GraphResponse {
  messages?: Array<{ id?: string }>;
  error?: { code?: number; message?: string; error_subcode?: number; error_data?: { details?: string } };
}

/** WhatsApp Business Platform Cloud API – template messages only (required outside 24h windows). */
export class WhatsAppClient implements NotificationProvider {
  constructor(
    private readonly options: WhatsAppOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(to: string, payload: NotificationPayload): Promise<SendOutcome> {
    const o = this.options;
    const url = `${o.graphBaseUrl}/${o.apiVersion}/${encodeURIComponent(o.phoneNumberId)}/messages`;
    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/\D/g, ""),
      type: "template",
      template: {
        name: o.templateName,
        language: { code: o.templateLanguage },
        components: [
          { type: "body", parameters: templateParameters(payload).map((text) => ({ type: "text", text })) },
        ],
      },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${o.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      return {
        kind: "retryable",
        httpStatus: null,
        errorCode: timedOut ? "timeout" : "network_error",
        errorMessage: timedOut ? `no response within ${o.timeoutMs} ms` : describeError(error),
      };
    }

    let json: GraphResponse = {};
    try {
      json = (await res.json()) as GraphResponse;
    } catch {
      // Non-JSON body (e.g. an HTML error page from a proxy) – classify by status only.
    }

    const messageId = json.messages?.[0]?.id;
    if (res.ok && typeof messageId === "string" && messageId.length > 0) {
      // Accepted for delivery – NOT delivered. Delivery arrives later via the status webhook.
      return { kind: "accepted", messageId, httpStatus: res.status };
    }

    const code = typeof json.error?.code === "number" ? json.error.code : null;
    const retryAfter = Number(res.headers.get("retry-after"));
    const detail = json.error?.error_data?.details ?? json.error?.message ?? `HTTP ${res.status}`;
    return {
      kind: res.ok ? "retryable" : classifyProviderError(res.status, code),
      httpStatus: res.status,
      errorCode: code !== null ? String(code) : res.ok ? "missing_message_id" : `http_${res.status}`,
      errorMessage: describeError(detail),
      ...(Number.isFinite(retryAfter) && retryAfter > 0
        ? { retryAfterMs: Math.min(retryAfter, 3600) * 1000 }
        : {}),
    };
  }
}
