/**
 * Unit tests for the controllable `matchMedia` the shell's responsive suites are written against.
 *
 * Layer: unit (the double's own contract).
 * Goal: the two places this double behaves like a browser rather than like its callers stay that
 * way. A `MediaQueryList` notifies only the lists whose own answer changed, and only the listeners
 * registered for `change`. Both are what make a test about a hook's subscription mean something:
 * loosened, the double would report a hook as responsive while it had subscribed to an event no
 * browser emits, or while it was watching a query that never moved.
 * Mocks: none; the double is the unit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubMatchMedia } from './media-query';
import type { MatchMediaStub } from './media-query';

/** Two queries a component might hold at once. */
const NARROW = '(max-width: 640px)';
const WIDE = '(min-width: 1024px)';

let media: MatchMediaStub | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

describe('stubMatchMedia', () => {
  /** The initial set decides what each list answers before anything changes. */
  it('answers each query from the matching set it was given', () => {
    media = stubMatchMedia([WIDE]);

    expect(globalThis.matchMedia(WIDE).matches).toBe(true);
    expect(globalThis.matchMedia(NARROW).matches).toBe(false);
    expect(globalThis.matchMedia(WIDE).media).toBe(WIDE);
  });

  /**
   * Only the lists whose answer changed are notified, which is what a browser does: a component
   * watching a breakpoint the viewport never crossed is not re-rendered because some other
   * breakpoint was.
   */
  it('notifies only the queries whose answer changed', () => {
    media = stubMatchMedia([]);
    const narrow = vi.fn();
    const wide = vi.fn();
    globalThis.matchMedia(NARROW).addEventListener('change', narrow);
    globalThis.matchMedia(WIDE).addEventListener('change', wide);

    media.set([WIDE]);

    expect(wide).toHaveBeenCalledTimes(1);
    expect(narrow).not.toHaveBeenCalled();
  });

  /**
   * And only the listeners registered for `change`, the one event a `MediaQueryList` emits. A
   * subscription under any other name hears nothing, which is exactly what a hook that got the
   * name wrong would experience in a browser.
   */
  it('notifies only the change listeners', () => {
    media = stubMatchMedia([]);
    const onChange = vi.fn();
    const onSomethingElse = vi.fn();
    globalThis.matchMedia(WIDE).addEventListener('change', onChange);
    globalThis.matchMedia(WIDE).addEventListener('resize', onSomethingElse);

    media.set([WIDE]);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onSomethingElse).not.toHaveBeenCalled();
    expect(media.listenerCount(WIDE, 'resize')).toBe(1);
  });

  /**
   * A list whose answer changed while nothing is listening for `change` is simply not notified —
   * not a lookup that fails. A component may hold a subscription under another name, and the
   * double has to walk past it rather than trip over it.
   */
  it('passes over a changed query that has no change listener', () => {
    media = stubMatchMedia([]);
    const onSomethingElse = vi.fn();
    globalThis.matchMedia(WIDE).addEventListener('resize', onSomethingElse);

    expect(() => {
      media?.set([WIDE]);
    }).not.toThrow();

    expect(onSomethingElse).not.toHaveBeenCalled();
    expect(globalThis.matchMedia(WIDE).matches).toBe(true);
  });

  /** A removed listener stops hearing, and the count says so. */
  it('forgets a listener that was removed', () => {
    media = stubMatchMedia([]);
    const onChange = vi.fn();
    const list = globalThis.matchMedia(WIDE);
    list.addEventListener('change', onChange);
    expect(media.listenerCount(WIDE)).toBe(1);

    list.removeEventListener('change', onChange);
    media.set([WIDE]);

    expect(media.listenerCount(WIDE)).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  /** A query nobody ever asked about has no listeners, rather than no answer. */
  it('reports no listeners for a query it has never seen', () => {
    media = stubMatchMedia([]);

    expect(media.listenerCount(NARROW)).toBe(0);
  });

  /** Restoring puts back whatever was there, so one suite cannot leak into the next. */
  it('restores the original implementation', () => {
    const original = globalThis.matchMedia;
    const stub = stubMatchMedia([]);

    stub.restore();

    expect(globalThis.matchMedia).toBe(original);
  });
});
