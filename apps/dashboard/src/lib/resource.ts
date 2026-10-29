import type { Page } from "@system-monitor/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiError, toApiError } from "./api";
import { useRefresh } from "./refresh";

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | null;
  /** True while any request (initial or refresh) is in flight. */
  loading: boolean;
  updatedAt: number | null;
  reload: () => void;
}

interface ResourceState<T> {
  key: string | null;
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  updatedAt: number | null;
}

/**
 * Loads data for `key` and re-fetches it on every auto-refresh tick. Data from a previous key is
 * never shown for a new one; a failed refresh keeps the last good data alongside the error.
 */
export function useResource<T>(
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
  options: { autoRefresh?: boolean } = {},
): Resource<T> {
  const { tick } = useRefresh();
  const autoTick = options.autoRefresh === false ? 0 : tick;
  const [reloadCount, setReloadCount] = useState(0);
  const [state, setState] = useState<ResourceState<T>>({
    key: null,
    data: undefined,
    error: null,
    loading: true,
    updatedAt: null,
  });
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: autoTick and reloadCount are refetch triggers.
  useEffect(() => {
    const controller = new AbortController();
    setState((s) => (s.key === key ? { ...s, loading: true } : { ...s, loading: true, error: null }));
    loaderRef.current(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        setState({ key, data, error: null, loading: false, updatedAt: Date.now() });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState((s) =>
          s.key === key
            ? { ...s, error: toApiError(error), loading: false }
            : { key, data: undefined, error: toApiError(error), loading: false, updatedAt: null },
        );
      },
    );
    return () => controller.abort();
  }, [key, autoTick, reloadCount]);

  const reload = useCallback(() => setReloadCount((n) => n + 1), []);
  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : null,
    loading: state.loading || !current,
    updatedAt: current ? state.updatedAt : null,
    reload,
  };
}

export interface PagedResource<T> {
  items: T[] | undefined;
  hasMore: boolean;
  error: ApiError | null;
  loading: boolean;
  loadingMore: boolean;
  loadMoreError: ApiError | null;
  loadMore: () => void;
  reload: () => void;
}

interface PagedState<T> {
  key: string | null;
  items: T[] | undefined;
  nextCursor: string | null;
  error: ApiError | null;
  loading: boolean;
}

const MAX_REFRESH_LIMIT = 200;

/**
 * Keyset-paginated list ("Load more"). Auto-refresh re-reads everything loaded so far in one
 * request (up to the API's 200-item page limit) so new items appear without losing the
 * position; beyond that, auto-refresh is skipped to keep what the user scrolled through stable.
 */
export function usePagedResource<T extends { id: string }>(
  key: string,
  fetchPage: (cursor: string | null, limit: number, signal: AbortSignal) => Promise<Page<T>>,
  pageSize = 50,
): PagedResource<T> {
  const { tick } = useRefresh();
  const [reloadCount, setReloadCount] = useState(0);
  const [state, setState] = useState<PagedState<T>>({
    key: null,
    items: undefined,
    nextCursor: null,
    error: null,
    loading: true,
  });
  const [more, setMore] = useState<{ loading: boolean; error: ApiError | null }>({
    loading: false,
    error: null,
  });
  const fetchRef = useRef(fetchPage);
  useEffect(() => {
    fetchRef.current = fetchPage;
  });
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const moreController = useRef<AbortController | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick and reloadCount are refetch triggers.
  useEffect(() => {
    const previous = stateRef.current;
    const sameKey = previous.key === key && previous.items !== undefined;
    const loaded = sameKey && previous.items ? previous.items.length : 0;
    if (sameKey && loaded > MAX_REFRESH_LIMIT) return;
    const limit = Math.min(MAX_REFRESH_LIMIT, Math.max(pageSize, loaded));
    const controller = new AbortController();
    if (!sameKey) {
      moreController.current?.abort();
      setMore({ loading: false, error: null });
    }
    setState((s) =>
      s.key === key
        ? { ...s, loading: true }
        : { key, items: undefined, nextCursor: null, error: null, loading: true },
    );
    fetchRef.current(null, limit, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        setState({ key, items: page.items, nextCursor: page.nextCursor, error: null, loading: false });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState((s) => ({ ...s, key, error: toApiError(error), loading: false }));
      },
    );
    return () => controller.abort();
  }, [key, tick, reloadCount, pageSize]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (!current.nextCursor || current.key !== key) return;
    moreController.current?.abort();
    const controller = new AbortController();
    moreController.current = controller;
    setMore({ loading: true, error: null });
    fetchRef.current(current.nextCursor, pageSize, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        setState((s) => {
          if (s.key !== key) return s;
          const seen = new Set((s.items ?? []).map((i) => i.id));
          return {
            ...s,
            items: [...(s.items ?? []), ...page.items.filter((i) => !seen.has(i.id))],
            nextCursor: page.nextCursor,
          };
        });
        setMore({ loading: false, error: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setMore({ loading: false, error: toApiError(error) });
      },
    );
  }, [key, pageSize]);

  useEffect(() => () => moreController.current?.abort(), []);

  const reload = useCallback(() => setReloadCount((n) => n + 1), []);
  const current = state.key === key;
  return {
    items: current ? state.items : undefined,
    hasMore: current && state.nextCursor !== null,
    error: current ? state.error : null,
    loading: state.loading || !current,
    loadingMore: more.loading,
    loadMoreError: more.error,
    loadMore,
    reload,
  };
}
