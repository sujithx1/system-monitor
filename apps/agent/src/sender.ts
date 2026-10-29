import type { Logger, MetricSnapshot } from "@system-monitor/shared";

export interface SendResult {
  status: number;
}

/** Thin HTTPS client for the monitoring API with per-request timeouts. */
export class MonitorClient {
  constructor(
    private readonly options: { baseUrl: string; token: string; timeoutMs: number; ca?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async post(path: string, body: unknown): Promise<SendResult> {
    const init: RequestInit & { tls?: { ca: string } } = {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        "user-agent": "system-monitor-agent",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs),
      redirect: "error",
    };
    if (this.options.ca) init.tls = { ca: this.options.ca };
    const res = await this.fetchImpl(`${this.options.baseUrl}${path}`, init);
    await res.body?.cancel().catch(() => {});
    return { status: res.status };
  }
}

/**
 * Bounded FIFO of snapshots that could not be delivered yet (monitoring server down or
 * unreachable). Oldest snapshots are dropped first; the server also rejects stale ones.
 */
export class SnapshotSender {
  private readonly queue: MetricSnapshot[] = [];
  private flushing = false;

  constructor(
    private readonly client: MonitorClient,
    private readonly maxBuffer: number,
    private readonly log: Logger,
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  enqueue(snapshot: MetricSnapshot): void {
    this.queue.push(snapshot);
    while (this.queue.length > Math.max(1, this.maxBuffer)) {
      const dropped = this.queue.shift();
      this.log.warn("snapshot buffer full, dropping oldest snapshot", { snapshotId: dropped?.snapshotId });
    }
  }

  /** Sends queued snapshots oldest-first; stops at the first transient failure. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue[0];
        if (!next) break;
        let status: number;
        try {
          ({ status } = await this.client.post("/api/v1/metrics", next));
        } catch (error) {
          this.log.warn("metrics push failed; will retry", { error, pending: this.queue.length });
          return;
        }
        if (status >= 200 && status < 300) {
          this.queue.shift();
        } else if (status === 400 || status === 409 || status === 413 || status === 422) {
          // Permanent rejection (invalid or stale): retrying the same payload cannot succeed.
          this.queue.shift();
          this.log.error("monitoring server rejected snapshot", { status, snapshotId: next.snapshotId });
        } else {
          if (status === 401 || status === 403) {
            this.log.error("monitoring server rejected agent credentials", { status });
          } else {
            this.log.warn("metrics push failed; will retry", { status, pending: this.queue.length });
          }
          return;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
