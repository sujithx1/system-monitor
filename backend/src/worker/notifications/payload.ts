import type { NotificationPayload } from "../../db";
import { formatDuration, type NotificationKind, type Severity } from "../../shared";

export function formatTimestamp(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date);
}

export function buildIncidentPayload(input: {
  kind: NotificationKind;
  severity: Severity;
  hostLabel: string;
  service: string;
  incidentId: string;
  detectedAt: Date;
  summary: string;
  suggestedAction: string | null;
  now: Date;
  timeZone: string;
}): NotificationPayload {
  const sev = input.severity.toUpperCase();
  const severityLabel = {
    firing: sev,
    severity_increase: `${sev} (escalated from WARNING)`,
    reminder: `${sev} (reminder, still unresolved)`,
    escalation: `${sev} (escalation, unacknowledged)`,
    recovery: "RESOLVED",
    test: "TEST",
  }[input.kind];
  const details =
    input.kind === "recovery"
      ? `Recovered after ${formatDuration((input.now.getTime() - input.detectedAt.getTime()) / 1000)}. Was: ${input.summary}`
      : input.summary;
  return {
    severityLabel,
    host: input.hostLabel,
    service: input.service,
    incidentId: input.incidentId,
    detectedAt: formatTimestamp(input.detectedAt, input.timeZone),
    details,
    suggestedAction:
      input.kind === "recovery"
        ? "No action required."
        : (input.suggestedAction ?? "Investigate on the monitoring dashboard."),
  };
}
