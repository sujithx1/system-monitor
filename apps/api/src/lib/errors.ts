import type { ApiErrorBody } from "@system-monitor/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AppEnv } from "../context";

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (what = "resource") => new HttpError(404, "not_found", `${what} not found`);

export function errorBody(c: Context<AppEnv>, err: HttpError): ApiErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      requestId: c.get("requestId"),
      ...(err.details ? { details: err.details } : {}),
    },
  };
}

export function validationError(error: z.ZodError): HttpError {
  return new HttpError(
    422,
    "validation_error",
    "Request validation failed",
    error.issues.slice(0, 50).map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  );
}

export async function parseJson<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  const type = c.req.header("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

export function parseQuery<T extends z.ZodType>(c: Context<AppEnv>, schema: T): z.infer<T> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw validationError(result.error);
  return result.data;
}

const uuidSchema = z.uuid();
export function uuidParam(c: Context<AppEnv>, name: string): string {
  const value = c.req.param(name);
  if (!value || !uuidSchema.safeParse(value).success) throw notFound();
  return value;
}

export { pgErrorCode } from "@system-monitor/database";
