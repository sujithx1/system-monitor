/** Container health check: the worker touches this file after every evaluation cycle. */
import { stat } from "node:fs/promises";

const file = process.env.WORKER_HEALTH_FILE ?? "/tmp/system-monitor-worker.health";
const maxAgeMs = Number(process.env.WORKER_HEALTH_MAX_AGE_MS ?? 90_000);
try {
  const s = await stat(file);
  process.exit(Date.now() - s.mtimeMs <= maxAgeMs ? 0 : 1);
} catch {
  process.exit(1);
}
