import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "./components/Layout";
import { ErrorBox, Loading } from "./components/ui";
import { type ApiError, api, onUnauthorized, toApiError } from "./lib/api";
import { AuthContext, type AuthValue, hasRole } from "./lib/auth";
import { RefreshProvider } from "./lib/refresh";
import { useLocation } from "./lib/router";
import { AddHostPage } from "./pages/AddHostPage";
import { HostDetailPage } from "./pages/HostDetailPage";
import { IncidentDetailPage } from "./pages/IncidentDetailPage";
import { IncidentsPage } from "./pages/IncidentsPage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { RulesPage } from "./pages/RulesPage";
import type { UserDto, UserRole } from "./shared";

type Session =
  | { state: "checking" }
  | { state: "error"; error: ApiError }
  | { state: "signed-out"; expired: boolean }
  | { state: "signed-in"; user: UserDto };

function Routes() {
  const { segments } = useLocation();
  const [first, second, third] = segments;
  if (third === undefined) {
    if (first === undefined) return <OverviewPage />;
    if (first === "hosts" && second === "new") return <AddHostPage />;
    if (first === "hosts" && second) return <HostDetailPage key={second} hostId={second} />;
    if (first === "incidents" && second) return <IncidentDetailPage key={second} incidentId={second} />;
    if (second === undefined) {
      if (first === "incidents") return <IncidentsPage />;
      if (first === "rules") return <RulesPage />;
      if (first === "notifications") return <NotificationsPage />;
    }
  }
  return <NotFoundPage />;
}

function App() {
  const [session, setSession] = useState<Session>({ state: "checking" });

  const checkSession = useCallback(() => {
    setSession({ state: "checking" });
    api.me().then(
      (user) => setSession({ state: "signed-in", user }),
      (error: unknown) => {
        const e = toApiError(error);
        setSession(e.status === 401 ? { state: "signed-out", expired: false } : { state: "error", error: e });
      },
    );
  }, []);

  useEffect(() => {
    checkSession();
    onUnauthorized(() => setSession({ state: "signed-out", expired: true }));
    return () => onUnauthorized(null);
  }, [checkSession]);

  const logout = useCallback(() => {
    api.logout().then(
      () => setSession({ state: "signed-out", expired: false }),
      // Even if the server call fails the local view must not keep showing data.
      () => setSession({ state: "signed-out", expired: false }),
    );
  }, []);

  const user = session.state === "signed-in" ? session.user : null;
  const auth = useMemo<AuthValue | null>(
    () => (user ? { user, can: (role: UserRole) => hasRole(user, role), logout } : null),
    [user, logout],
  );

  if (session.state === "checking") {
    return (
      <div className="centered">
        <Loading label="Checking session…" />
      </div>
    );
  }
  if (session.state === "error") {
    return (
      <div className="centered">
        <ErrorBox error={session.error} title="Could not reach the monitoring API" onRetry={checkSession} />
      </div>
    );
  }
  if (session.state === "signed-out" || !auth) {
    return (
      <LoginPage
        expired={session.state === "signed-out" && session.expired}
        onLogin={(u) => setSession({ state: "signed-in", user: u })}
      />
    );
  }
  return (
    <AuthContext.Provider value={auth}>
      <RefreshProvider>
        <Layout>
          <Routes />
        </Layout>
      </RefreshProvider>
    </AuthContext.Provider>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
