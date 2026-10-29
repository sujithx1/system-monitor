import type { CreatedHostDto } from "@system-monitor/shared";
import { type FormEvent, useState } from "react";
import { CopyButton, ErrorBox, PageHeader } from "../components/ui";
import { type ApiError, api, toApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { href, navigate } from "../lib/router";

const NAME_PATTERN = "[a-z0-9][a-z0-9._\\-]{0,62}";

function fieldError(error: ApiError | null, field: string): string | null {
  return error?.details.find((d) => d.path === field)?.message ?? null;
}

/**
 * Registers a host and shows its agent token exactly once. The token lives only in this
 * component's state: it is never written to storage or the URL and is gone after navigation.
 */
export function AddHostPage() {
  const { can } = useAuth();
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [environment, setEnvironment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [created, setCreated] = useState<CreatedHostDto | null>(null);

  if (!can("admin")) {
    return (
      <>
        <PageHeader title="Add host" />
        <p>Only administrators can register hosts.</p>
      </>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createHost({
        name: name.trim(),
        displayName: displayName.trim() || null,
        description: description.trim() || null,
        environment: environment.trim() || null,
      });
      setCreated(result);
      setName("");
      setDisplayName("");
      setDescription("");
      setEnvironment("");
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const hostId = created.host.id;
    return (
      <>
        <PageHeader title="Host registered" />
        <section className="card token-card" aria-labelledby="token-heading">
          <div className="card-body">
            <p>
              <strong>{created.host.displayName ?? created.host.name}</strong> was created with agent{" "}
              <code>{created.agent.name}</code>.
            </p>
            <div className="token-warning" role="alert">
              <span aria-hidden="true">▲ </span>
              <strong>Copy this agent token now. It will not be shown again.</strong> Only a hash is stored on
              the server; if you lose it, issue a new agent credential.
            </div>
            <h2 id="token-heading" className="small-heading">
              Agent token
            </h2>
            <div className="token-box">
              <code className="token-value">{created.agentToken}</code>
              <CopyButton text={created.agentToken} label="Copy token" />
            </div>
            <p className="small muted">
              Configure it as the agent's token on <code>{created.host.name}</code>. Treat it like a password.
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setCreated(null);
                  navigate(`/hosts/${hostId}`);
                }}
              >
                I have stored the token – open host
              </button>
              <button type="button" className="btn" onClick={() => setCreated(null)}>
                Add another host
              </button>
            </div>
          </div>
        </section>
      </>
    );
  }

  const nameError = fieldError(error, "name");
  return (
    <>
      <PageHeader title="Add host" subtitle={<a href={href("/")}>← Overview</a>} />
      <form className="card form-card" onSubmit={submit}>
        <div className="card-body">
          <div className="field">
            <label htmlFor="host-name">Name (required)</label>
            <input
              id="host-name"
              required
              pattern={NAME_PATTERN}
              maxLength={63}
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              aria-describedby="host-name-help"
              aria-invalid={nameError ? true : undefined}
              disabled={busy}
            />
            <div id="host-name-help" className="field-help">
              Lowercase letters, digits, “.”, “_” and “-”; up to 63 characters (e.g. <code>db-1.prod</code>).
            </div>
            {nameError ? <div className="field-error">{nameError}</div> : null}
          </div>
          <div className="field">
            <label htmlFor="host-display">Display name</label>
            <input
              id="host-display"
              maxLength={120}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={busy}
            />
            {fieldError(error, "displayName") ? (
              <div className="field-error">{fieldError(error, "displayName")}</div>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="host-env">Environment</label>
            <input
              id="host-env"
              maxLength={40}
              placeholder="production"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
              disabled={busy}
            />
            {fieldError(error, "environment") ? (
              <div className="field-error">{fieldError(error, "environment")}</div>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="host-desc">Description</label>
            <textarea
              id="host-desc"
              maxLength={1000}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
            />
            {fieldError(error, "description") ? (
              <div className="field-error">{fieldError(error, "description")}</div>
            ) : null}
          </div>
          {error ? <ErrorBox error={error} title="Could not create host" compact /> : null}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create host"}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
