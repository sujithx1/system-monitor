import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

export const REFRESH_INTERVAL_MS = 30_000;
const CLOCK_INTERVAL_MS = 10_000;

interface RefreshValue {
  /** Increments every 30 s while the tab is visible (and on manual refresh). */
  tick: number;
  /** Wall clock, re-rendered every 10 s so relative times stay fresh. */
  now: number;
  paused: boolean;
  refreshNow: () => void;
}

const RefreshContext = createContext<RefreshValue>({
  tick: 0,
  now: Date.now(),
  paused: false,
  refreshNow: () => {},
});

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Drives auto-refresh for every data hook below it. Polling pauses while the tab is hidden and
 * catches up immediately when it becomes visible again if the data went stale meanwhile.
 */
export function RefreshProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(() => ({ tick: 0, at: Date.now() }));
  const [hidden, setHidden] = useState(isHidden);
  const [now, setNow] = useState(() => Date.now());

  const refreshNow = useCallback(() => {
    setState((s) => ({ tick: s.tick + 1, at: Date.now() }));
  }, []);

  useEffect(() => {
    const onVisibility = () => setHidden(isHidden());
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (hidden) return;
    const delay = Math.max(0, REFRESH_INTERVAL_MS - (Date.now() - state.at));
    const timer = window.setTimeout(refreshNow, delay);
    return () => window.clearTimeout(timer);
  }, [hidden, state.at, refreshNow]);

  useEffect(() => {
    if (hidden) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hidden]);

  const value = useMemo(
    () => ({ tick: state.tick, now, paused: hidden, refreshNow }),
    [state.tick, now, hidden, refreshNow],
  );
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefresh(): RefreshValue {
  return useContext(RefreshContext);
}
