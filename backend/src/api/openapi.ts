import { z } from "zod";
import { createRuleSchema, heartbeatSchema, metricSnapshotSchema, updateRuleSchema } from "../shared";
import { loginSchema } from "./routes/auth";
import { agentNameSchema, createHostSchema, updateHostSchema } from "./routes/hosts";
import { ackSchema } from "./routes/incidents";
import { testSchema } from "./routes/rules";

type Auth = "none" | "agent" | "viewer" | "operator" | "admin" | "webhook";
interface RouteDoc {
  method: "get" | "post" | "patch";
  path: string;
  summary: string;
  auth: Auth;
  body?: z.ZodType;
  query?: Record<string, string>;
  success: { status: number; description: string };
}

const ROUTES: RouteDoc[] = [
  {
    method: "get",
    path: "/health",
    summary: "Process liveness",
    auth: "none",
    success: { status: 200, description: "API process is running" },
  },
  {
    method: "get",
    path: "/ready",
    summary: "Readiness incl. monitoring database",
    auth: "none",
    success: { status: 200, description: "Ready (503 when the database is unavailable)" },
  },
  {
    method: "post",
    path: "/api/v1/auth/login",
    summary: "Dashboard login (sets HttpOnly session cookie)",
    auth: "none",
    body: loginSchema,
    success: { status: 200, description: "Logged in" },
  },
  {
    method: "post",
    path: "/api/v1/auth/logout",
    summary: "End the current session",
    auth: "none",
    success: { status: 204, description: "Logged out" },
  },
  {
    method: "get",
    path: "/api/v1/auth/me",
    summary: "Current user",
    auth: "viewer",
    success: { status: 200, description: "UserDto" },
  },
  {
    method: "post",
    path: "/api/v1/agents/heartbeat",
    summary: "Agent heartbeat",
    auth: "agent",
    body: heartbeatSchema,
    success: { status: 200, description: "Accepted" },
  },
  {
    method: "post",
    path: "/api/v1/metrics",
    summary: "Submit a metric snapshot (idempotent per snapshotId)",
    auth: "agent",
    body: metricSnapshotSchema,
    success: { status: 202, description: "Stored (200 with duplicate=true for a re-sent snapshot)" },
  },
  {
    method: "get",
    path: "/api/v1/overview",
    summary: "Infrastructure health summary",
    auth: "viewer",
    success: { status: 200, description: "OverviewDto" },
  },
  {
    method: "get",
    path: "/api/v1/system/status",
    summary: "Worker liveness and notification queue",
    auth: "viewer",
    success: { status: 200, description: "System status" },
  },
  {
    method: "get",
    path: "/api/v1/hosts",
    summary: "List monitored hosts with health",
    auth: "viewer",
    success: { status: 200, description: "{ items: HostSummaryDto[] }" },
  },
  {
    method: "post",
    path: "/api/v1/hosts",
    summary: "Register a host and issue its first agent token",
    auth: "admin",
    body: createHostSchema,
    success: { status: 201, description: "CreatedHostDto (token shown once)" },
  },
  {
    method: "get",
    path: "/api/v1/hosts/{id}",
    summary: "Host details, latest metrics, agents, incidents",
    auth: "viewer",
    success: { status: 200, description: "HostDetailDto" },
  },
  {
    method: "patch",
    path: "/api/v1/hosts/{id}",
    summary: "Update host metadata / enable / disable",
    auth: "admin",
    body: updateHostSchema,
    success: { status: 200, description: "HostSummaryDto" },
  },
  {
    method: "get",
    path: "/api/v1/hosts/{id}/metrics",
    summary: "Historical metrics (raw or bucketed)",
    auth: "viewer",
    query: {
      metrics: "Comma-separated metric names",
      resource: "Filter by resource (mount, check name, …)",
      from: "ISO timestamp (default: 1h before `to`)",
      to: "ISO timestamp (default: now)",
      step: "Bucket seconds; 0 = raw samples (paginated with `cursor`)",
      limit: "Raw mode page size (max 5000)",
      cursor: "Opaque cursor from `nextCursor`",
    },
    success: { status: 200, description: "MetricHistoryDto" },
  },
  {
    method: "post",
    path: "/api/v1/hosts/{id}/agents",
    summary: "Issue an additional agent credential",
    auth: "admin",
    body: agentNameSchema,
    success: { status: 201, description: "Agent and token (shown once)" },
  },
  {
    method: "post",
    path: "/api/v1/agents/{id}/revoke",
    summary: "Revoke an agent credential",
    auth: "admin",
    success: { status: 200, description: "AgentDto" },
  },
  {
    method: "get",
    path: "/api/v1/incidents",
    summary: "List incidents (keyset pagination)",
    auth: "viewer",
    query: {
      status: "Comma-separated statuses",
      severity: "warning,critical",
      hostId: "UUID",
      ruleId: "UUID",
      limit: "1..200",
      cursor: "Opaque cursor",
    },
    success: { status: 200, description: "Page<IncidentDto>" },
  },
  {
    method: "get",
    path: "/api/v1/incidents/{id}",
    summary: "Incident details incl. notifications",
    auth: "viewer",
    success: { status: 200, description: "IncidentDetailDto" },
  },
  {
    method: "post",
    path: "/api/v1/incidents/{id}/acknowledge",
    summary: "Acknowledge a firing incident",
    auth: "operator",
    body: ackSchema,
    success: { status: 200, description: "IncidentDto" },
  },
  {
    method: "get",
    path: "/api/v1/alerts/rules",
    summary: "List alert rules",
    auth: "viewer",
    success: { status: 200, description: "{ items: AlertRuleDto[] }" },
  },
  {
    method: "post",
    path: "/api/v1/alerts/rules",
    summary: "Create an alert rule",
    auth: "admin",
    body: createRuleSchema,
    success: { status: 201, description: "AlertRuleDto" },
  },
  {
    method: "patch",
    path: "/api/v1/alerts/rules/{id}",
    summary: "Update an alert rule",
    auth: "admin",
    body: updateRuleSchema,
    success: { status: 200, description: "AlertRuleDto" },
  },
  {
    method: "post",
    path: "/api/v1/alerts/test",
    summary: "Queue a WhatsApp test message to an authorized recipient",
    auth: "admin",
    body: testSchema,
    success: { status: 202, description: "Queued" },
  },
  {
    method: "get",
    path: "/api/v1/notifications",
    summary: "Notification delivery history",
    auth: "viewer",
    query: {
      status: "Comma-separated statuses",
      kind: "Comma-separated kinds",
      incidentId: "UUID",
      limit: "1..200",
      cursor: "Opaque cursor",
    },
    success: { status: 200, description: "Page<NotificationDto>" },
  },
  {
    method: "get",
    path: "/api/v1/webhooks/whatsapp",
    summary: "Meta webhook verification handshake",
    auth: "none",
    success: { status: 200, description: "Echoes hub.challenge" },
  },
  {
    method: "post",
    path: "/api/v1/webhooks/whatsapp",
    summary: "WhatsApp delivery status webhook (X-Hub-Signature-256)",
    auth: "webhook",
    success: { status: 200, description: "Received" },
  },
];

const SECURITY: Record<Auth, Array<Record<string, string[]>> | undefined> = {
  none: [],
  agent: [{ agentToken: [] }],
  viewer: [{ session: [] }],
  operator: [{ session: [] }],
  admin: [{ session: [] }],
  webhook: [{ webhookSignature: [] }],
};

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const params = [
      ...[...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      })),
      ...Object.entries(r.query ?? {}).map(([name, description]) => ({
        name,
        in: "query",
        required: false,
        description,
        schema: { type: "string" },
      })),
    ];
    paths[r.path] ??= {};
    (paths[r.path] as Record<string, unknown>)[r.method] = {
      summary: r.summary,
      description:
        r.auth === "none" || r.auth === "agent" || r.auth === "webhook"
          ? undefined
          : `Requires role: ${r.auth}`,
      security: SECURITY[r.auth],
      parameters: params.length > 0 ? params : undefined,
      requestBody: r.body
        ? {
            required: true,
            content: {
              "application/json": {
                schema: z.toJSONSchema(r.body, {
                  io: "input",
                  unrepresentable: "any",
                  target: "openapi-3.0",
                }),
              },
            },
          }
        : undefined,
      responses: {
        [String(r.success.status)]: { description: r.success.description },
        default: {
          description: "Error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: {
      title: "System Monitor API",
      version: "1.0.0",
      description:
        "Monitoring API for agents (bearer agent tokens) and the dashboard (session cookie). All errors use the Error schema.",
    },
    paths,
    components: {
      securitySchemes: {
        agentToken: { type: "http", scheme: "bearer", description: "Per-agent token (ima_…)" },
        session: { type: "apiKey", in: "cookie", name: "__Host-im_session" },
        webhookSignature: { type: "apiKey", in: "header", name: "X-Hub-Signature-256" },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                requestId: { type: "string" },
                details: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { path: { type: "string" }, message: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}
