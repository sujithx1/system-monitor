import {
  formatDuration,
  formatMetricValue,
  type IncidentDetailDto,
  type NotificationDto,
} from "@system-monitor/shared";
import { AckControl } from "../components/incidents";
import {
  Empty,
  ErrorBox,
  IncidentStatusBadge,
  Loading,
  NOTIFICATION_KIND_LABELS,
  NotificationStatusBadge,
  PageHeader,
  RefreshStatus,
  RelativeTime,
  Section,
  SeverityBadge,
  StaleWarning,
} from "../components/ui";
import { api } from "../lib/api";
import { formatDateTime, secondsBetween } from "../lib/format";
import { useRefresh } from "../lib/refresh";
import { useResource } from "../lib/resource";
import { href } from "../lib/router";

function formatIncidentValue(incident: IncidentDetailDto, value: number | null): string {
  if (value === null) return "—";
  const metric = incident.rule?.metric;
  if (metric) return formatMetricValue(metric, value);
  if (incident.rule?.kind === "heartbeat") return formatDuration(value);
  return String(Math.round(value * 100) / 100);
}

interface TimelineEvent {
  key: string;
  at: string;
  icon: string;
  title: string;
  detail?: string | undefined;
}

function buildTimeline(incident: IncidentDetailDto): TimelineEvent[] {
  const events: TimelineEvent[] = [
    { key: "started", at: incident.startedAt, icon: "◷", title: "Condition first detected (pending)" },
  ];
  if (incident.firedAt) {
    events.push({ key: "fired", at: incident.firedAt, icon: "●", title: `Fired as ${incident.severity}` });
  }
  if (incident.acknowledgedAt) {
    const note = incident.metadata.ackNote;
    events.push({
      key: "acked",
      at: incident.acknowledgedAt,
      icon: "◉",
      title: `Acknowledged${incident.acknowledgedBy ? ` by ${incident.acknowledgedBy}` : ""}`,
      detail: typeof note === "string" && note ? `Note: ${note}` : undefined,
    });
  }
  if (incident.resolvedAt) {
    events.push({ key: "resolved", at: incident.resolvedAt, icon: "✓", title: "Resolved" });
  }
  return events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function Timeline({ incident }: { incident: IncidentDetailDto }) {
  const events = buildTimeline(incident);
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.key} className={`timeline-item timeline-${e.key}`}>
          <span className="timeline-icon" aria-hidden="true">
            {e.icon}
          </span>
          <div>
            <div className="timeline-title">{e.title}</div>
            <div className="small muted">
              <time dateTime={e.at}>{formatDateTime(e.at)}</time> · <RelativeTime iso={e.at} />
            </div>
            {e.detail ? <div className="small">{e.detail}</div> : null}
          </div>
        </li>
      ))}
      {!incident.resolvedAt ? (
        <li className="timeline-item timeline-open">
          <span className="timeline-icon" aria-hidden="true">
            …
          </span>
          <div className="timeline-title muted">Still open</div>
        </li>
      ) : null}
    </ol>
  );
}

function NotificationCard({ n }: { n: NotificationDto }) {
  const attempts = n.attempts ?? [];
  return (
    <li className="notification-card">
      <div className="notification-head">
        <NotificationStatusBadge status={n.status} />
        <strong>{NOTIFICATION_KIND_LABELS[n.kind]}</strong>
        <span className="muted">to {n.recipient}</span>
        <span className="muted small">
          attempts {n.attemptCount}/{n.maxAttempts}
        </span>
      </div>
      <dl className="facts facts-compact">
        <div>
          <dt>Created</dt>
          <dd>{formatDateTime(n.createdAt)}</dd>
        </div>
        {n.acceptedAt ? (
          <div>
            <dt>Accepted</dt>
            <dd>{formatDateTime(n.acceptedAt)}</dd>
          </div>
        ) : null}
        {n.deliveredAt ? (
          <div>
            <dt>Delivered</dt>
            <dd>{formatDateTime(n.deliveredAt)}</dd>
          </div>
        ) : null}
        {n.readAt ? (
          <div>
            <dt>Read</dt>
            <dd>{formatDateTime(n.readAt)}</dd>
          </div>
        ) : null}
        {n.failedAt ? (
          <div>
            <dt>Failed</dt>
            <dd>{formatDateTime(n.failedAt)}</dd>
          </div>
        ) : null}
        {n.nextAttemptAt ? (
          <div>
            <dt>Next attempt</dt>
            <dd>
              <RelativeTime iso={n.nextAttemptAt} />
            </dd>
          </div>
        ) : null}
      </dl>
      {n.lastError ? (
        <p className="small error-text">
          <span aria-hidden="true">✕ </span>Last error: {n.lastError}
        </p>
      ) : null}
      {attempts.length > 0 ? (
        <details>
          <summary>Delivery attempts ({attempts.length})</summary>
          <div className="table-wrap">
            <table className="table table-compact table-stack">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Started</th>
                  <th scope="col">Duration</th>
                  <th scope="col">HTTP</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Error</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((a) => (
                  <tr key={a.attemptNumber}>
                    <td data-label="#">{a.attemptNumber}</td>
                    <td data-label="Started">{formatDateTime(a.startedAt)}</td>
                    <td data-label="Duration">{a.durationMs !== null ? `${a.durationMs} ms` : "—"}</td>
                    <td data-label="HTTP">{a.httpStatus ?? "—"}</td>
                    <td data-label="Outcome">{a.outcome}</td>
                    <td data-label="Error" className="cell-wide">
                      {a.errorCode || a.errorMessage ? (
                        <span className="error-text">
                          {a.errorCode ? <code>{a.errorCode}</code> : null} {a.errorMessage}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : (
        <p className="small muted">No delivery attempts yet.</p>
      )}
    </li>
  );
}

export function IncidentDetailPage({ incidentId }: { incidentId: string }) {
  const { now, refreshNow } = useRefresh();
  const incident = useResource(`incident:${incidentId}`, (s) => api.incident(incidentId, s));

  if (!incident.data) {
    if (incident.error) {
      return (
        <>
          <PageHeader title="Incident" subtitle={<a href={href("/incidents")}>← Incident history</a>} />
          <ErrorBox
            error={incident.error}
            title={incident.error.status === 404 ? "Incident not found" : "Could not load incident"}
            onRetry={incident.error.status === 404 ? undefined : incident.reload}
          />
        </>
      );
    }
    return <Loading label="Loading incident…" />;
  }

  const i = incident.data;
  return (
    <>
      <PageHeader
        title={
          <>
            {i.ruleName} <SeverityBadge severity={i.severity} /> <IncidentStatusBadge status={i.status} />
          </>
        }
        subtitle={
          <>
            <a href={href("/incidents")}>← Incident history</a> · host{" "}
            <a href={href(`/hosts/${i.hostId}`)}>{i.hostName}</a>
            {i.resource ? <> · {i.resource}</> : null}
          </>
        }
        actions={
          <RefreshStatus updatedAt={incident.updatedAt} loading={incident.loading} onRefresh={refreshNow} />
        }
      />
      {incident.error ? <StaleWarning error={incident.error} onRetry={incident.reload} /> : null}

      <section className="card">
        <div className="card-body">
          <p className="incident-summary">{i.summary}</p>
          <dl className="facts">
            <div>
              <dt>Value</dt>
              <dd>{formatIncidentValue(i, i.value)}</dd>
            </div>
            <div>
              <dt>Threshold</dt>
              <dd>{formatIncidentValue(i, i.threshold)}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>
                {formatDuration(secondsBetween(i.startedAt, i.resolvedAt, now))}
                {i.resolvedAt ? null : " (ongoing)"}
              </dd>
            </div>
            <div>
              <dt>Notifications sent</dt>
              <dd>{i.notificationCount}</dd>
            </div>
            <div>
              <dt>Last notified</dt>
              <dd>
                <RelativeTime iso={i.lastNotifiedAt} />
              </dd>
            </div>
          </dl>
          {i.rule?.suggestedAction ? (
            <p className="suggested-action">
              <strong>Suggested action:</strong> {i.rule.suggestedAction}
            </p>
          ) : null}
          <AckControl incident={i} onDone={incident.reload} />
        </div>
      </section>

      <Section title="Timeline" id="timeline">
        <Timeline incident={i} />
      </Section>

      <Section title="Notifications" id="incident-notifications">
        {i.notifications.length === 0 ? (
          <Empty>No notifications were created for this incident.</Empty>
        ) : (
          <ul className="notification-list">
            {i.notifications.map((n) => (
              <NotificationCard key={n.id} n={n} />
            ))}
          </ul>
        )}
      </Section>

      {i.rule ? (
        <Section title="Rule" id="rule" actions={<a href={href("/rules")}>All rules →</a>}>
          <p>
            <strong>{i.rule.name}</strong>
            {i.rule.description ? <span className="muted"> – {i.rule.description}</span> : null}
          </p>
        </Section>
      ) : null}
    </>
  );
}
