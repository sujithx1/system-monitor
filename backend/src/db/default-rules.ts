import type { CreateRuleInput } from "../shared";

type DefaultRule = Pick<
  CreateRuleInput,
  "name" | "kind" | "metric" | "warningThreshold" | "criticalThreshold"
> &
  Partial<CreateRuleInput>;

/** Rules seeded on first deployment. Every value can be changed later via the API/dashboard. */
export const DEFAULT_RULES: DefaultRule[] = [
  {
    name: "CPU usage",
    kind: "threshold",
    metric: "cpu.usage_percent",
    warningThreshold: 85,
    warningForSeconds: 300,
    criticalThreshold: 95,
    criticalForSeconds: 180,
    suggestedAction: "Check top processes (top/htop), recent deploys and runaway jobs.",
  },
  {
    name: "Memory usage",
    kind: "threshold",
    metric: "mem.usage_percent",
    warningThreshold: 85,
    warningForSeconds: 300,
    criticalThreshold: 95,
    criticalForSeconds: 180,
    suggestedAction: "Check memory-heavy processes and OOM-killer activity (dmesg).",
  },
  {
    name: "Disk usage",
    kind: "threshold",
    metric: "disk.usage_percent",
    warningThreshold: 85,
    criticalThreshold: 95,
    suggestedAction: "Free space on the mount: old logs, backups, docker images. Do not delete WAL files.",
  },
  {
    name: "Inode usage",
    kind: "threshold",
    metric: "disk.inode_usage_percent",
    warningThreshold: 85,
    criticalThreshold: 95,
    suggestedAction: "Find directories with many small files (sessions, caches, mail queues).",
  },
  {
    name: "PostgreSQL health",
    kind: "check_failures",
    metric: "pg.up",
    warningThreshold: 2,
    criticalThreshold: 2,
    windowSamples: 10,
    reminderIntervalSeconds: 900,
    suggestedAction: "Check postgresql service status, logs and disk space on the data/WAL mount.",
  },
  {
    name: "API availability",
    kind: "check_failures",
    metric: "http.up",
    warningThreshold: 2,
    criticalThreshold: 3,
    windowSamples: 10,
    reminderIntervalSeconds: 900,
    suggestedAction: "Check the application service, reverse proxy and recent deploys.",
  },
  {
    name: "Agent heartbeat",
    kind: "heartbeat",
    metric: null,
    warningThreshold: 90,
    criticalThreshold: 180,
    reminderIntervalSeconds: 900,
    suggestedAction:
      "Host may be down or unreachable. Check the VM console, network and system-monitor-agent service.",
  },
  {
    name: "PostgreSQL connection utilization",
    kind: "threshold",
    metric: "pg.connections_usage_percent",
    warningThreshold: 80,
    warningForSeconds: 60,
    criticalThreshold: 95,
    criticalForSeconds: 60,
    suggestedAction: "Look for connection leaks and idle-in-transaction sessions; consider a pooler.",
  },
];
