/**
 * Minimal key-based query hook: cache, invalidate, refetch — the 60 lines a data-fetching
 * library would otherwise cost.
 *
 * Layer: shared (hook).
 *
 * The dependency manifest carries no client-side data library, so every feature that reads from
 * the mocked/real API needs the same handful of behaviours (loading/error state, invalidate-by-
 * key, interval refetch, abort on unmount). This hook is that shared minimum; it is not a general
 * cache and keeps no data between mounts.
 *
 * Status, data and error are one piece of state stamped with the key they describe, and the key is
 * compared on every render: a result is visible only while it still belongs to the key being asked
 * about. Holding them apart from the key would publish the previous key's result under the new key
 * for as long as the new load takes — a caller that reacts to `data` (auto-selecting a default, for
 * instance) would then act on data fetched for something else.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** Registered refetch callbacks, keyed by `JSON.stringify(key)`. */
const registry = new Map<string, Set<() => void>>();

/**
 * Re-runs every registered query whose key starts with `prefix`.
 *
 * @param prefix - Leading segments of the keys to refetch.
 */
export function invalidateQueries(prefix: readonly string[]): void {
  for (const [rawKey, callbacks] of registry) {
    const parsedKey = JSON.parse(rawKey) as string[];
    const matchesPrefix = prefix.every((segment, index) => parsedKey[index] === segment);
    if (matchesPrefix) {
      for (const callback of callbacks) {
        callback();
      }
    }
  }
}

/** Clears every registered query. Test-only: production code never needs a clean slate. */
export function clearQueryRegistry(): void {
  registry.clear();
}

/** Options of {@link useApiQuery}. */
export interface UseApiQueryOptions {
  /** Set to `false` to skip fetching (e.g. a dependent query with no id yet). */
  enabled?: boolean;
  /** Re-runs the loader on this interval while `enabled`. */
  refetchIntervalMs?: number;
  /** Re-runs the loader whenever the window regains focus. */
  refetchOnWindowFocus?: boolean;
}

/** Result of {@link useApiQuery}. */
export interface UseApiQueryResult<T> {
  status: 'idle' | 'loading' | 'success' | 'error';
  data: T | undefined;
  error: Error | undefined;
  refetch: () => Promise<void>;
  isRefetching: boolean;
}

/**
 * Everything the hook publishes, plus the key it was produced for. The key travels with the values
 * so a render can tell whether they still describe the key being asked about.
 */
interface QueryState<T> {
  /** `JSON.stringify(key)` of the query these values belong to. */
  keyString: string;
  status: UseApiQueryResult<T>['status'];
  data: T | undefined;
  error: Error | undefined;
  isRefetching: boolean;
}

/**
 * State of a key with nothing loaded for it yet: `loading` while the query is enabled (a fetch is
 * already scheduled for it), `idle` while it is not (nothing will fetch until it is enabled).
 *
 * @param keyString - The key these values describe.
 * @param enabled - Whether the query fetches for this key.
 * @returns The empty state for that key.
 */
function unloadedState<T>(keyString: string, enabled: boolean): QueryState<T> {
  return {
    keyString,
    status: enabled ? 'loading' : 'idle',
    data: undefined,
    error: undefined,
    isRefetching: false,
  };
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError';
}

/**
 * Fetches `loader` under `key`, caching nothing beyond the component's lifetime but registering
 * for {@link invalidateQueries} so other parts of the tree can trigger a refetch.
 *
 * Changing `key` discards the previous key's result immediately: the very next render reports
 * `loading` (or `idle` while disabled) with no data and no error, never the outgoing key's.
 *
 * @param key - Cache key; queries with the same `JSON.stringify(key)` share invalidation.
 * @param loader - Fetches the data; receives an `AbortSignal` aborted on unmount/key change.
 * @param options - `enabled`, interval refetch, window-focus refetch.
 * @returns The query's status, data, error, and manual controls.
 */
export function useApiQuery<T>(
  key: readonly string[],
  loader: (signal: AbortSignal) => Promise<T>,
  options: UseApiQueryOptions = {},
): UseApiQueryResult<T> {
  const { enabled = true, refetchIntervalMs, refetchOnWindowFocus = false } = options;
  const keyString = JSON.stringify(key);

  const [stored, setStored] = useState<QueryState<T>>(() => unloadedState<T>(keyString, enabled));
  // The stored values are still stamped with the outgoing key on the render that changes it — the
  // effect that starts the new load has not run yet, and no state may be written during a render
  // anyway. Reading through this comparison is what makes the change take effect at once: values
  // belonging to another key are simply not published.
  const state = stored.keyString === keyString ? stored : unloadedState<T>(keyString, enabled);

  // Callers typically pass a fresh closure every render (it captures render-scoped values like a
  // debounced query string). Reading through a ref — always the latest closure, but never a new
  // dependency — keeps `run` (and the effects below that depend on it) stable across renders that
  // don't change `keyString`, instead of refetching on every render and racing itself.
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });

  // `runKey` is the key this run fetches for. Every write but the first checks that the stored
  // state still belongs to it, so a run whose key has been replaced can neither publish its result
  // under the new key nor wipe what the new key has already loaded. Aborting covers the runs the
  // effects own; `refetch()` outlives a key change, and this covers that one.
  const run = useCallback(async (runKey: string, signal: AbortSignal, isRefetch: boolean) => {
    const update = (change: (current: QueryState<T>) => QueryState<T>): void => {
      setStored((previous) => (previous.keyString === runKey ? change(previous) : previous));
    };

    if (isRefetch) {
      update((current) => ({ ...current, isRefetching: true }));
    } else {
      // A first load claims the key outright: it is the write that makes the stored state describe
      // `runKey`, and it starts from nothing rather than from another key's data.
      setStored(unloadedState<T>(runKey, true));
    }
    try {
      const result = await loaderRef.current(signal);
      if (signal.aborted) {
        return;
      }
      update((current) => ({
        ...current,
        status: 'success',
        data: result,
        error: undefined,
        isRefetching: false,
      }));
    } catch (reason) {
      if (signal.aborted || isAbortError(reason)) {
        return;
      }
      update((current) => ({
        ...current,
        status: 'error',
        error: toError(reason),
        isRefetching: false,
      }));
    } finally {
      if (!signal.aborted) {
        // Returning `current` unchanged when nothing is in flight keeps the settled write above
        // from being followed by a second, identical-but-new state object on every load.
        update((current) => (current.isRefetching ? { ...current, isRefetching: false } : current));
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    // Deferred to a microtask: an effect must not call a state setter synchronously during its
    // own commit (it can trigger a cascading render). Scheduling the first fetch as a callback —
    // the same shape as the interval/focus refetches below — keeps this one consistent with them.
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        void run(keyString, controller.signal, false);
      }
    });

    const refetchCallback = () => {
      void run(keyString, controller.signal, true);
    };
    const subscribers = registry.get(keyString) ?? new Set<() => void>();
    subscribers.add(refetchCallback);
    registry.set(keyString, subscribers);

    return () => {
      controller.abort();
      subscribers.delete(refetchCallback);
      if (subscribers.size === 0) {
        registry.delete(keyString);
      }
    };
    // `keyString` is the effective identity of `key`; `run` is recreated only when `loader` is.
  }, [enabled, keyString, run]);

  useEffect(() => {
    if (!enabled || refetchIntervalMs === undefined) {
      return;
    }
    const controller = new AbortController();
    const interval = setInterval(() => {
      void run(keyString, controller.signal, true);
    }, refetchIntervalMs);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [enabled, keyString, refetchIntervalMs, run]);

  useEffect(() => {
    if (!enabled || !refetchOnWindowFocus) {
      return;
    }
    const controller = new AbortController();
    const handleFocus = () => {
      void run(keyString, controller.signal, true);
    };
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      controller.abort();
    };
  }, [enabled, keyString, refetchOnWindowFocus, run]);

  const refetch = useCallback(async () => {
    const controller = new AbortController();
    await run(keyString, controller.signal, true);
  }, [keyString, run]);

  return {
    status: state.status,
    data: state.data,
    error: state.error,
    refetch,
    isRefetching: state.isRefetching,
  };
}
