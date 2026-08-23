/**
 * Tests for the shared key-based query hook: loading/error state, invalidation, interval and
 * focus refetch, and abort semantics.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearQueryRegistry, invalidateQueries, useApiQuery } from './use-api-query';

/** Flushes the microtask the hook uses to defer its first fetch out of the effect body. */
async function flushMicrotask(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  clearQueryRegistry();
});

describe('useApiQuery', () => {
  // An enabled query reports "loading" from its very first render — the fetch is already
  // scheduled, so "idle" (which callers render as "nothing is happening") would misdescribe it —
  // and settles on "success" with the resolved data.
  it('transitions from loading to success', async () => {
    let resolveLoader: (value: string) => void = () => {
      // Replaced once the loader is invoked.
    };
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoader = resolve;
        }),
    );
    const { result } = renderHook(() => useApiQuery(['a'], loader));
    expect(result.current.status).toBe('loading');
    await flushMicrotask();
    expect(result.current.status).toBe('loading');
    await act(async () => {
      resolveLoader('value');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data).toBe('value');
    expect(result.current.error).toBeUndefined();
  });

  // A rejected loader surfaces status "error" with the wrapped Error.
  it('transitions to error on a rejected loader', async () => {
    const loader = vi.fn(() => Promise.reject(new Error('boom')));
    const { result } = renderHook(() => useApiQuery(['b'], loader));
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error?.message).toBe('boom');
  });

  // A non-Error rejection is wrapped so `.message` is always available.
  it('wraps a non-Error rejection', async () => {
    // `mockRejectedValue` accepts any reason, so the rejection stays a plain string and the test
    // proves `toError()` wraps a non-Error reason via `String(reason)`.
    const loader = vi.fn().mockRejectedValue('plain string');
    const { result } = renderHook(() => useApiQuery(['b2'], loader));
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error?.message).toBe('plain string');
  });

  // Unmounting before the deferred first fetch's microtask runs cancels it outright: the loader
  // is never called at all.
  it('never calls the loader when unmounted before the deferred fetch runs', async () => {
    const loader = vi.fn(() => Promise.resolve('value'));
    const { unmount } = renderHook(() => useApiQuery(['unmount-before-fetch'], loader));
    unmount();
    await flushMicrotask();
    expect(loader).not.toHaveBeenCalled();
  });

  // enabled: false never runs the loader and the query stays idle.
  it('stays idle when enabled is false', async () => {
    const loader = vi.fn(() => Promise.resolve('value'));
    const { result } = renderHook(() => useApiQuery(['c'], loader, { enabled: false }));
    expect(result.current.status).toBe('idle');
    expect(loader).not.toHaveBeenCalled();

    // And still not once the deferred fetch would have run: the first load is scheduled as a
    // microtask, so a guard that only delayed it would let a disabled query fetch a tick later.
    await act(async () => {
      await Promise.resolve();
    });
    expect(loader).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  // refetch() re-runs the loader and reports isRefetching while in flight.
  it('refetch() re-runs the loader', async () => {
    const loader = vi.fn(() => Promise.resolve('first'));
    const { result } = renderHook(() => useApiQuery(['d'], loader));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    loader.mockResolvedValueOnce('second');
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data).toBe('second');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  // invalidateQueries(prefix) re-runs every registered query whose key starts with the prefix.
  it('invalidateQueries re-runs matching queries and skips non-matching ones', async () => {
    const matching = vi.fn(() => Promise.resolve('m'));
    const other = vi.fn(() => Promise.resolve('o'));
    const { result: matchResult } = renderHook(() => useApiQuery(['chats', '1'], matching));
    const { result: otherResult } = renderHook(() => useApiQuery(['jobs', '1'], other));
    await waitFor(() => {
      expect(matchResult.current.status).toBe('success');
      expect(otherResult.current.status).toBe('success');
    });
    act(() => {
      invalidateQueries(['chats']);
    });
    await waitFor(() => {
      expect(matching).toHaveBeenCalledTimes(2);
    });
    expect(other).toHaveBeenCalledTimes(1);

    // Every segment of the prefix has to match, not merely one of them: `['chats','1']` and
    // `['chats','2']` are two chats, and invalidating one must not refetch the other.
    act(() => {
      invalidateQueries(['chats', '2']);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(matching).toHaveBeenCalledTimes(2);
  });

  // Unmounting one of several subscribers sharing a key leaves the others registered.
  it('keeps the registry entry when a sibling subscriber remains', async () => {
    const loaderA = vi.fn(() => Promise.resolve('a'));
    const loaderB = vi.fn(() => Promise.resolve('b'));
    const first = renderHook(() => useApiQuery(['shared'], loaderA));
    const second = renderHook(() => useApiQuery(['shared'], loaderB));
    await waitFor(() => {
      expect(first.result.current.status).toBe('success');
      expect(second.result.current.status).toBe('success');
    });
    first.unmount();
    act(() => {
      invalidateQueries(['shared']);
    });
    await waitFor(() => {
      expect(loaderB).toHaveBeenCalledTimes(2);
    });
    // The one that left is no longer asked. Its controller is aborted, so its answer would be
    // discarded — but the request still goes out, on every invalidation, for every component the
    // user has navigated away from.
    expect(loaderA).toHaveBeenCalledTimes(1);

    second.unmount();
    act(() => {
      invalidateQueries(['shared']);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // With nobody left the key is forgotten altogether, rather than kept with an empty set that
    // every later invalidation walks.
    expect(loaderB).toHaveBeenCalledTimes(2);
  });

  // clearQueryRegistry() removes every subscription so a stale invalidate call is a no-op.
  it('clearQueryRegistry() removes subscriptions', async () => {
    const loader = vi.fn(() => Promise.resolve('v'));
    const { result } = renderHook(() => useApiQuery(['e'], loader));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    clearQueryRegistry();
    act(() => {
      invalidateQueries(['e']);
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  /**
   * Neither the poll nor the focus refetch blanks what is on screen: both are refreshes of a query
   * that already has data, and starting from nothing would flicker the page every interval.
   */
  it.each([
    [
      'the interval',
      async (): Promise<void> => {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      },
    ],
    [
      'window focus',
      async (): Promise<void> => {
        act(() => {
          window.dispatchEvent(new Event('focus'));
        });
        await act(async () => {
          await Promise.resolve();
        });
      },
    ],
  ])('keeps the data on screen across %s', async (_case, trigger) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let release = (): void => undefined;
      const loader = vi.fn(() => Promise.resolve('first'));
      const { result } = renderHook(() =>
        useApiQuery(['keeps-data', _case], loader, {
          refetchIntervalMs: 1_000,
          refetchOnWindowFocus: true,
        }),
      );
      await waitFor(() => {
        expect(result.current.data).toBe('first');
      });

      loader.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            release = () => {
              resolve('second');
            };
          }),
      );
      await trigger();

      await waitFor(() => {
        expect(result.current.isRefetching).toBe(true);
      });
      expect(result.current.data).toBe('first');
      await act(async () => {
        release();
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Both refreshes stop when the component does. A timer left running polls for a page nobody is
   * looking at, and a focus listener left attached does the same every time the window is touched
   * — for every query the user has ever navigated away from.
   */
  it('stops polling and stops listening once unmounted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const loader = vi.fn(() => Promise.resolve('v'));
      const { result, unmount } = renderHook(() =>
        useApiQuery(['stops-on-unmount'], loader, {
          refetchIntervalMs: 1_000,
          refetchOnWindowFocus: true,
        }),
      );
      await waitFor(() => {
        expect(result.current.status).toBe('success');
      });
      const settled = loader.mock.calls.length;

      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(loader).toHaveBeenCalledTimes(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The poll follows the key. A component that switches to another chat must poll that one — a
   * timer left pointing at the key it was created with refreshes a transcript nobody is reading
   * and never refreshes the one on screen.
   */
  it('polls the key it is currently showing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const loader = vi.fn(() => Promise.resolve('v'));
      const { result, rerender } = renderHook(
        ({ id }: { id: string }) =>
          useApiQuery(['polls', id], loader, { refetchIntervalMs: 1_000 }),
        { initialProps: { id: 'a' } },
      );
      await waitFor(() => {
        expect(result.current.status).toBe('success');
      });

      rerender({ id: 'b' });
      await waitFor(() => {
        expect(result.current.status).toBe('success');
      });
      const beforeTick = loader.mock.calls.length;
      let release = (): void => undefined;
      loader.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            release = () => {
              resolve('v');
            };
          }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      // One poll, for the key on screen — not one for each key the component has ever held.
      expect(loader).toHaveBeenCalledTimes(beforeTick + 1);
      // And it is *this* key's poll: a timer still pointing at the key it was created with writes
      // into a store that has moved on, so nothing on screen would ever say it was refreshing.
      await waitFor(() => {
        expect(result.current.isRefetching).toBe(true);
      });
      await act(async () => {
        release();
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The focus refetch and the manual one follow the key too, for the same reason: a refresh
   * addressed to the key the component used to show is a request whose answer nothing renders.
   */
  it.each([
    [
      'window focus',
      async (refetch: () => Promise<void>): Promise<void> => {
        act(() => {
          window.dispatchEvent(new Event('focus'));
        });
        await Promise.resolve(refetch);
      },
    ],
    [
      'a manual refetch',
      async (refetch: () => Promise<void>): Promise<void> => {
        void refetch();
        await Promise.resolve();
      },
    ],
  ])('refreshes the key it is currently showing on %s', async (_case, trigger) => {
    let release = (): void => undefined;
    const loader = vi.fn(() => Promise.resolve('v'));
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        useApiQuery(['refreshes', _case, id], loader, { refetchOnWindowFocus: true }),
      { initialProps: { id: 'a' } },
    );
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    rerender({ id: 'b' });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    loader.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = () => {
            resolve('v');
          };
        }),
    );

    await act(async () => {
      await trigger(result.current.refetch);
    });

    await waitFor(() => {
      expect(result.current.isRefetching).toBe(true);
    });
    await act(async () => {
      release();
      await Promise.resolve();
    });
  });

  /**
   * A query that is switched off while its first load is in flight must not publish that load: the
   * caller turned it off, and an answer arriving afterwards puts data on screen for a query the
   * component has stopped asking.
   */
  it('publishes nothing from a load that was switched off under it', async () => {
    let release = (): void => undefined;
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = () => {
            resolve('late');
          };
        }),
    );
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useApiQuery(['switched-off'], loader, { enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => {
      expect(loader).toHaveBeenCalled();
    });

    rerender({ enabled: false });
    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.status).not.toBe('success');
  });

  // refetchIntervalMs re-runs the loader on a timer while enabled.
  it('refetches on the configured interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const loader = vi.fn(() => Promise.resolve('v'));
    const { result } = renderHook(() => useApiQuery(['f'], loader, { refetchIntervalMs: 1_000 }));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(loader).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  /*
   * A hidden tab learns nothing from a poll, so the timer fires and does nothing. This is the
   * branch that keeps a backgrounded window from re-reading health forever; `refetchOnWindowFocus`
   * is what brings it back up to date the moment somebody looks at it again.
   */
  it('skips the interval refetch while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    try {
      const loader = vi.fn(() => Promise.resolve('v'));
      const { result } = renderHook(() =>
        useApiQuery(['f-hidden'], loader, { refetchIntervalMs: 1_000 }),
      );
      await waitFor(() => {
        expect(result.current.status).toBe('success');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(loader).toHaveBeenCalledTimes(1);

      hidden.mockReturnValue(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      hidden.mockRestore();
      vi.useRealTimers();
    }
  });

  // refetchOnWindowFocus re-runs the loader when the window fires a focus event.
  it('refetches on window focus when enabled', async () => {
    const loader = vi.fn(() => Promise.resolve('v'));
    const { result } = renderHook(() => useApiQuery(['g'], loader, { refetchOnWindowFocus: true }));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(2);
    });
  });

  // Without refetchOnWindowFocus, a focus event changes nothing.
  it('ignores window focus when refetchOnWindowFocus is unset', async () => {
    const loader = vi.fn(() => Promise.resolve('v'));
    const { result } = renderHook(() => useApiQuery(['h'], loader));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  // Unmounting aborts the in-flight request; the loader observes an aborted signal.
  it('aborts the loader signal on unmount', async () => {
    let capturedSignal: AbortSignal | undefined;
    const loader = vi.fn((signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<string>(() => {
        // Never resolves; the test only inspects the signal.
      });
    });
    const { unmount } = renderHook(() => useApiQuery(['i'], loader));
    await flushMicrotask();
    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  // Changing the key aborts the previous in-flight request and starts a fresh one.
  it('aborts the previous request when the key changes', async () => {
    const signals: AbortSignal[] = [];
    const loader = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<string>(() => {
        // Never resolves; the test only inspects the signals.
      });
    });
    const { rerender } = renderHook(({ id }: { id: string }) => useApiQuery(['j', id], loader), {
      initialProps: { id: '1' },
    });
    await flushMicrotask();
    rerender({ id: '2' });
    await flushMicrotask();
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  // If the loader resolves after its signal was already aborted (unmount raced the response),
  // state is left untouched instead of updating an unmounted query.
  it('discards a late resolution whose signal is already aborted', async () => {
    let resolveLoader: (value: string) => void = () => {
      // Replaced once the loader is invoked.
    };
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoader = resolve;
        }),
    );
    const { unmount } = renderHook(() => useApiQuery(['late'], loader));
    await flushMicrotask();
    unmount();
    await act(async () => {
      resolveLoader('too late');
      await Promise.resolve();
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  // A result belongs to the key it was fetched for. The moment the key changes, the previous key's
  // data and error are gone and the query reports the new key's own first load — publishing them
  // until the new load resolves would present one key's result as the other's, and a caller that
  // acts on `data` (auto-selecting a default, say) would act on data fetched for something else.
  it('never reports the previous key data after the key changes', async () => {
    const resolvers: ((value: string) => void)[] = [];
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useApiQuery(['key-change', id], loader),
      { initialProps: { id: '1' } },
    );
    await flushMicrotask();
    await act(async () => {
      resolvers[0]?.('first');
      await Promise.resolve();
    });
    expect(result.current.data).toBe('first');

    rerender({ id: '2' });
    expect(result.current.data).toBeUndefined();
    expect(result.current.status).toBe('loading');
    expect(result.current.isRefetching).toBe(false);

    // Still nothing once the second load is under way, and only then the second key's own data.
    await flushMicrotask();
    expect(result.current.data).toBeUndefined();
    await act(async () => {
      resolvers[1]?.('second');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.data).toBe('second');
    });
  });

  // The same rule for a failure: an error describes the key that failed, so a key change clears it
  // instead of showing the new key as broken before it has even been asked for.
  it('never reports the previous key error after the key changes', async () => {
    const loader = vi.fn(() => Promise.reject(new Error('boom')));
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useApiQuery(['error-key-change', id], loader),
      { initialProps: { id: '1' } },
    );
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    rerender({ id: '2' });
    expect(result.current.error).toBeUndefined();
    expect(result.current.status).toBe('loading');
  });

  // A disabled query reports "idle" for the key it is asked about, not the loaded data of the key
  // it was enabled for: switching to a key that fetches nothing must leave nothing behind.
  it('reports idle with no data when the key changes while disabled', async () => {
    const loader = vi.fn(() => Promise.resolve('value'));
    const { result, rerender } = renderHook(
      ({ id, enabled }: { id: string; enabled: boolean }) =>
        useApiQuery(['disabled-key-change', id], loader, { enabled }),
      { initialProps: { id: '1', enabled: true } },
    );
    await waitFor(() => {
      expect(result.current.data).toBe('value');
    });

    rerender({ id: '2', enabled: false });
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeUndefined();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  // A refetch outlives a key change (its own controller is never aborted), so its late result must
  // be dropped rather than overwrite what the current key has already loaded.
  it('ignores a refetch that settles after the key has moved on', async () => {
    const resolvers: ((value: string) => void)[] = [];
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useApiQuery(['stale-refetch', id], loader),
      { initialProps: { id: '1' } },
    );
    await flushMicrotask();
    await act(async () => {
      resolvers[0]?.('first');
      await Promise.resolve();
    });

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.refetch();
    });
    rerender({ id: '2' });
    await flushMicrotask();
    await act(async () => {
      resolvers[2]?.('second');
      await Promise.resolve();
    });
    expect(result.current.data).toBe('second');

    await act(async () => {
      resolvers[1]?.('stale');
      await pending;
    });
    expect(result.current.data).toBe('second');
    expect(result.current.status).toBe('success');
  });

  // A refetch whose loader cancels itself leaves the query settled rather than stuck reporting
  // that a refetch is still in flight.
  it('clears isRefetching when a refetch is cancelled', async () => {
    const loader = vi.fn(() => Promise.resolve('value'));
    const { result } = renderHook(() => useApiQuery(['cancelled-refetch'], loader));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    loader.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.isRefetching).toBe(false);
    expect(result.current.status).toBe('success');
  });

  /**
   * A cancellation is a `DOMException` named `AbortError` and nothing else. An exception of
   * another name is a real failure that happens to be a `DOMException`, and an ordinary `Error`
   * that calls itself `AbortError` is not the platform's cancellation — read as one, either would
   * leave the query showing stale data with no error and no way to retry.
   */
  it.each([
    ['a DOMException of another name', new DOMException('quota exceeded', 'QuotaExceededError')],
    [
      'an Error that merely calls itself AbortError',
      Object.assign(new Error('x'), { name: 'AbortError' }),
    ],
  ])('reports %s as an error', async (_case, reason) => {
    const loader = vi.fn(() => Promise.reject(reason));
    const { result } = renderHook(() => useApiQuery(['not-aborted'], loader));

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
  });

  /**
   * A refetch keeps what is on screen and says it is refreshing. Starting from nothing instead
   * blanks the page on every poll and every invalidation, which is the difference between a live
   * view and one that flickers.
   */
  it('keeps the data on screen while a refetch is in flight', async () => {
    let release = (): void => undefined;
    const loader = vi
      .fn(() => Promise.resolve('first'))
      .mockImplementationOnce(() => Promise.resolve('first'));
    const { result } = renderHook(() => useApiQuery(['refetch-keeps-data'], loader));
    await waitFor(() => {
      expect(result.current.data).toBe('first');
    });

    loader.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = () => {
            resolve('second');
          };
        }),
    );
    act(() => {
      invalidateQueries(['refetch-keeps-data']);
    });

    await waitFor(() => {
      expect(result.current.isRefetching).toBe(true);
    });
    expect(result.current.status).toBe('success');
    expect(result.current.data).toBe('first');

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.data).toBe('second');
    });
    expect(result.current.isRefetching).toBe(false);
  });

  // An AbortError rejection (the loader's own fetch aborting) does not flip status to "error".
  it('treats an AbortError rejection as a silent cancellation', async () => {
    const loader = vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const { result } = renderHook(() => useApiQuery(['k'], loader));
    await waitFor(() => {
      expect(loader).toHaveBeenCalled();
    });
    // Give the rejection a tick to settle without ever reaching "error".
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).not.toBe('error');
  });
});
