import { useSyncExternalStore } from "react";

/**
 * Minimal hash router: "#/incidents?status=firing" → { path: "/incidents", query }.
 * Hash routing keeps the dashboard a static bundle that any reverse proxy can serve.
 */
export interface Location {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function getHash(): string {
  return window.location.hash;
}

export function parseHash(hash: string): Location {
  const raw = hash.replace(/^#/, "") || "/";
  const queryIndex = raw.indexOf("?");
  const pathPart = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const queryPart = queryIndex === -1 ? "" : raw.slice(queryIndex + 1);
  const path = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  return { path, segments, query: new URLSearchParams(queryPart) };
}

export function useLocation(): Location {
  const hash = useSyncExternalStore(subscribe, getHash, () => "");
  return parseHash(hash);
}

export function href(path: string, query?: URLSearchParams | Record<string, string>): string {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams(query);
  const text = params.toString();
  return `#${path}${text ? `?${text}` : ""}`;
}

export function navigate(
  path: string,
  query?: URLSearchParams | Record<string, string>,
  replace = false,
): void {
  const target = href(path, query);
  if (replace) {
    window.history.replaceState(null, "", target);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = target;
  }
}
