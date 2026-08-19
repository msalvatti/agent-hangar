/**
 * A tiny `localStorage`-backed store the shell subscribes to with `useSyncExternalStore`.
 *
 * Layer: feature (lib).
 *
 * Preferences that survive a reload (theme, whether the archive is expanded) are read during
 * render rather than assigned from an effect, which keeps the server-rendered markup and the
 * hydrated markup reconciled by React instead of by a cascading re-render.
 */

/** Everything currently subscribed to a stored preference. */
const listeners = new Set<() => void>();

/**
 * Subscribes to writes made through {@link writePersisted}.
 *
 * @param listener - Called after every write.
 * @returns Unsubscribe function.
 */
export function subscribePersisted(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reads a stored preference.
 *
 * @param key - Storage key.
 * @returns The stored string, or `null` when nothing is stored.
 */
export function readPersisted(key: string): string | null {
  return globalThis.localStorage.getItem(key);
}

/**
 * Writes a preference and notifies every subscriber.
 *
 * @param key - Storage key.
 * @param value - Value to store.
 */
export function writePersisted(key: string, value: string): void {
  globalThis.localStorage.setItem(key, value);
  for (const listener of listeners) {
    listener();
  }
}
