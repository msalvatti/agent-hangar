/**
 * Reading values only the browser can produce, without desynchronising hydration.
 *
 * Layer: hook.
 *
 * A fact the server cannot know — the platform behind `navigator`, the reader's timezone — must
 * never decide server-rendered markup: the two passes would disagree and React would report a
 * hydration mismatch and throw the server's tree away. These hooks report `null` while the markup
 * is being produced and while it is being hydrated, then re-render with the real value once the
 * browser has taken over, so both passes emit identical markup by construction. Callers render the
 * `null` case as an honest absence rather than as a guess, so nothing they show is ever wrong.
 */
'use client';

import { useSyncExternalStore } from 'react';

/**
 * Releases the subscription {@link subscribe} never took out.
 */
function unsubscribe(): void {
  // Nothing was registered, so there is nothing to tear down.
}

/**
 * Subscribes to a value that cannot change.
 *
 * @returns The no-op unsubscribe, stable so React never re-subscribes.
 */
function subscribe(): () => void {
  return unsubscribe;
}

/**
 * The value seen while server-rendering and hydrating: nothing is known yet.
 *
 * @returns `null`.
 */
function serverSnapshot(): null {
  return null;
}

/**
 * Reads a browser-only value, reporting `null` until the browser has taken the tree over.
 *
 * @param read - Reads the value from the browser. Must return the same primitive on every call,
 *   since these facts are fixed for the document's lifetime and React re-reads on every render.
 * @returns The value in the browser, `null` while server-rendering and hydrating.
 */
export function useClientOnly<T>(read: () => T): T | null {
  return useSyncExternalStore<T | null>(subscribe, read, serverSnapshot);
}

/**
 * Reads the IANA timezone the browser is configured for.
 *
 * @returns The resolved zone name (`Intl` always resolves one).
 */
function readLocalTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The reader's own timezone, for turning an instant into the wall-clock time they keep.
 *
 * @returns The IANA zone name, `null` while server-rendering and hydrating.
 */
export function useLocalTimeZone(): string | null {
  return useClientOnly(readLocalTimeZone);
}
