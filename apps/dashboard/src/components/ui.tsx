import type {
  HostHealth,
  IncidentStatus,
  NotificationKind,
  NotificationStatus,
  Severity,
} from "@system-monitor/shared";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ApiError } from "../lib/api";
import { formatDateTime, formatRelative } from "../lib/format";
import { REFRESH_INTERVAL_MS, useRefresh } from "../lib/refresh";

// ---- Status badges: every tone carries an icon and a text label, never color alone ---------

export type Tone = "good" | "warning" | "serious" | "critical" | "info" | "neutral";

interface BadgeSpec {
  tone: Tone;
  icon: string;
  label: string;
}

export function Badge({
  tone,
  icon,
  children,
  title,
}: {
  tone: Tone;
  icon: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      <span className="badge-icon" aria-hidden="true">
        {icon}
      </span>
      {children}
    </span>
  );
}

const HEALTH: Record<HostHealth, BadgeSpec> = {
  healthy: { tone: "good", icon: "✓", label: "Healthy" },
  warning: { tone: "warning", icon: "▲", label: "Warning" },
  critical: { tone: "critical", icon: "✕", label: "Critical" },
  offline: { tone: "serious", icon: "⊘", label: "Offline" },
  unknown: { tone: "neutral", icon: "?", label: "Unknown" },
  disabled: { tone: "neutral", icon: "–", label: "Disabled" },
};

export function HealthBadge({ health }: { health: HostHealth }) {
  const spec = HEALTH[health];
  return (
    <Badge tone={spec.tone} icon={spec.icon}>
      {spec.label}
    </Badge>
  );
}

const SEVERITY: Record<Severity, BadgeSpec> = {
  warning: { tone: "warning", icon: "▲", label: "Warning" },
  critical: { tone: "critical", icon: "✕", label: "Critical" },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const spec = SEVERITY[severity];
  return (
    <Badge tone={spec.tone} icon={spec.icon}>
      {spec.label}
    </Badge>
  );
}

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, BadgeSpec> = {
  pending: { tone: "info", icon: "◷", label: "Pending" },
  firing: { tone: "critical", icon: "●", label: "Firing" },
  acknowledged: { tone: "neutral", icon: "◉", label: "Acknowledged" },
  resolved: { tone: "good", icon: "✓", label: "Resolved" },
};

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  const spec = INCIDENT_STATUS_LABELS[status];
  return (
    <Badge tone={spec.tone} icon={spec.icon}>
      {spec.label}
    </Badge>
  );
}

export const NOTIFICATION_STATUS_LABELS: Record<NotificationStatus, BadgeSpec> = {
  queued: { tone: "neutral", icon: "◷", label: "Queued" },
  sending: { tone: "info", icon: "↻", label: "Sending" },
  retrying: { tone: "warning", icon: "↻", label: "Retrying" },
  accepted: { tone: "info", icon: "→", label: "Accepted" },
  sent: { tone: "good", icon: "✓", label: "Sent" },
  delivered: { tone: "good", icon: "✓", label: "Delivered" },
  read: { tone: "good", icon: "✓", label: "Read" },
  failed: { tone: "critical", icon: "✕", label: "Failed" },
  cancelled: { tone: "neutral", icon: "–", label: "Cancelled" },
};

export function NotificationStatusBadge({ status }: { status: NotificationStatus }) {
  const spec = NOTIFICATION_STATUS_LABELS[status];
  return (
    <Badge tone={spec.tone} icon={spec.icon}>
      {spec.label}
    </Badge>
  );
}

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  firing: "Firing",
  severity_increase: "Severity increase",
  reminder: "Reminder",
  escalation: "Escalation",
  recovery: "Recovery",
  test: "Test",
};

// ---- Loading / error / empty states ------------------------------------------------------

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state state-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function ErrorBox({
  error,
  title = "Something went wrong",
  onRetry,
  compact = false,
}: {
  error: ApiError;
  title?: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={`state state-error${compact ? " state-compact" : ""}`} role="alert">
      <div className="state-title">
        <span aria-hidden="true">✕ </span>
        {title}
      </div>
      <p className="state-message">{error.message}</p>
      {error.details.length > 0 && (
        <ul className="error-details">
          {error.details.map((d) => (
            <li key={`${d.path}:${d.message}`}>
              {d.path ? <code>{d.path}</code> : null}
              {d.path ? ": " : null}
              {d.message}
            </li>
          ))}
        </ul>
      )}
      {(error.requestId || onRetry) && (
        <div className="state-footer">
          {error.requestId ? <span className="muted small">Request ID: {error.requestId}</span> : null}
          {onRetry ? (
            <button type="button" className="btn btn-small" onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Shown above data that is still displayed after a background refresh failed. */
export function StaleWarning({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div className="stale-warning" role="status">
      <span aria-hidden="true">▲</span>
      <span>Refresh failed: {error.message}. Showing the last loaded data.</span>
      <button type="button" className="btn btn-small" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state state-empty">{children}</div>;
}

// ---- Time --------------------------------------------------------------------------------

export function RelativeTime({
  iso,
  fallback = "never",
}: {
  iso: string | null | undefined;
  fallback?: string;
}) {
  const { now } = useRefresh();
  if (!iso) return <span className="muted">{fallback}</span>;
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {formatRelative(iso, Math.max(now, Date.now()))}
    </time>
  );
}

export function RefreshStatus({
  updatedAt,
  loading,
  onRefresh,
}: {
  updatedAt: number | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const { now, paused } = useRefresh();
  const updated = updatedAt ? formatRelative(new Date(updatedAt).toISOString(), now) : null;
  return (
    <div className="refresh-status">
      <span className="muted small" aria-live="polite">
        {loading ? "Refreshing…" : updated ? `Updated ${updated}` : ""}
        {" · "}
        {paused ? "Auto-refresh paused (tab hidden)" : `Auto-refresh every ${REFRESH_INTERVAL_MS / 1000}s`}
      </span>
      <button type="button" className="btn btn-small" onClick={onRefresh} disabled={loading}>
        <span aria-hidden="true">↻ </span>Refresh
      </button>
    </div>
  );
}

// ---- Layout helpers ----------------------------------------------------------------------

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {subtitle ? <div className="page-subtitle">{subtitle}</div> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Section({
  title,
  actions,
  children,
  id,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="card" aria-labelledby={id}>
      <div className="card-header">
        <h2 id={id}>{title}</h2>
        {actions ? <div className="card-actions">{actions}</div> : null}
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

/** Percentage with a small neutral bar; null renders as an explicit "no data" dash. */
export function PercentCell({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <span className="muted" title="No recent data">
        —
      </span>
    );
  }
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <span className="percent-cell">
      <span className="percent-value">{value.toFixed(1)}%</span>
      <span className="meter" aria-hidden="true">
        <span className="meter-fill" style={{ width: `${clamped}%` }} />
      </span>
    </span>
  );
}

// ---- Clipboard ---------------------------------------------------------------------------

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2500);
  };

  return (
    <button type="button" className="btn btn-small" onClick={copy}>
      {state === "copied"
        ? "✓ Copied"
        : state === "failed"
          ? "Copy failed – select and copy manually"
          : label}
    </button>
  );
}
