/**
 * Test helper installing a controllable `matchMedia` for the shell's responsive tests.
 *
 * Layer: feature (testing).
 */

/** Controls the queries a test wants to report as matching. */
export interface MatchMediaStub {
  /** Replaces the set of matching queries and notifies every listener. */
  set: (matching: readonly string[]) => void;
  /** Restores the original `matchMedia`. */
  restore: () => void;
}

/**
 * Installs a `matchMedia` stub reporting exactly the given queries as matching.
 *
 * @param matching - Queries that match initially.
 * @returns Controls to change the matching set and to restore the original implementation.
 */
export function stubMatchMedia(matching: readonly string[]): MatchMediaStub {
  const original = globalThis.matchMedia;
  const listeners = new Map<string, Set<() => void>>();
  let current = new Set(matching);

  // Installed with `defineProperty` rather than an assignment: `MediaQueryList` declares
  // mutually-narrowing `addEventListener` overloads that no single hand-written signature
  // satisfies, and this keeps the stub honest instead of casting it into the nominal type.
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: current.has(query),
      media: query,
      addEventListener: (_type: string, listener: () => void) => {
        const set = listeners.get(query) ?? new Set<() => void>();
        set.add(listener);
        listeners.set(query, set);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.get(query)?.delete(listener);
      },
    }),
  });

  return {
    set: (next) => {
      current = new Set(next);
      for (const set of listeners.values()) {
        for (const listener of set) {
          listener();
        }
      }
    },
    restore: () => {
      Object.defineProperty(globalThis, 'matchMedia', {
        configurable: true,
        writable: true,
        value: original,
      });
    },
  };
}
