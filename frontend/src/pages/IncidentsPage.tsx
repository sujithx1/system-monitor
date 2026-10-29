import { IncidentTable } from "../components/incidents";
import { ErrorBox, INCIDENT_STATUS_LABELS, Loading, PageHeader, StaleWarning } from "../components/ui";
import { api } from "../lib/api";
import { usePagedResource, useResource } from "../lib/resource";
import { navigate, useLocation } from "../lib/router";
import type { IncidentStatus, Severity } from "../shared";

const STATUSES: IncidentStatus[] = ["pending", "firing", "acknowledged", "resolved"];
const SEVERITIES: Severity[] = ["warning", "critical"];
const PAGE_SIZE = 50;

function parseList<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return [];
  const wanted = new Set(raw.split(","));
  return allowed.filter((v) => wanted.has(v));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function IncidentsPage() {
  const { query } = useLocation();
  const status = parseList(query.get("status"), STATUSES);
  const severity = parseList(query.get("severity"), SEVERITIES);
  const rawHost = query.get("hostId");
  const hostId = rawHost && UUID.test(rawHost) ? rawHost : null;

  const hosts = useResource("hosts", (s) => api.hosts(s), { autoRefresh: false });
  const key = `incidents:${status.join(",")}:${severity.join(",")}:${hostId ?? ""}`;
  const list = usePagedResource(
    key,
    (cursor, limit, signal) => api.incidents({ status, severity, hostId, cursor, limit }, signal),
    PAGE_SIZE,
  );

  const update = (next: { status?: string[]; severity?: string[]; hostId?: string | null }) => {
    const params = new URLSearchParams();
    const s = next.status ?? status;
    const sev = next.severity ?? severity;
    const h = next.hostId === undefined ? hostId : next.hostId;
    if (s.length > 0) params.set("status", s.join(","));
    if (sev.length > 0) params.set("severity", sev.join(","));
    if (h) params.set("hostId", h);
    navigate("/incidents", params, true);
  };
  const toggle = <T extends string>(list: T[], value: T) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const filtered = status.length > 0 || severity.length > 0 || hostId !== null;

  return (
    <>
      <PageHeader title="Incident history" subtitle="Newest first. Filters are kept in the page address." />
      <form className="filters" onSubmit={(e) => e.preventDefault()}>
        <fieldset className="chip-group">
          <legend>Status</legend>
          {STATUSES.map((s) => (
            <label key={s} className={`chip${status.includes(s) ? " active" : ""}`}>
              <input
                type="checkbox"
                checked={status.includes(s)}
                onChange={() => update({ status: toggle(status, s) })}
              />
              {INCIDENT_STATUS_LABELS[s].label}
            </label>
          ))}
        </fieldset>
        <fieldset className="chip-group">
          <legend>Severity</legend>
          {SEVERITIES.map((s) => (
            <label key={s} className={`chip${severity.includes(s) ? " active" : ""}`}>
              <input
                type="checkbox"
                checked={severity.includes(s)}
                onChange={() => update({ severity: toggle(severity, s) })}
              />
              {s === "critical" ? "Critical" : "Warning"}
            </label>
          ))}
        </fieldset>
        <div className="field field-inline">
          <label htmlFor="filter-host">Host</label>
          <select
            id="filter-host"
            value={hostId ?? ""}
            onChange={(e) => update({ hostId: e.target.value || null })}
          >
            <option value="">All hosts</option>
            {(hosts.data ?? []).map((h) => (
              <option key={h.id} value={h.id}>
                {h.displayName ?? h.name}
              </option>
            ))}
            {hostId && hosts.data && !hosts.data.some((h) => h.id === hostId) ? (
              <option value={hostId}>Unknown host</option>
            ) : null}
          </select>
        </div>
        {filtered ? (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => navigate("/incidents", undefined, true)}
          >
            Clear filters
          </button>
        ) : null}
      </form>

      <section className="card" aria-label="Incidents">
        <div className="card-body">
          {list.items ? (
            <>
              {list.error ? <StaleWarning error={list.error} onRetry={list.reload} /> : null}
              <IncidentTable
                incidents={list.items}
                onChanged={list.reload}
                emptyText={
                  filtered ? "No incidents match these filters." : "No incidents have been recorded yet."
                }
              />
              {list.loadMoreError ? (
                <ErrorBox error={list.loadMoreError} title="Could not load more incidents" compact />
              ) : null}
              <div className="load-more">
                {list.hasMore ? (
                  <button type="button" className="btn" onClick={list.loadMore} disabled={list.loadingMore}>
                    {list.loadingMore ? "Loading…" : "Load more"}
                  </button>
                ) : list.items.length > 0 ? (
                  <span className="muted small">End of history · {list.items.length} incidents</span>
                ) : null}
              </div>
            </>
          ) : list.error ? (
            <ErrorBox error={list.error} title="Could not load incidents" onRetry={list.reload} />
          ) : (
            <Loading label="Loading incidents…" />
          )}
        </div>
      </section>
    </>
  );
}
