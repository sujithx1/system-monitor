import type {
  AlertRuleDto,
  ApiErrorBody,
  CreatedHostDto,
  HostDetailDto,
  HostSummaryDto,
  IncidentDetailDto,
  IncidentDto,
  IncidentStatus,
  MetricHistoryDto,
  MetricName,
  NotificationDto,
  NotificationKind,
  NotificationStatus,
  OverviewDto,
  Page,
  Severity,
  UserDto,
} from "../shared";

const BASE = "/api/v1";

export type ValidationDetail = { path: string; message: string };

/** Every failed request surfaces as an ApiError carrying the server's message and details. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: ValidationDetail[];

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string | null,
    details: ValidationDetail[],
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ApiError(0, "client_error", message, null, []);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrow an unknown JSON body to the documented error envelope. */
function parseErrorBody(body: unknown): ApiErrorBody["error"] | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const { code, message, requestId, details } = body.error;
  if (typeof code !== "string" || typeof message !== "string") return null;
  const parsedDetails: ValidationDetail[] = [];
  if (Array.isArray(details)) {
    for (const d of details) {
      if (isRecord(d) && typeof d.path === "string" && typeof d.message === "string") {
        parsedDetails.push({ path: d.path, message: d.message });
      }
    }
  }
  return {
    code,
    message,
    ...(typeof requestId === "string" ? { requestId } : {}),
    details: parsedDetails,
  };
}

let unauthorizedHandler: (() => void) | null = null;

/** Registered by the auth provider: any 401 (outside the login call itself) ends the session. */
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

type Method = "GET" | "POST" | "PATCH";

interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** When false, a 401 is returned to the caller instead of triggering a global logout. */
  globalUnauthorized?: boolean;
}

type Query = Record<string, string | number | readonly string[] | null | undefined>;

function buildQuery(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number") {
      if (value === "") continue;
      params.set(key, String(value));
    } else if (value.length > 0) {
      params.set(key, value.join(","));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * Same-origin JSON request with cookie session auth. Mutations always carry a JSON body and
 * content-type, which the API requires; the browser adds the Origin header the API checks.
 * Resolves with the raw response text of a successful request.
 */
async function send(method: Method, path: string, options: RequestOptions): Promise<string> {
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: options.signal ?? null,
  };
  if (method !== "GET") {
    init.headers = { accept: "application/json", "content-type": "application/json" };
    init.body = JSON.stringify(options.body ?? {});
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(`${BASE}${path}`, init);
    text = await response.text();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError(
      0,
      "network_error",
      "Could not reach the monitoring API. Check your connection.",
      null,
      [],
    );
  }

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const parsed = parseErrorBody(body);
    const error = new ApiError(
      response.status,
      parsed?.code ?? "http_error",
      parsed?.message ?? `Request failed (HTTP ${response.status})`,
      parsed?.requestId ?? response.headers.get("x-request-id"),
      parsed?.details ?? [],
    );
    if (response.status === 401 && options.globalUnauthorized !== false) unauthorizedHandler?.();
    throw error;
  }
  return text;
}

async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
  const text = await send(method, path, options);
  try {
    // The response shapes are the shared DTO contract owned by the API.
    const data: T = JSON.parse(text);
    return data;
  } catch {
    throw new ApiError(200, "invalid_response", "The API returned an unexpected response.", null, []);
  }
}

/** For endpoints that answer 204 No Content. */
async function requestNoContent(method: Method, path: string, options: RequestOptions = {}): Promise<void> {
  await send(method, path, options);
}

// ---- Types for endpoints not described in the shared DTOs ---------------------------------

export interface SystemStatusDto {
  serverTime: string;
  worker: { lastSeenAt: string | null; healthy: boolean };
  workers: Array<{
    service: string;
    instanceId: string;
    version: string | null;
    startedAt: string;
    lastSeenAt: string;
    details: unknown;
  }>;
  notificationQueue: Partial<Record<NotificationStatus, number>>;
}

export type MetricHistoryResponse = MetricHistoryDto & { nextCursor?: string | null };

export interface CreateHostInput {
  name: string;
  displayName: string | null;
  description: string | null;
  environment: string | null;
}

export type RulePatch = Partial<
  Pick<
    AlertRuleDto,
    | "enabled"
    | "warningThreshold"
    | "criticalThreshold"
    | "warningForSeconds"
    | "criticalForSeconds"
    | "cooldownSeconds"
    | "reminderIntervalSeconds"
    | "notifyWarning"
    | "notifyOnRecovery"
  >
>;

export interface IncidentQuery {
  status?: readonly IncidentStatus[];
  severity?: readonly Severity[];
  hostId?: string | null;
  limit?: number;
  cursor?: string | null;
}

export interface NotificationQuery {
  status?: readonly NotificationStatus[];
  kind?: readonly NotificationKind[];
  limit?: number;
  cursor?: string | null;
}

type Signal = AbortSignal | undefined;

export const api = {
  me: (signal?: Signal) =>
    request<{ user: UserDto }>("GET", "/auth/me", { signal, globalUnauthorized: false }).then((r) => r.user),
  login: (email: string, password: string) =>
    request<{ user: UserDto }>("POST", "/auth/login", {
      body: { email, password },
      globalUnauthorized: false,
    }).then((r) => r.user),
  logout: () => requestNoContent("POST", "/auth/logout", { globalUnauthorized: false }),

  overview: (signal?: Signal) => request<OverviewDto>("GET", "/overview", { signal }),
  systemStatus: (signal?: Signal) => request<SystemStatusDto>("GET", "/system/status", { signal }),

  hosts: (signal?: Signal) =>
    request<{ items: HostSummaryDto[] }>("GET", "/hosts", { signal }).then((r) => r.items),
  host: (id: string, signal?: Signal) =>
    request<HostDetailDto>("GET", `/hosts/${encodeURIComponent(id)}`, { signal }),
  hostMetrics: (
    id: string,
    q: { metrics: readonly MetricName[]; from: string; to: string; limit?: number; cursor?: string | null },
    signal?: Signal,
  ) =>
    request<MetricHistoryResponse>(
      "GET",
      `/hosts/${encodeURIComponent(id)}/metrics${buildQuery({ metrics: q.metrics, from: q.from, to: q.to, limit: q.limit, cursor: q.cursor })}`,
      { signal },
    ),
  createHost: (input: CreateHostInput) => request<CreatedHostDto>("POST", "/hosts", { body: input }),

  incidents: (q: IncidentQuery, signal?: Signal) =>
    request<Page<IncidentDto>>(
      "GET",
      `/incidents${buildQuery({ status: q.status, severity: q.severity, hostId: q.hostId, limit: q.limit, cursor: q.cursor })}`,
      { signal },
    ),
  incident: (id: string, signal?: Signal) =>
    request<IncidentDetailDto>("GET", `/incidents/${encodeURIComponent(id)}`, { signal }),
  acknowledge: (id: string, note: string) =>
    request<IncidentDto>("POST", `/incidents/${encodeURIComponent(id)}/acknowledge`, {
      body: note.trim() ? { note: note.trim() } : {},
    }),

  rules: (signal?: Signal) =>
    request<{ items: AlertRuleDto[] }>("GET", "/alerts/rules", { signal }).then((r) => r.items),
  updateRule: (id: string, patch: RulePatch) =>
    request<AlertRuleDto>("PATCH", `/alerts/rules/${encodeURIComponent(id)}`, { body: patch }),
  sendTest: (recipient: string) =>
    request<{ notificationId: string; status: string }>("POST", "/alerts/test", {
      body: recipient.trim() ? { recipient: recipient.trim() } : {},
    }),

  notifications: (q: NotificationQuery, signal?: Signal) =>
    request<Page<NotificationDto>>(
      "GET",
      `/notifications${buildQuery({ status: q.status, kind: q.kind, limit: q.limit, cursor: q.cursor })}`,
      { signal },
    ),
};
