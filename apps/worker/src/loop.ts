import type { Logger } from "@system-monitor/shared";

/** Fixed-interval task runner that never overlaps itself and can be drained on shutdown. */
export class Loop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    readonly name: string,
    private readonly intervalMs: number,
    private readonly task: () => Promise<void>,
    private readonly log: Logger,
  ) {}

  start(initialDelayMs = 0): void {
    this.timer = setTimeout(() => this.tick(), initialDelayMs);
  }

  private tick(): void {
    if (this.stopped) return;
    const started = Date.now();
    this.running = this.task()
      .catch((error) => this.log.error(`${this.name} loop failed`, { error }))
      .finally(() => {
        this.running = null;
        if (!this.stopped)
          this.timer = setTimeout(() => this.tick(), Math.max(0, this.intervalMs - (Date.now() - started)));
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
