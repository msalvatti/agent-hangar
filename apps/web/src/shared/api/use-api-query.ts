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
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

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

  const [status, setStatus] = useState<UseApiQueryResult<T>['status']>('idle');
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [isRefetching, setIsRefetching] = useState(false);

  const run = useCallback(
    async (signal: AbortSignal, isRefetch: boolean) => {
      if (isRefetch) {
        setIsRefetching(true);
      } else {
        setStatus('loading');
      }
      try {
        const result = await loader(signal);
        if (signal.aborted) {
          return;
        }
        setData(result);
        setError(undefined);
        setStatus('success');
      } catch (reason) {
        if (signal.aborted || isAbortError(reason)) {
          return;
        }
        setError(toError(reason));
        setStatus('error');
      } finally {
        if (!signal.aborted) {
          setIsRefetching(false);
        }
      }
    },
    [loader],
  );

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
        void run(controller.signal, false);
      }
    });

    const refetchCallback = () => {
      void run(controller.signal, true);
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
      void run(controller.signal, true);
    }, refetchIntervalMs);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [enabled, refetchIntervalMs, run]);

  useEffect(() => {
    if (!enabled || !refetchOnWindowFocus) {
      return;
    }
    const controller = new AbortController();
    const handleFocus = () => {
      void run(controller.signal, true);
    };
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      controller.abort();
    };
  }, [enabled, refetchOnWindowFocus, run]);

  const refetch = useCallback(async () => {
    const controller = new AbortController();
    await run(controller.signal, true);
  }, [run]);

  return { status, data, error, refetch, isRefetching };
}
