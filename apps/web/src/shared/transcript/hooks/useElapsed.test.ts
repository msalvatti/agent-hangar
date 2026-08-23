/**
 * Tests for the live elapsed-time hook: ticking while running, freezing when stopped, and the
 * hour-scale format.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useElapsed } from './useElapsed';

describe('useElapsed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // With no start time, the label is the zero clock.
  it('renders 00:00 when startedAt is null', () => {
    const { result } = renderHook(() => useElapsed(null, false, () => 0));
    expect(result.current).toBe('00:00');
  });

  // While running, the label ticks once a second.
  it('ticks every second while running', () => {
    let now = 0;
    const { result } = renderHook(() => useElapsed(0, true, () => now));
    expect(result.current).toBe('00:00');
    now = 1_000;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe('00:01');
    now = 3_000;
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current).toBe('00:03');
  });

  // Once running becomes false, the label freezes at its last value instead of resetting.
  it('freezes at the last value when running becomes false', () => {
    let now = 0;
    const { result, rerender } = renderHook(
      ({ running }: { running: boolean }) => useElapsed(0, running, () => now),
      {
        initialProps: { running: true },
      },
    );
    now = 5_000;
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe('00:05');
    rerender({ running: false });
    now = 9_000;
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(result.current).toBe('00:05');
  });

  // Past one hour the hook switches to the h:mm:ss format (delegated to formatElapsed).
  it('formats past the one-hour mark', () => {
    const { result } = renderHook(() => useElapsed(0, false, () => 3_661_000));
    expect(result.current).toBe('1:01:01');
  });

  // The elapsed time is measured from the start, not summed with it: a turn that began at a real
  // epoch instant would otherwise read as fifty-odd years of running.
  it('measures from the start rather than summing with it', () => {
    const { result } = renderHook(() => useElapsed(1_000, false, () => 5_000));
    expect(result.current).toBe('00:04');
  });

  // Resuming re-reads the clock at once rather than waiting for the next tick: the label is on
  // screen the moment the turn continues, and a stale one would show a turn that has been running
  // for a while as having just started.
  it('re-reads the clock when it starts running again', () => {
    let now = 0;
    const { result, rerender } = renderHook(
      ({ running }: { running: boolean }) => useElapsed(0, running, () => now),
      { initialProps: { running: true } },
    );
    now = 5_000;
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    rerender({ running: false });
    expect(result.current).toBe('00:05');

    now = 9_000;
    rerender({ running: true });

    expect(result.current).toBe('00:09');
  });

  // When startedAt transitions back to null (e.g. a new turn not started yet), the clock resets.
  it('resets to zero when startedAt becomes null again', () => {
    const initialProps: { startedAt: number | null } = { startedAt: 0 };
    const { result, rerender } = renderHook(
      ({ startedAt }: { startedAt: number | null }) => useElapsed(startedAt, false, () => 5_000),
      { initialProps },
    );
    expect(result.current).toBe('00:05');
    rerender({ startedAt: null });
    expect(result.current).toBe('00:00');
  });
});
