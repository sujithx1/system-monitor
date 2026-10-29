import { stat } from "node:fs/promises";
import { type MetricSample, sample, unavailable } from "../shared";

/**
 * Backup freshness via a marker file that the backup job touches only after a verified,
 * successful run (e.g. `pg_basebackup ... && touch /var/lib/system-monitor-agent/backup-ok`).
 */
export async function collectBackupMarkers(
  markers: Array<{ name: string; path: string }>,
  now = Date.now(),
): Promise<MetricSample[]> {
  const out: MetricSample[] = [];
  for (const m of markers) {
    try {
      const s = await stat(m.path);
      out.push(sample("backup.age_seconds", Math.max(0, Math.floor((now - s.mtimeMs) / 1000)), m.name));
    } catch (error) {
      out.push(unavailable("backup.age_seconds", error, m.name));
    }
  }
  return out;
}
