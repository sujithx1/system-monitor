import type { UserDto } from "@system-monitor/shared";
import { type FormEvent, useState } from "react";
import { ErrorBox } from "../components/ui";
import { type ApiError, api, toApiError } from "../lib/api";

export function LoginPage({ expired, onLogin }: { expired: boolean; onLogin: (user: UserDto) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await api.login(email.trim(), password);
      setPassword("");
      onLogin(user);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <h1 className="login-title">
          <span className="brand-mark" aria-hidden="true">
            ◆
          </span>{" "}
          System Monitor
        </h1>
        {expired && !error ? (
          <p className="notice" role="status">
            Your session has ended. Please sign in again.
          </p>
        ) : null}
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </div>
        {error ? <ErrorBox error={error} title="Sign-in failed" compact /> : null}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
