import { useEffect, useRef } from "react";
import { IncidentTable } from "../components/incidents";
import { type ChartSeries, LineChart } from "../components/LineChart";
import {
  Badge,
  Empty,
  ErrorBox,
  HealthBadge,
  Loading,
  PageHeader,
  RefreshStatus,
  RelativeTime,
  Section,
  StaleWarning,
} from "../components/ui";
import { api, type MetricHistoryResponse } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useRefresh } from "../lib/refresh";
import { useResource } from "../lib/resource";
import { href, navigate, useLocation } from "../lib/router";
import {
  type AgentDto,
  formatMetricValue,
  type HostDetailDto,
  type LatestMetricDto,
  METRICS,
  type MetricName,
  type MetricSeriesDto,
} from "../shared";

const RANGES = [
  { id: "1h", label: "1h", ms: 3600_000 },
  { id: "6h", label: "6h", ms: 6 * 3600_000 },
  { id: "24h", label: "24h", ms: 24 * 3600_000 },
  { id: "7d", label: "7d", ms: 7 * 86_400_000 },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const CHART_METRICS: MetricName[] = [
  "cpu.usage_percent",
  "mem.usage_percent",
  "disk.usage_percent",
  "pg.latency_ms",
  "http.latency_ms",
];
const METRIC_ORDER = Object.keys(METRICS);
const MAX_PAGES = 10;

interface History {
  from: number;
  to: number;
  stepSeconds: number | null;
  series: MetricSeriesDto[];
}

/** Raw (≤ 2 h) histories are paginated; follow the cursor so the chart covers the whole range. */
async function loadHistory(hostId: string, rangeMs: number, signal: AbortSignal): Promise<History> {
  const to = new Date();
  const from = new Date(to.getTime() - rangeMs);
  const merged = new Map<string, MetricSeriesDto>();
  let cursor: string | null = null;
  let first: MetricHistoryResponse | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res: MetricHistoryResponse = await api.hostMetrics(
      hostId,
      { metrics: CHART_METRICS, from: from.toISOString(), to: to.toISOString(), limit: 5000, cursor },
      signal,
    );
    first ??= res;
    for (const s of res.series) {
      const key = `${s.metric}\u0000${s.resource}`;
      const existing = merged.get(key);
      if (existing) existing.points.push(...s.points);
      else merged.set(key, { metric: s.metric, resource: s.resource, points: [...s.points] });
    }
    cursor = res.nextCursor ?? null;
    if (!cursor) break;
  }
  return {
    from: first ? new Date(first.from).getTime() : from.getTime(),
    to: first ? new Date(first.to).getTime() : to.getTime(),
    stepSeconds: first?.stepSeconds ?? null,
    series: [...merged.values()],
  };
}

function toChartSeries(history: History, metric: MetricName, singleLabel: string): ChartSeries[] {
  return history.series
    .filter((s) => s.metric === metric)
    .sort((a, b) => a.resource.localeCompare(b.resource))
    .map((s) => ({
      id: `${s.metric}|${s.resource}`,
      label: s.resource || singleLabel,
      points: s.points.map((p) => ({ t: new Date(p.t).getTime(), v: p.value, max: p.max })),
    }));
}

const formatPercentAxis = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
const formatMs = (v: number) =>
  v >= 1000
    ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)} s`
    : `${v < 10 && v !== 0 ? v.toFixed(1) : Math.round(v)} ms`;

function Charts({ history, loading }: { history: History; loading: boolean }) {
  const common = { from: history.from, to: history.to, stepSeconds: history.stepSeconds, loading };
  return (
    <div className="chart-grid-layout">
      <LineChart
        {...common}
        title="CPU usage (%)"
        series={toChartSeries(history, "cpu.usage_percent", "CPU")}
        formatValue={formatPercentAxis}
        yMax={100}
      />
      <LineChart
        {...common}
        title="Memory usage (%)"
        series={toChartSeries(history, "mem.usage_percent", "Memory")}
        formatValue={formatPercentAxis}
        yMax={100}
      />
      <LineChart
        {...common}
        title="Disk usage by mount (%)"
        series={toChartSeries(history, "disk.usage_percent", "Disk")}
        formatValue={formatPercentAxis}
        yMax={100}
      />
      <LineChart
        {...common}
        title="PostgreSQL query latency"
        series={toChartSeries(history, "pg.latency_ms", "PostgreSQL")}
        formatValue={formatMs}
      />
      <LineChart
        {...common}
        title="HTTP check response time"
        series={toChartSeries(history, "http.latency_ms", "HTTP")}
        formatValue={formatMs}
      />
    </div>
  );
}

function LatestMetrics({ metrics }: { metrics: LatestMetricDto[] }) {
  if (metrics.length === 0) {
    return <Empty>No metrics received in the last 15 minutes.</Empty>;
  }
  const sorted = [...metrics].sort(
    (a, b) =>
      METRIC_ORDER.indexOf(a.metric) - METRIC_ORDER.indexOf(b.metric) || a.resource.localeCompare(b.resource),
  );
  return (
    <div className="table-wrap">
      <table className="table table-stack">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">Resource</th>
            <th scope="col">Value</th>
            <th scope="col">Collected</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => {
            const def = METRICS[m.metric];
            const unavailable = m.status === "unavailable" || m.value === null;
            return (
              <tr key={`${m.metric}|${m.resource}`} className={unavailable ? "row-unavailable" : undefined}>
                <td data-label="Metric" className="cell-wide">
                  {def?.label ?? m.metric}
                  <div className="small muted">
                    <code>{m.metric}</code>
                  </div>
                </td>
                <td data-label="Resource">{m.resource || <span className="muted">host</span>}</td>
                <td data-label="Value">
                  {unavailable ? (
                    <>
                      <Badge tone="warning" icon="?">
                        Unavailable
                      </Badge>
                      {m.error ? <div className="small error-text">{m.error}</div> : null}
                    </>
                  ) : (
                    <span className="metric-value">{formatMetricValue(m.metric, m.value)}</span>
                  )}
                </td>
                <td data-label="Collected">
                  <RelativeTime iso={m.collectedAt} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AgentStatus({ agent }: { agent: AgentDto }) {
  if (agent.revokedAt) {
    return (
      <Badge tone="neutral" icon="–" title={`Revoked ${formatDateTime(agent.revokedAt)}`}>
        Revoked
      </Badge>
    );
  }
  if (!agent.enabled) {
    return (
      <Badge tone="neutral" icon="–">
        Disabled
      </Badge>
    );
  }
  return (
    <Badge tone="good" icon="✓">
      Active
    </Badge>
  );
}

function Agents({ agents }: { agents: AgentDto[] }) {
  if (agents.length === 0) return <Empty>No agents registered for this host.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table table-stack">
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Token prefix</th>
            <th scope="col">Status</th>
            <th scope="col">Version</th>
            <th scope="col">Last seen</th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td data-label="Agent">{a.name}</td>
              <td data-label="Token prefix">
                <code>{a.tokenPrefix}…</code>
              </td>
              <td data-label="Status">
                <AgentStatus agent={a} />
              </td>
              <td data-label="Version">{a.version ?? <span className="muted">—</span>}</td>
              <td data-label="Last seen">
                <RelativeTime iso={a.lastSeenAt} />
              </td>
              <td data-label="Created">
                <RelativeTime iso={a.createdAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HostSummary({ host }: { host: HostDetailDto }) {
  return (
    <dl className="facts">
      <div>
        <dt>Health</dt>
        <dd>
          <HealthBadge health={host.health} />
        </dd>
      </div>
      <div>
        <dt>Last heartbeat</dt>
        <dd>
          <RelativeTime iso={host.lastHeartbeatAt} />
        </dd>
      </div>
      <div>
        <dt>Last metrics</dt>
        <dd>
          <RelativeTime iso={host.lastMetricsAt} />
        </dd>
      </div>
      <div>
        <dt>Hostname</dt>
        <dd>{host.hostname ?? <span className="muted">—</span>}</dd>
      </div>
      <div>
        <dt>Environment</dt>
        <dd>{host.environment ?? <span className="muted">—</span>}</dd>
      </div>
      <div>
        <dt>Agent version</dt>
        <dd>{host.agentVersion ?? <span className="muted">—</span>}</dd>
      </div>
      <div>
        <dt>Monitoring</dt>
        <dd>{host.enabled ? "Enabled" : "Disabled"}</dd>
      </div>
      <div>
        <dt>Registered</dt>
        <dd>{formatDateTime(host.createdAt)}</dd>
      </div>
    </dl>
  );
}

export function HostDetailPage({ hostId }: { hostId: string }) {
  const { query } = useLocation();
  const { refreshNow } = useRefresh();
  const requested = query.get("range");
  const range = RANGES.find((r) => r.id === requested) ?? RANGES[0];

  const host = useResource(`host:${hostId}`, (s) => api.host(hostId, s));
  const history = useResource(`history:${hostId}:${range.id}`, (s) => loadHistory(hostId, range.ms, s));

  // Keep the previous charts on screen (dimmed) while a new range loads, instead of flashing.
  const lastHistory = useRef<History | undefined>(undefined);
  useEffect(() => {
    if (history.data) lastHistory.current = history.data;
  }, [history.data]);
  const shownHistory = history.data ?? lastHistory.current;

  const setRange = (id: RangeId) => navigate(`/hosts/${hostId}`, { range: id }, true);

  if (!host.data) {
    if (host.error) {
      return (
        <>
          <PageHeader title="Host" subtitle={<a href={href("/")}>← Overview</a>} />
          <ErrorBox
            error={host.error}
            title={host.error.status === 404 ? "Host not found" : "Could not load host"}
            onRetry={host.error.status === 404 ? undefined : host.reload}
          />
        </>
      );
    }
    return <Loading label="Loading host…" />;
  }

  const h = host.data;
  return (
    <>
      <PageHeader
        title={
          <>
            {h.displayName ?? h.name} <HealthBadge health={h.health} />
          </>
        }
        subtitle={
          <>
            <a href={href("/")}>← Overview</a> · <code>{h.name}</code>
            {h.description ? <span> · {h.description}</span> : null}
          </>
        }
        actions={
          <RefreshStatus
            updatedAt={host.updatedAt}
            loading={host.loading || history.loading}
            onRefresh={refreshNow}
          />
        }
      />
      {host.error ? <StaleWarning error={host.error} onRetry={host.reload} /> : null}
      <HostSummary host={h} />

      <Section
        title="Metrics history"
        id="history"
        actions={
          <fieldset className="segmented">
            <legend className="visually-hidden">Time range</legend>
            {RANGES.map((r) => (
              <label key={r.id} className={r.id === range.id ? "active" : undefined}>
                <input
                  type="radio"
                  name="range"
                  value={r.id}
                  checked={r.id === range.id}
                  onChange={() => setRange(r.id)}
                />
                {r.label}
              </label>
            ))}
          </fieldset>
        }
      >
        {history.error ? (
          shownHistory && history.data ? (
            <StaleWarning error={history.error} onRetry={history.reload} />
          ) : (
            <ErrorBox error={history.error} title="Could not load metric history" onRetry={history.reload} />
          )
        ) : null}
        {shownHistory && !(history.error && !history.data) ? (
          <Charts history={shownHistory} loading={history.loading} />
        ) : !history.error ? (
          <Loading label="Loading charts…" />
        ) : null}
      </Section>

      <Section title="Latest metrics" id="latest">
        <LatestMetrics metrics={h.metrics} />
      </Section>

      <Section title="Incidents" id="host-incidents">
        <IncidentTable
          incidents={h.incidents}
          onChanged={host.reload}
          showHost={false}
          emptyText="No incidents recorded for this host."
        />
        {h.incidents.length > 0 ? (
          <p className="small">
            <a href={href("/incidents", { hostId: h.id })}>Full incident history for this host →</a>
          </p>
        ) : null}
      </Section>

      <Section title="Agents" id="agents">
        <Agents agents={h.agents} />
      </Section>
    </>
  );
}
