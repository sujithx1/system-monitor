import { describe, expect, test } from "bun:test";
import { type MetricSnapshot, silentLogger } from "@system-monitor/shared";
import { MonitorClient, SnapshotSender } from "../../apps/agent/src/sender";

const snap = (n: number): MetricSnapshot => ({
  snapshotId: crypto.randomUUID(),
  agentVersion: "1.0.0",
  hostname: "h",
  collectedAt: new Date(n * 1000).toISOString(),
  metrics: [{ name: "cpu.usage_percent", resource: "", status: "ok", value: n }],
});

function server(statuses: Array<number | "down">) {
  const received: MetricSnapshot[] = [];
  const headers: Headers[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const next = statuses.shift() ?? 202;
    if (next === "down") throw new TypeError("ECONNREFUSED");
    received.push(JSON.parse(String(init?.body)));
    headers.push(new Headers(init?.headers));
    return new Response(null, { status: next });
  }) as unknown as typeof fetch;
  const client = new MonitorClient(
    { baseUrl: "https://monitor.test", token: "ima_secret", timeoutMs: 1000 },
    fetchImpl,
  );
  return { client, received, headers };
}

describe("agent snapshot sender", () => {
  test("sends with the bearer token and drains the queue in order", async () => {
    const s = server([202, 202]);
    const sender = new SnapshotSender(s.client, 10, silentLogger);
    sender.enqueue(snap(1));
    sender.enqueue(snap(2));
    await sender.flush();
    expect(s.received.map((r) => r.metrics[0]?.value)).toEqual([1, 2]);
    expect(s.headers[0]?.get("authorization")).toBe("Bearer ima_secret");
    expect(sender.pending).toBe(0);
  });

  test("keeps snapshots while the server is unreachable or failing, then replays oldest first", async () => {
    const s = server(["down", 503, 202, 202, 202]);
    const sender = new SnapshotSender(s.client, 10, silentLogger);
    sender.enqueue(snap(1));
    await sender.flush(); // network down
    sender.enqueue(snap(2));
    await sender.flush(); // 503
    expect(sender.pending).toBe(2);
    sender.enqueue(snap(3));
    await sender.flush();
    expect(sender.pending).toBe(0);
    expect(s.received.slice(-3).map((r) => r.metrics[0]?.value)).toEqual([1, 2, 3]);
  });

  test("drops permanently rejected snapshots (stale/invalid) instead of retrying forever", async () => {
    const s = server([422, 202]);
    const sender = new SnapshotSender(s.client, 10, silentLogger);
    sender.enqueue(snap(1));
    sender.enqueue(snap(2));
    await sender.flush();
    expect(sender.pending).toBe(0);
  });

  test("keeps data on 401 (e.g. token being rotated) and bounds memory", async () => {
    const s = server([401]);
    const sender = new SnapshotSender(s.client, 3, silentLogger);
    for (let i = 1; i <= 5; i++) sender.enqueue(snap(i));
    expect(sender.pending).toBe(3); // oldest two dropped
    await sender.flush();
    expect(sender.pending).toBe(3);
    expect(s.received[0]?.metrics[0]?.value).toBe(3);
  });
});
