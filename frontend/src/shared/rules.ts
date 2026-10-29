export const SEVERITIES = ["warning", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const INCIDENT_STATUSES = ["pending", "firing", "acknowledged", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const ACTIVE_INCIDENT_STATUSES = ["pending", "firing", "acknowledged"] as const;

/**
 * threshold       – compare the metric value with warning/critical thresholds; each level must hold
 *                   continuously for its `*ForSeconds` duration before the incident fires.
 * check_failures  – for 0/1 check metrics (pg.up, http.up, …): critical after `criticalThreshold`
 *                   consecutive failed checks, warning after `warningThreshold` failures within the
 *                   last `windowSamples` checks ("repeated failures").
 * heartbeat       – seconds since the host's last heartbeat as observed by the monitoring server.
 */
export const RULE_KINDS = ["threshold", "check_failures", "heartbeat"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const COMPARATORS = ["gt", "gte", "lt", "lte"] as const;
export type Comparator = (typeof COMPARATORS)[number];
