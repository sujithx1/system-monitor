import {
  Empty,
  ErrorBox,
  Loading,
  NOTIFICATION_KIND_LABELS,
  NOTIFICATION_STATUS_LABELS,
  NotificationStatusBadge,
  PageHeader,
  RelativeTime,
  StaleWarning,
} from "../components/ui";
import { api } from "../lib/api";
import { usePagedResource } from "../lib/resource";
import { href, navigate, useLocation } from "../lib/router";
import type { NotificationDto, NotificationKind, NotificationStatus } from "../shared";

const STATUSES: NotificationStatus[] = [
  "queued",
  "sending",
  "retrying",
  "accepted",
  "sent",
  "delivered",
  "read",
  "failed",
  "cancelled",
];
const KINDS: NotificationKind[] = [
  "firing",
  "severity_increase",
  "reminder",
  "escalation",
  "recovery",
  "test",
];
const PAGE_SIZE = 50;

function pick<T extends string>(raw: string | null, allowed: readonly T[]): T | null {
  return allowed.find((v) => v === raw) ?? null;
}

function NotificationTable({ items }: { items: NotificationDto[] }) {
  return (
    <div className="table-wrap">
      <table className="table table-stack">
        <thead>
          <tr>
            <th scope="col">Created</th>
            <th scope="col">Kind</th>
            <th scope="col">Recipient</th>
            <th scope="col">Status</th>
            <th scope="col">Attempts</th>
            <th scope="col">Last error</th>
            <th scope="col">Incident</th>
          </tr>
        </thead>
        <tbody>
          {items.map((n) => (
            <tr key={n.id}>
              <td data-label="Created">
                <RelativeTime iso={n.createdAt} />
              </td>
              <td data-label="Kind">{NOTIFICATION_KIND_LABELS[n.kind]}</td>
              <td data-label="Recipient">
                <code>{n.recipient}</code>
              </td>
              <td data-label="Status">
                <NotificationStatusBadge status={n.status} />
                {n.nextAttemptAt ? (
                  <div className="small muted">
                    next try <RelativeTime iso={n.nextAttemptAt} />
                  </div>
                ) : null}
                {n.deliveredAt ? (
                  <div className="small muted">
                    delivered <RelativeTime iso={n.deliveredAt} />
                  </div>
                ) : null}
              </td>
              <td data-label="Attempts">
                {n.attemptCount}/{n.maxAttempts}
              </td>
              <td data-label="Last error" className="cell-wide">
                {n.lastError ? (
                  <span className="error-text small">{n.lastError}</span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td data-label="Incident">
                {n.incidentId ? (
                  <a href={href(`/incidents/${n.incidentId}`)}>View</a>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NotificationsPage() {
  const { query } = useLocation();
  const status = pick(query.get("status"), STATUSES);
  const kind = pick(query.get("kind"), KINDS);

  const list = usePagedResource(
    `notifications:${status ?? ""}:${kind ?? ""}`,
    (cursor, limit, signal) =>
      api.notifications({ status: status ? [status] : [], kind: kind ? [kind] : [], cursor, limit }, signal),
    PAGE_SIZE,
  );

  const update = (next: { status?: string | null; kind?: string | null }) => {
    const params = new URLSearchParams();
    const s = next.status === undefined ? status : next.status;
    const k = next.kind === undefined ? kind : next.kind;
    if (s) params.set("status", s);
    if (k) params.set("kind", k);
    navigate("/notifications", params, true);
  };
  const filtered = status !== null || kind !== null;

  return (
    <>
      <PageHeader title="Notifications" subtitle="WhatsApp alerts, newest first. Recipients are masked." />
      <form className="filters" onSubmit={(e) => e.preventDefault()}>
        <div className="field field-inline">
          <label htmlFor="filter-status">Status</label>
          <select
            id="filter-status"
            value={status ?? ""}
            onChange={(e) => update({ status: e.target.value || null })}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {NOTIFICATION_STATUS_LABELS[s].label}
              </option>
            ))}
          </select>
        </div>
        <div className="field field-inline">
          <label htmlFor="filter-kind">Kind</label>
          <select
            id="filter-kind"
            value={kind ?? ""}
            onChange={(e) => update({ kind: e.target.value || null })}
          >
            <option value="">All kinds</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {NOTIFICATION_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        {filtered ? (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => navigate("/notifications", undefined, true)}
          >
            Clear filters
          </button>
        ) : null}
      </form>

      <section className="card" aria-label="Notifications">
        <div className="card-body">
          {list.items ? (
            <>
              {list.error ? <StaleWarning error={list.error} onRetry={list.reload} /> : null}
              {list.items.length === 0 ? (
                <Empty>
                  {filtered
                    ? "No notifications match these filters."
                    : "No notifications have been sent yet."}
                </Empty>
              ) : (
                <NotificationTable items={list.items} />
              )}
              {list.loadMoreError ? (
                <ErrorBox error={list.loadMoreError} title="Could not load more notifications" compact />
              ) : null}
              <div className="load-more">
                {list.hasMore ? (
                  <button type="button" className="btn" onClick={list.loadMore} disabled={list.loadingMore}>
                    {list.loadingMore ? "Loading…" : "Load more"}
                  </button>
                ) : list.items.length > 0 ? (
                  <span className="muted small">End of list · {list.items.length} notifications</span>
                ) : null}
              </div>
            </>
          ) : list.error ? (
            <ErrorBox error={list.error} title="Could not load notifications" onRetry={list.reload} />
          ) : (
            <Loading label="Loading notifications…" />
          )}
        </div>
      </section>
    </>
  );
}
