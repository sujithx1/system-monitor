import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Anything that can run queries: the pooled database or an open transaction. */
export type Executor = Database | Transaction;

export interface DatabaseHandle {
  db: Database;
  close: (timeoutSeconds?: number) => Promise<void>;
  ping: (timeoutMs?: number) => Promise<void>;
}

export function createDatabase(
  url: string,
  options: { poolMax?: number; applicationName?: string; statementTimeoutMs?: number } = {},
): DatabaseHandle {
  const client = postgres(url, {
    max: options.poolMax ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    max_lifetime: 60 * 30,
    prepare: true,
    onnotice: () => {},
    connection: {
      application_name: options.applicationName ?? "system-monitor",
      statement_timeout: options.statementTimeoutMs ?? 30_000,
    },
  });
  const db = drizzle(client, { schema, casing: "snake_case" });
  return {
    db,
    close: (timeoutSeconds = 5) => client.end({ timeout: timeoutSeconds }),
    ping: async (timeoutMs = 2000) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client`select 1`,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("database ping timed out")), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Postgres error codes surfaced by postgres.js, possibly wrapped by Drizzle. */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let i = 0; i < 3 && current; i++) {
    if (typeof current === "object" && current !== null && "code" in current) {
      const code = (current as { code: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
