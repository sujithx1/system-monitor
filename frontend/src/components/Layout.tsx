import type { ReactNode } from "react";
import { useAuth } from "../lib/auth";
import { href, useLocation } from "../lib/router";

interface NavItem {
  path: string;
  label: string;
  match: (path: string) => boolean;
}

const NAV: NavItem[] = [
  {
    path: "/",
    label: "Overview",
    match: (p) => p === "/" || (p.startsWith("/hosts/") && p !== "/hosts/new"),
  },
  { path: "/incidents", label: "Incidents", match: (p) => p.startsWith("/incidents") },
  { path: "/rules", label: "Alert rules", match: (p) => p.startsWith("/rules") },
  { path: "/notifications", label: "Notifications", match: (p) => p.startsWith("/notifications") },
];

const ADMIN_NAV: NavItem[] = [{ path: "/hosts/new", label: "Add host", match: (p) => p === "/hosts/new" }];

export function Layout({ children }: { children: ReactNode }) {
  const { user, can, logout } = useAuth();
  const location = useLocation();
  const items = can("admin") ? [...NAV, ...ADMIN_NAV] : NAV;
  return (
    <div className="app">
      {/* A button, not an anchor: "#main" would be read as a route by the hash router. */}
      <button type="button" className="skip-link" onClick={() => document.getElementById("main")?.focus()}>
        Skip to content
      </button>
      <header className="topbar">
        <a className="brand" href={href("/")}>
          <span className="brand-mark" aria-hidden="true">
            ◆
          </span>
          System Monitor
        </a>
        <nav className="nav" aria-label="Main">
          {items.map((item) => {
            const active = item.match(location.path);
            return (
              <a
                key={item.path}
                href={href(item.path)}
                className={`nav-link${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
        <div className="user-menu">
          <span className="user-name" title={user.email}>
            {user.displayName ?? user.email}
          </span>
          <span className={`role-chip role-${user.role}`}>{user.role}</span>
          <button type="button" className="btn btn-small" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
