/**
 * Debounced repository search for {@link RepoPicker}.
 *
 * Layer: shared (hook).
 */
'use client';

import { useEffect, useState } from 'react';

import { apiFetch } from '@/shared/api/client';
import { useApiQuery } from '@/shared/api/use-api-query';
import type { UseApiQueryResult } from '@/shared/api/use-api-query';

/** How long to wait after the last keystroke before searching. */
const DEBOUNCE_MS = 200;

/**
 * Debounces a value, only updating the returned value {@link DEBOUNCE_MS} after it stops changing.
 *
 * @param value - The value to debounce.
 * @returns The debounced value.
 */
function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebounced(value);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timeout);
    };
  }, [value]);
  return debounced;
}

function listReposCall(query: string, signal: AbortSignal) {
  return apiFetch('listRepos', { query: { query }, signal });
}

/**
 * Repos matching `query` (debounced by {@link DEBOUNCE_MS}), from `GET /api/repos`.
 *
 * @param query - The search text, typically the picker's input value.
 * @returns The query result: status/data/error/refetch.
 */
export function useRepos(
  query: string,
): UseApiQueryResult<Awaited<ReturnType<typeof listReposCall>>> {
  const debouncedQuery = useDebounced(query);
  return useApiQuery(['repos', debouncedQuery], (signal) => listReposCall(debouncedQuery, signal));
}
