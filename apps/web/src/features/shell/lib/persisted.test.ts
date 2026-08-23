/**
 * Unit tests for the `localStorage`-backed preference store the shell subscribes to.
 *
 * Layer: unit.
 * Goal: a write is readable and reaches every current subscriber, and a subscriber that has
 * unsubscribed is no longer one.
 * Mocks: none; jsdom's own `localStorage`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readPersisted, subscribePersisted, writePersisted } from './persisted';

describe('persisted preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  /** Nothing stored is nothing read: the caller decides what the absence means. */
  it('reports null for a key that was never written', () => {
    expect(readPersisted('ah-test-key')).toBeNull();
  });

  /** A write is stored under its own key and read back verbatim. */
  it('stores a value and reads it back', () => {
    writePersisted('ah-test-key', 'column');

    expect(readPersisted('ah-test-key')).toBe('column');
    expect(localStorage.getItem('ah-test-key')).toBe('column');
  });

  /**
   * Every current subscriber is told. This is the whole point of the store: `useSyncExternalStore`
   * re-reads only when it is notified, so a preference changed in one component is what makes the
   * others re-render.
   */
  it('notifies every subscriber on a write', () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribePersisted(first);
    subscribePersisted(second);

    writePersisted('ah-test-key', 'rail');

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  /**
   * And an unsubscribed one is not. React calls the returned function when the component goes
   * away; a store that keeps the reference notifies a listener belonging to nothing, once per
   * mount, for the life of the page — and the set grows with every navigation.
   */
  it('stops notifying a subscriber that unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePersisted(listener);

    unsubscribe();
    writePersisted('ah-test-key', 'rail');

    expect(listener).not.toHaveBeenCalled();
  });
});
