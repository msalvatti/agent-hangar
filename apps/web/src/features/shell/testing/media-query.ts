/**
 * Test helper installing a controllable `matchMedia` for the shell's responsive tests.
 *
 * Layer: feature (testing).
 *
 * The stub behaves the way a browser's `MediaQueryList` does, because a double that is kinder than
 * the real thing measures nothing: a listener is registered under the event type it was added with
 * and is notified only for that type, and changing the matching set notifies only the lists whose
 * own answer changed. A stub that fired every listener on every change would report a hook as
 * responsive even if it had subscribed to an event no browser emits.
 */

/** Controls the queries a test wants to report as matching. */
export interface MatchMediaStub {
  /** Replaces the set of matching queries and notifies the lists whose answer changed. */
  set: (matching: readonly string[]) => void;
  /**
   * How many listeners are currently registered for one query and event type.
   *
   * @param query - The media query.
   * @param type - The event type, defaulting to the only one a `MediaQueryList` emits.
   * @returns The number of live listeners.
   */
  listenerCount: (query: string, type?: string) => number;
  /** Restores the original `matchMedia`. */
  restore: () => void;
}

/** The only event a `MediaQueryList` emits. */
const CHANGE = 'change';

/**
 * Installs a `matchMedia` stub reporting exactly the given queries as matching.
 *
 * @param matching - Queries that match initially.
 * @returns Controls to change the matching set, to count listeners and to restore the original
 *   implementation.
 */
export function stubMatchMedia(matching: readonly string[]): MatchMediaStub {
  const original = globalThis.matchMedia;
  /** Listeners per query, then per event type, exactly as a real target keeps them. */
  const listeners = new Map<string, Map<string, Set<() => void>>>();
  let current = new Set(matching);

  /**
   * Listener sets of one query, created on first use.
   *
   * @param query - The media query.
   * @returns The query's listeners, keyed by event type.
   */
  function byType(query: string): Map<string, Set<() => void>> {
    const existing = listeners.get(query);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Map<string, Set<() => void>>();
    listeners.set(query, created);
    return created;
  }

  // Installed with `defineProperty` rather than an assignment: `MediaQueryList` declares
  // mutually-narrowing `addEventListener` overloads that no single hand-written signature
  // satisfies, and this keeps the stub honest instead of casting it into the nominal type.
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: current.has(query),
      media: query,
      addEventListener: (type: string, listener: () => void) => {
        const types = byType(query);
        const set = types.get(type) ?? new Set<() => void>();
        set.add(listener);
        types.set(type, set);
      },
      removeEventListener: (type: string, listener: () => void) => {
        listeners.get(query)?.get(type)?.delete(listener);
      },
    }),
  });

  return {
    set: (next) => {
      const previous = current;
      current = new Set(next);
      for (const [query, types] of listeners) {
        if (previous.has(query) === current.has(query)) {
          continue;
        }
        for (const listener of types.get(CHANGE) ?? []) {
          listener();
        }
      }
    },
    listenerCount: (query, type = CHANGE) => listeners.get(query)?.get(type)?.size ?? 0,
    restore: () => {
      Object.defineProperty(globalThis, 'matchMedia', {
        configurable: true,
        writable: true,
        value: original,
      });
    },
  };
}
