import { describe, expect, test } from "bun:test";
import { checkHttp } from "../../src/collectors/http";
import { checkPostgres, type PgConnector } from "../../src/collectors/postgres";

const target = { name: "main", url: "postgres://monitor:secret@db:5432/app" };

function fakePg(responses: Record<string, Array<Record<string, unknown>> | Error | "hang">) {
  let closed = 0;
  const connect: PgConnector = () => ({
    query: async (text: string) => {
      const key = Object.keys(responses).find((k) => text.includes(k));
      const r = key ? responses[key] : [];
      if (r === "hang") return new Promise<never>(() => {});
      if (r instanceof Error) throw r;
      return r ?? [];
    },
    close: async () => {
      closed++;
    },
  });
  return { connect, closed: () => closed };
}

describe("PostgreSQL health check", () => {
  test("authenticated SELECT 1 plus size, connections and WAL", async () => {
    const pg = fakePg({
      "SELECT 1": [{ ok: 1 }],
      pg_database_size: [{ db_size: "8517299", max_conn: 100, used_conn: 42 }],
      pg_ls_waldir: [{ wal_bytes: "167772160" }],
      pg_stat_archiver: [{ archive_mode: "off" }],
    });
    const out = await checkPostgres(target, { timeoutMs: 1000, replication: false }, pg.connect);
    const get = (n: string) => out.find((s) => s.name === n);
    expect(get("pg.up")?.value).toBe(1);
    expect(get("pg.latency_ms")?.status).toBe("ok");
    expect(get("pg.database_size_bytes")?.value).toBe(8517299);
    expect(get("pg.connections_usage_percent")?.value).toBe(42);
    expect(get("pg.wal_size_bytes")?.value).toBe(167772160);
    expect(out.every((s) => s.resource === "main")).toBe(true);
    expect(pg.closed()).toBeGreaterThan(0);
  });

  test("failed connection is pg.up=0 with the error; latency is unavailable, not 0", async () => {
    const out = await checkPostgres(
      target,
      { timeoutMs: 1000, replication: false },
      fakePg({ "SELECT 1": new Error('password authentication failed for user "monitor"') }).connect,
    );
    expect(out.find((s) => s.name === "pg.up")).toMatchObject({ value: 0, status: "ok" });
    expect(out.find((s) => s.name === "pg.up")?.error).toContain("authentication failed");
    expect(out.find((s) => s.name === "pg.latency_ms")).toMatchObject({ status: "unavailable", value: null });
    expect(out.some((s) => s.name === "pg.database_size_bytes")).toBe(false);
  });

  test("a hanging server times out instead of blocking the cycle", async () => {
    const started = Date.now();
    const out = await checkPostgres(
      target,
      { timeoutMs: 100, replication: false },
      fakePg({ "SELECT 1": "hang" }).connect,
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out.find((s) => s.name === "pg.up")?.value).toBe(0);
    expect(out.find((s) => s.name === "pg.up")?.error).toContain("timed out");
  });

  test("missing pg_monitor privilege makes WAL size unavailable but keeps other metrics", async () => {
    const out = await checkPostgres(
      target,
      { timeoutMs: 1000, replication: true },
      fakePg({
        "SELECT 1": [{ ok: 1 }],
        pg_database_size: [{ db_size: 1, max_conn: 10, used_conn: 1 }],
        pg_ls_waldir: new Error("permission denied for function pg_ls_waldir"),
        pg_stat_archiver: [{ archive_mode: "on", failed_count: "2", last_archived_age: 30.5 }],
        pg_is_in_recovery: [{ lag_seconds: 1.25 }],
      }).connect,
    );
    expect(out.find((s) => s.name === "pg.wal_size_bytes")).toMatchObject({ status: "unavailable" });
    expect(out.find((s) => s.name === "pg.archiver_failed_count")?.value).toBe(2);
    expect(out.find((s) => s.name === "pg.replication_lag_seconds")?.value).toBe(1.25);
  });
});

describe("HTTP health check", () => {
  const check = { name: "app", url: "https://app.internal/health", timeoutMs: 200 };

  test("2xx is up with latency and status code", async () => {
    const out = await checkHttp(
      check,
      "test",
      (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
    );
    expect(out.map((s) => [s.name, s.value])).toEqual([
      ["http.up", 1],
      ["http.latency_ms", expect.any(Number)],
      ["http.status_code", 200],
    ]);
  });

  test("unexpected status is down", async () => {
    const out = await checkHttp(
      check,
      "test",
      (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
    );
    expect(out[0]).toMatchObject({ name: "http.up", value: 0, error: "unexpected HTTP status 503" });
  });

  test("custom expected status list", async () => {
    const out = await checkHttp(
      { ...check, expectedStatus: [401] },
      "t",
      (async () => new Response("", { status: 401 })) as unknown as typeof fetch,
    );
    expect(out[0]?.value).toBe(1);
  });

  test("network failure is down; latency unavailable", async () => {
    const out = await checkHttp(check, "t", (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch);
    expect(out[0]).toMatchObject({ name: "http.up", value: 0 });
    expect(out[1]).toMatchObject({ name: "http.latency_ms", status: "unavailable", value: null });
  });
});
