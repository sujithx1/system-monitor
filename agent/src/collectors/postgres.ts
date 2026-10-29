import { SQL } from "bun";
import type { PgTargetConfig } from "../config";
import { type MetricSample, sample, unavailable } from "../shared";
import { round } from "./cpu";
import { withTimeout } from "./timeout";

/** Minimal read-only session so the checks can be tested without a server. */
export interface PgSession {
  query(text: string): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}
export type PgConnector = (url: string, timeoutMs: number) => PgSession;

/** A fresh connection per cycle: this also verifies authentication and new-connection capacity. */
export const bunPgConnector: PgConnector = (url, timeoutMs) => {
  const sql = new SQL(url, {
    max: 1,
    idleTimeout: 1,
    connectionTimeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    connection: { application_name: "system-monitor-agent" },
  });
  return {
    query: async (text) => (await sql.unsafe(text)) as Array<Record<string, unknown>>,
    close: () => sql.close({ timeout: 1 }),
  };
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const STATS_SQL = `
SELECT pg_database_size(current_database())::bigint AS db_size,
       current_setting('max_connections')::int AS max_conn,
       (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend')::int AS used_conn`;
const WAL_SQL = "SELECT coalesce(sum(size), 0)::bigint AS wal_bytes FROM pg_ls_waldir()";
const ARCHIVER_SQL = `
SELECT current_setting('archive_mode') AS archive_mode, failed_count::bigint AS failed_count,
       extract(epoch FROM now() - last_archived_time)::float8 AS last_archived_age
FROM pg_stat_archiver`;
const REPLICATION_SQL = `
SELECT CASE WHEN pg_is_in_recovery()
            THEN coalesce(extract(epoch FROM now() - pg_last_xact_replay_timestamp()), 0)
            ELSE (SELECT coalesce(max(extract(epoch FROM replay_lag)), 0) FROM pg_stat_replication)
       END::float8 AS lag_seconds`;

export async function checkPostgres(
  target: PgTargetConfig,
  options: { timeoutMs: number; replication: boolean },
  connect: PgConnector = bunPgConnector,
): Promise<MetricSample[]> {
  const r = target.name;
  const session = connect(target.url, options.timeoutMs);
  const q = (text: string, what: string) =>
    withTimeout(session.query(text), options.timeoutMs, what, () => void session.close().catch(() => {}));
  const out: MetricSample[] = [];
  try {
    const started = performance.now();
    try {
      const rows = await q("SELECT 1 AS ok", "postgres health query");
      if (num(rows[0]?.ok) !== 1) throw new Error("unexpected result from SELECT 1");
    } catch (error) {
      // A failed check is a real observation (down), unlike a metric we could not measure.
      out.push(
        { ...sample("pg.up", 0, r), error: unavailable("pg.up", error).error },
        unavailable("pg.latency_ms", "health query failed", r),
      );
      return out;
    }
    out.push(sample("pg.up", 1, r), sample("pg.latency_ms", round(performance.now() - started), r));

    try {
      const [row] = await q(STATS_SQL, "postgres stats query");
      const size = num(row?.db_size);
      const max = num(row?.max_conn);
      const used = num(row?.used_conn);
      if (size === null || max === null || used === null || max <= 0) throw new Error("incomplete stats row");
      out.push(
        sample("pg.database_size_bytes", size, r),
        sample("pg.connections_used", used, r),
        sample("pg.connections_max", max, r),
        sample("pg.connections_usage_percent", round(Math.min(100, (used / max) * 100)), r),
      );
    } catch (error) {
      out.push(
        unavailable("pg.database_size_bytes", error, r),
        unavailable("pg.connections_usage_percent", error, r),
      );
    }

    try {
      const [row] = await q(WAL_SQL, "postgres WAL query");
      const wal = num(row?.wal_bytes);
      if (wal === null) throw new Error("no WAL size returned");
      out.push(sample("pg.wal_size_bytes", wal, r));
    } catch (error) {
      // Typically "permission denied for function pg_ls_waldir": grant pg_monitor to the role.
      out.push(unavailable("pg.wal_size_bytes", error, r));
    }

    try {
      const [row] = await q(ARCHIVER_SQL, "postgres archiver query");
      if (row && row.archive_mode !== "off") {
        const failed = num(row.failed_count);
        const age = num(row.last_archived_age);
        if (failed !== null) out.push(sample("pg.archiver_failed_count", failed, r));
        out.push(
          age === null
            ? unavailable("pg.archiver_last_archived_age_seconds", "no WAL archived yet", r)
            : sample("pg.archiver_last_archived_age_seconds", Math.max(0, round(age)), r),
        );
      }
    } catch (error) {
      out.push(unavailable("pg.archiver_failed_count", error, r));
    }

    if (options.replication) {
      try {
        const [row] = await q(REPLICATION_SQL, "postgres replication query");
        const lag = num(row?.lag_seconds);
        if (lag === null) throw new Error("no replication lag returned");
        out.push(sample("pg.replication_lag_seconds", Math.max(0, round(lag)), r));
      } catch (error) {
        out.push(unavailable("pg.replication_lag_seconds", error, r));
      }
    }
    return out;
  } finally {
    await session.close().catch(() => {});
  }
}
