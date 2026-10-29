import { z } from "zod";
import { HttpError } from "./errors";

/** Opaque keyset cursor: (timestamp, id) of the last item on the previous page. */
export interface Cursor {
  t: string;
  id: string;
}

const cursorSchema = z.object({ t: z.iso.datetime({ offset: true }), id: z.uuid() }).strict();

export function encodeCursor(t: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: t.toISOString(), id })).toString("base64url");
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw new HttpError(400, "invalid_cursor", "cursor is invalid");
  }
}

export const pageQuery = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
};

/** Fetch limit+1 rows, then call this to split off the page and compute the next cursor. */
export function toPage<T>(rows: T[], limit: number, key: (row: T) => { t: Date; id: string }) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(key(last).t, key(last).id) : null,
  };
}

export const csvList = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(item).max(50).optional());
