import { type FormEvent, useId, useState } from "react";
import { type ApiError, api, toApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { secondsBetween } from "../lib/format";
import { useRefresh } from "../lib/refresh";
import { href } from "../lib/router";
import { formatDuration, type IncidentDto } from "../shared";
import { Empty, ErrorBox, IncidentStatusBadge, RelativeTime, SeverityBadge } from "./ui";

/**
 * Acknowledge button for operators/admins. Only firing incidents can be acknowledged
 * (the API rejects pending/resolved ones), so the control is hidden otherwise.
 */
export function AckControl({ incident, onDone }: { incident: IncidentDto; onDone: () => void }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const noteId = useId();

  if (incident.status !== "firing" || !can("operator")) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.acknowledge(incident.id, note);
      setOpen(false);
      setNote("");
      onDone();
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-small btn-primary" onClick={() => setOpen(true)}>
        Acknowledge
      </button>
    );
  }

  return (
    <form className="ack-form" onSubmit={submit}>
      <label htmlFor={noteId} className="small">
        Note (optional)
      </label>
      <input
        id={noteId}
        type="text"
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. investigating disk growth"
        disabled={busy}
      />
      <div className="ack-actions">
        <button type="submit" className="btn btn-small btn-primary" disabled={busy}>
          {busy ? "Acknowledging…" : "Confirm acknowledge"}
        </button>
        <button type="button" className="btn btn-small" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
      {error ? <ErrorBox error={error} title="Could not acknowledge" compact /> : null}
    </form>
  );
}

export function IncidentTable({
  incidents,
  onChanged,
  showHost = true,
  emptyText = "No incidents.",
}: {
  incidents: IncidentDto[];
  onChanged: () => void;
  showHost?: boolean;
  emptyText?: string;
}) {
  const { now } = useRefresh();
  if (incidents.length === 0) return <Empty>{emptyText}</Empty>;
  return (
    <div className="table-wrap">
      <table className="table table-stack">
        <thead>
          <tr>
            <th scope="col">Severity</th>
            <th scope="col">Status</th>
            {showHost ? <th scope="col">Host</th> : null}
            <th scope="col">Incident</th>
            <th scope="col">Started</th>
            <th scope="col">Duration</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {incidents.map((i) => (
            <tr key={i.id}>
              <td data-label="Severity">
                <SeverityBadge severity={i.severity} />
              </td>
              <td data-label="Status">
                <IncidentStatusBadge status={i.status} />
              </td>
              {showHost ? (
                <td data-label="Host">
                  <a href={href(`/hosts/${i.hostId}`)}>{i.hostName}</a>
                </td>
              ) : null}
              <td data-label="Incident" className="cell-wide">
                <a href={href(`/incidents/${i.id}`)} className="strong-link">
                  {i.ruleName}
                  {i.resource ? <span className="muted"> · {i.resource}</span> : null}
                </a>
                <div className="small muted">{i.summary}</div>
              </td>
              <td data-label="Started">
                <RelativeTime iso={i.startedAt} />
              </td>
              <td data-label="Duration">
                {formatDuration(secondsBetween(i.startedAt, i.resolvedAt, now))}
                {i.resolvedAt ? null : <span className="muted small"> (ongoing)</span>}
              </td>
              <td data-label="Actions">
                <AckControl incident={i} onDone={onChanged} />
                {i.status === "acknowledged" && i.acknowledgedBy ? (
                  <span className="small muted">by {i.acknowledgedBy}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
