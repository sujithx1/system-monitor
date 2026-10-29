export type MetricUnit = "percent" | "bytes" | "milliseconds" | "seconds" | "count" | "boolean" | "load";

export interface MetricDefinition {
  label: string;
  unit: MetricUnit;
  /** What the `resource` dimension identifies for this metric (empty = host-level). */
  resource: "" | "mount" | "postgres" | "http_check" | "container" | "backup";
}

/**
 * Closed catalog of metric names. Agents may only report these names; anything else is
 * rejected at ingestion so that alert rules can rely on known semantics and units.
 */
export const METRICS = {
  "cpu.usage_percent": { label: "CPU usage", unit: "percent", resource: "" },
  "cpu.iowait_percent": { label: "CPU iowait", unit: "percent", resource: "" },
  "cpu.steal_percent": { label: "CPU steal", unit: "percent", resource: "" },
  "cpu.count": { label: "CPU cores", unit: "count", resource: "" },
  "load.1m": { label: "Load average (1m)", unit: "load", resource: "" },
  "load.5m": { label: "Load average (5m)", unit: "load", resource: "" },
  "load.15m": { label: "Load average (15m)", unit: "load", resource: "" },
  "mem.usage_percent": { label: "Memory usage", unit: "percent", resource: "" },
  "mem.total_bytes": { label: "Memory total", unit: "bytes", resource: "" },
  "mem.available_bytes": { label: "Memory available", unit: "bytes", resource: "" },
  "mem.used_bytes": { label: "Memory used", unit: "bytes", resource: "" },
  "swap.usage_percent": { label: "Swap usage", unit: "percent", resource: "" },
  "system.uptime_seconds": { label: "Uptime", unit: "seconds", resource: "" },
  "disk.usage_percent": { label: "Disk usage", unit: "percent", resource: "mount" },
  "disk.total_bytes": { label: "Disk capacity", unit: "bytes", resource: "mount" },
  "disk.used_bytes": { label: "Disk used", unit: "bytes", resource: "mount" },
  "disk.available_bytes": { label: "Disk available", unit: "bytes", resource: "mount" },
  "disk.free_bytes": { label: "Disk free (incl. reserved)", unit: "bytes", resource: "mount" },
  "disk.inode_usage_percent": { label: "Inode usage", unit: "percent", resource: "mount" },
  "disk.inodes_total": { label: "Inodes total", unit: "count", resource: "mount" },
  "disk.inodes_used": { label: "Inodes used", unit: "count", resource: "mount" },
  "pg.up": { label: "PostgreSQL health check", unit: "boolean", resource: "postgres" },
  "pg.latency_ms": { label: "PostgreSQL query latency", unit: "milliseconds", resource: "postgres" },
  "pg.database_size_bytes": { label: "PostgreSQL database size", unit: "bytes", resource: "postgres" },
  "pg.wal_size_bytes": { label: "PostgreSQL WAL size", unit: "bytes", resource: "postgres" },
  "pg.connections_used": { label: "PostgreSQL connections", unit: "count", resource: "postgres" },
  "pg.connections_max": { label: "PostgreSQL max connections", unit: "count", resource: "postgres" },
  "pg.connections_usage_percent": {
    label: "PostgreSQL connection utilization",
    unit: "percent",
    resource: "postgres",
  },
  "pg.replication_lag_seconds": {
    label: "PostgreSQL replication lag",
    unit: "seconds",
    resource: "postgres",
  },
  "pg.archiver_failed_count": { label: "WAL archive failures", unit: "count", resource: "postgres" },
  "pg.archiver_last_archived_age_seconds": {
    label: "Time since last WAL archived",
    unit: "seconds",
    resource: "postgres",
  },
  "backup.age_seconds": { label: "Backup age", unit: "seconds", resource: "backup" },
  "http.up": { label: "HTTP health check", unit: "boolean", resource: "http_check" },
  "http.latency_ms": { label: "HTTP response time", unit: "milliseconds", resource: "http_check" },
  "http.status_code": { label: "HTTP status code", unit: "count", resource: "http_check" },
  "container.running": { label: "Container running", unit: "boolean", resource: "container" },
  "container.healthy": { label: "Container healthy", unit: "boolean", resource: "container" },
} as const satisfies Record<string, MetricDefinition>;

export type MetricName = keyof typeof METRICS;
export const METRIC_NAMES = Object.keys(METRICS) as [MetricName, ...MetricName[]];

export function isMetricName(value: string): value is MetricName {
  return Object.hasOwn(METRICS, value);
}

/** Metrics whose value is 1 (success) or 0 (failure); used by check-failure rules. */
export function isBooleanMetric(name: MetricName): boolean {
  return METRICS[name].unit === "boolean";
}

export function formatMetricValue(name: MetricName, value: number | null): string {
  if (value === null) return "unavailable";
  switch (METRICS[name].unit) {
    case "percent":
      return `${value.toFixed(1)}%`;
    case "bytes":
      return formatBytes(value);
    case "milliseconds":
      return `${Math.round(value)} ms`;
    case "seconds":
      return formatDuration(value);
    case "boolean":
      return value >= 1 ? "up" : "down";
    case "load":
      return value.toFixed(2);
    case "count":
      return String(Math.round(value));
  }
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}
