import { type FormEvent, type ReactNode, useState } from "react";
import { IncidentTable } from "../components/incidents";
import {
  Empty,
  ErrorBox,
  HealthBadge,
  Loading,
  NOTIFICATION_STATUS_LABELS,
  PageHeader,
  PercentCell,
  RefreshStatus,
  RelativeTime,
  Section,
  StaleWarning,
} from "../components/ui";
import { type ApiError, api, type SystemStatusDto, toApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useRefresh } from "../lib/refresh";
import { useResource } from "../lib/resource";
import { href } from "../lib/router";
import type { HostSummaryDto, NotificationStatus, OverviewDto } from "../shared";

const BANNER: Record<OverviewDto["status"], { icon: string; title: string }> = {
  healthy: { icon: "✓", title: "All systems operational" },
  warning: { icon: "▲", title: "Degraded – warnings present" },
  critical: { icon: "✕", title: "Critical – action required" },
};

function bannerReasons(o: OverviewDto): string[] {
  const reasons: string[] = [];
  if (!o.worker.healthy) reasons.push("alert worker is not reporting");
  if (o.hosts.critical > 0)
    reasons.push(`${o.hosts.critical} critical host${o.hosts.critical === 1 ? "" : "s"}`);
  if (o.hosts.offline > 0) reasons.push(`${o.hosts.offline} offline host${o.hosts.offline === 1 ? "" : "s"}`);
  if (o.hosts.warning > 0)
    reasons.push(`${o.hosts.warning} host${o.hosts.warning === 1 ? "" : "s"} with warnings`);
  if (o.incidents.firing > 0)
    reasons.push(`${o.incidents.firing} firing incident${o.incidents.firing === 1 ? "" : "s"}`);
  return reasons;
}

function HealthBanner({ overview }: { overview: OverviewDto }) {
  const spec = BANNER[overview.status];
  const reasons = bannerReasons(overview);
  return (
    <div className={`banner banner-${overview.status}`} role="status">
      <span className="banner-icon" aria-hidden="true">
        {spec.icon}
      </span>
      <div>
        <div className="banner-title">{spec.title}</div>
        {reasons.length > 0 ? <div className="banner-detail">{reasons.join(" · ")}</div> : null}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  icon,
  sub,
}: {
  label: string;
  value: ReactNode;
  tone?: "good" | "warning" | "critical" | "serious" | "neutral";
  icon?: string;
  sub?: ReactNode;
}) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ""}`}>
      <div className="stat-label">
        {icon ? (
          <span className="stat-icon" aria-hidden="true">
            {icon}{" "}
          </span>
        ) : null}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

function Stats({ overview }: { overview: OverviewDto }) {
  const { hosts, incidents, notifications, worker } = overview;
  return (
    <div className="stats">
      <Stat
        label="Hosts"
        value={hosts.total}
        sub={
          hosts.unknown + hosts.disabled > 0
            ? `${hosts.unknown} unknown · ${hosts.disabled} disabled`
            : undefined
        }
      />
      <Stat label="Healthy" icon="✓" value={hosts.healthy} tone={hosts.healthy > 0 ? "good" : "neutral"} />
      <Stat label="Warning" icon="▲" value={hosts.warning} tone={hosts.warning > 0 ? "warning" : "neutral"} />
      <Stat
        label="Critical"
        icon="✕"
        value={hosts.critical}
        tone={hosts.critical > 0 ? "critical" : "neutral"}
      />
      <Stat label="Offline" icon="⊘" value={hosts.offline} tone={hosts.offline > 0 ? "serious" : "neutral"} />
      <Stat
        label="Incidents"
        value={incidents.firing}
        tone={incidents.firing > 0 ? "critical" : "neutral"}
        sub={`firing · ${incidents.pending} pending · ${incidents.acknowledged} acked`}
      />
      <Stat
        label="Alert worker"
        icon={worker.healthy ? "✓" : "✕"}
        value={worker.healthy ? "Running" : "Not reporting"}
        tone={worker.healthy ? "good" : "critical"}
        sub={
          <>
            last seen <RelativeTime iso={worker.lastSeenAt} />
          </>
        }
      />
      <Stat
        label="Notifications"
        value={notifications.queued}
        sub={`queued · ${notifications.failedLast24h} failed (24h)`}
        tone={notifications.failedLast24h > 0 ? "warning" : "neutral"}
        icon={notifications.failedLast24h > 0 ? "▲" : undefined}
      />
    </div>
  );
}

function HostTable({ hosts }: { hosts: HostSummaryDto[] }) {
  if (hosts.length === 0) {
    return <Empty>No hosts are monitored yet.</Empty>;
  }
  return (
    <div className="table-wrap">
      <table className="table table-stack">
        <thead>
          <tr>
            <th scope="col">Host</th>
            <th scope="col">Health</th>
            <th scope="col">CPU</th>
            <th scope="col">RAM</th>
            <th scope="col">Disk (max)</th>
            <th scope="col">Last heartbeat</th>
            <th scope="col">Agent</th>
            <th scope="col">Incidents</th>
          </tr>
        </thead>
        <tbody>
          {hosts.map((h) => (
            <tr key={h.id}>
              <td data-label="Host" className="cell-wide">
                <a href={href(`/hosts/${h.id}`)} className="strong-link">
                  {h.displayName ?? h.name}
                </a>
                <div className="small muted">
                  {h.displayName ? h.name : h.hostname}
                  {h.environment ? <span className="env-chip">{h.environment}</span> : null}
                </div>
              </td>
              <td data-label="Health">
                <HealthBadge health={h.health} />
              </td>
              <td data-label="CPU">
                <PercentCell value={h.latest.cpu} />
              </td>
              <td data-label="RAM">
                <PercentCell value={h.latest.memory} />
              </td>
              <td data-label="Disk (max)">
                <PercentCell value={h.latest.diskMax} />
              </td>
              <td data-label="Last heartbeat">
                <RelativeTime iso={h.lastHeartbeatAt} />
              </td>
              <td data-label="Agent">{h.agentVersion ?? <span className="muted">—</span>}</td>
              <td data-label="Incidents">
                {h.activeIncidents > 0 ? (
                  <a href={href("/incidents", { hostId: h.id, status: "pending,firing,acknowledged" })}>
                    {h.activeIncidents} active
                  </a>
                ) : (
                  <span className="muted">0</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SystemPanel({ status }: { status: SystemStatusDto }) {
  const queue = Object.entries(status.notificationQueue).filter(
    (entry): entry is [NotificationStatus, number] =>
      entry[0] in NOTIFICATION_STATUS_LABELS && entry[1] !== undefined,
  );
  return (
    <div className="system-panel">
      <div>
        <h3>Worker instances</h3>
        {status.workers.length === 0 ? (
          <Empty>No worker has reported a heartbeat.</Empty>
        ) : (
          <ul className="plain-list">
            {status.workers.map((w) => (
              <li key={`${w.service}:${w.instanceId}`}>
                <strong>{w.service}</strong> <code className="small">{w.instanceId}</code>
                {w.version ? <span className="muted small"> v{w.version}</span> : null}
                <div className="small muted">
                  last seen <RelativeTime iso={w.lastSeenAt} /> · started <RelativeTime iso={w.startedAt} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3>Notification queue</h3>
        {queue.length === 0 ? (
          <Empty>No notifications recorded.</Empty>
        ) : (
          <dl className="queue-counts">
            {queue.map(([s, n]) => (
              <div key={s}>
                <dt>{NOTIFICATION_STATUS_LABELS[s].label}</dt>
                <dd>{n}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

function AdminActions() {
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.sendTest(recipient);
      setResult(r.notificationId);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-actions">
      <form className="inline-form" onSubmit={send}>
        <div className="field">
          <label htmlFor="test-recipient">Test recipient (optional)</label>
          <input
            id="test-recipient"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="Default configured recipient"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            disabled={busy}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Queuing…" : "Send test WhatsApp"}
        </button>
        <a className="btn" href={href("/hosts/new")}>
          + Add host
        </a>
      </form>
      <p className="small muted">
        Only recipients configured on the server (WHATSAPP_RECIPIENT) can receive tests.
      </p>
      {result ? (
        <p className="notice notice-good" role="status">
          <span aria-hidden="true">✓ </span>Test notification queued. Follow its delivery on the{" "}
          <a href={href("/notifications", { kind: "test" })}>Notifications</a> page.
        </p>
      ) : null}
      {error ? <ErrorBox error={error} title="Could not send test notification" compact /> : null}
    </div>
  );
}

export function OverviewPage() {
  const { can } = useAuth();
  const { refreshNow } = useRefresh();
  const overview = useResource("overview", (s) => api.overview(s));
  const system = useResource("system", (s) => api.systemStatus(s));
  const hosts = useResource("hosts", (s) => api.hosts(s));
  const active = useResource("incidents:active", (s) =>
    api.incidents({ status: ["pending", "firing"], limit: 100 }, s),
  );
  const acked = useResource("incidents:acked", (s) =>
    api.incidents({ status: ["acknowledged"], limit: 100 }, s),
  );

  const reloadIncidents = () => {
    active.reload();
    acked.reload();
    overview.reload();
  };
  const anyLoading = overview.loading || hosts.loading || active.loading || acked.loading || system.loading;

  return (
    <>
      <PageHeader
        title="Overview"
        actions={<RefreshStatus updatedAt={overview.updatedAt} loading={anyLoading} onRefresh={refreshNow} />}
      />

      {overview.data ? (
        <>
          {overview.error ? <StaleWarning error={overview.error} onRetry={overview.reload} /> : null}
          <HealthBanner overview={overview.data} />
          <Stats overview={overview.data} />
        </>
      ) : overview.error ? (
        <ErrorBox error={overview.error} title="Could not load the overview" onRetry={overview.reload} />
      ) : (
        <Loading label="Loading overview…" />
      )}

      <Section
        title="Active incidents"
        id="active-incidents"
        actions={<a href={href("/incidents")}>Incident history →</a>}
      >
        {active.data ? (
          <>
            {active.error ? <StaleWarning error={active.error} onRetry={active.reload} /> : null}
            <IncidentTable
              incidents={active.data.items}
              onChanged={reloadIncidents}
              emptyText="No firing or pending incidents."
            />
            {active.data.nextCursor ? (
              <p className="small muted">
                Showing the latest 100. <a href={href("/incidents", { status: "pending,firing" })}>See all</a>
              </p>
            ) : null}
          </>
        ) : active.error ? (
          <ErrorBox error={active.error} title="Could not load incidents" onRetry={active.reload} />
        ) : (
          <Loading />
        )}
      </Section>

      <Section title="Acknowledged incidents" id="acked-incidents">
        {acked.data ? (
          <>
            {acked.error ? <StaleWarning error={acked.error} onRetry={acked.reload} /> : null}
            <IncidentTable
              incidents={acked.data.items}
              onChanged={reloadIncidents}
              emptyText="No acknowledged incidents."
            />
          </>
        ) : acked.error ? (
          <ErrorBox error={acked.error} title="Could not load incidents" onRetry={acked.reload} />
        ) : (
          <Loading />
        )}
      </Section>

      <Section title="Hosts" id="hosts">
        {hosts.data ? (
          <>
            {hosts.error ? <StaleWarning error={hosts.error} onRetry={hosts.reload} /> : null}
            <HostTable hosts={hosts.data} />
          </>
        ) : hosts.error ? (
          <ErrorBox error={hosts.error} title="Could not load hosts" onRetry={hosts.reload} />
        ) : (
          <Loading label="Loading hosts…" />
        )}
      </Section>

      <Section title="Monitoring system" id="system">
        {system.data ? (
          <>
            {system.error ? <StaleWarning error={system.error} onRetry={system.reload} /> : null}
            <SystemPanel status={system.data} />
          </>
        ) : system.error ? (
          <ErrorBox error={system.error} title="Could not load system status" onRetry={system.reload} />
        ) : (
          <Loading />
        )}
      </Section>

      {can("admin") ? (
        <Section title="Admin actions" id="admin-actions">
          <AdminActions />
        </Section>
      ) : null}
    </>
  );
}
