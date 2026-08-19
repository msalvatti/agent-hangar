/**
 * Subscribes to a CSS media query so layout decisions that CSS cannot express (which component
 * tree to mount) can react to the viewport.
 *
 * Layer: feature (hook).
 */
'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether `query` currently matches.
 *
 * @param query - A CSS media query, e.g. `(min-width: 1024px)`.
 * @param serverValue - Value used while server-rendering and hydrating.
 * @returns `true` while the query matches.
 */
export function useMediaQuery(query: string, serverValue: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = globalThis.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => {
        list.removeEventListener('change', onChange);
      };
    },
    [query],
  );
  const getSnapshot = useCallback(() => globalThis.matchMedia(query).matches, [query]);
  const getServerSnapshot = useCallback(() => serverValue, [serverValue]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
