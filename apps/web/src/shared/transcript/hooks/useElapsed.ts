/**
 * Live elapsed-time label for a running turn or tool call.
 *
 * Layer: shared (hook).
 */
'use client';

import { useEffect, useState } from 'react';

import { formatElapsed } from '../lib/format';

const TICK_MS = 1000;

interface ElapsedSnapshot {
  startedAt: number | null;
  running: boolean;
  elapsedMs: number;
}

function computeElapsedMs(startedAt: number | null, now: () => number): number {
  return startedAt === null ? 0 : now() - startedAt;
}

/**
 * Formats the time since `startedAt`, ticking once a second while `running` and freezing (but
 * not resetting) once it stops.
 *
 * @param startedAt - Epoch milliseconds the interval started at, or `null` before it has.
 * @param running - Whether the clock should keep ticking.
 * @param now - Clock, injectable for tests (defaults to `Date.now`).
 * @returns The formatted elapsed time (`mm:ss`, `h:mm:ss` past one hour).
 */
export function useElapsed(
  startedAt: number | null,
  running: boolean,
  now: () => number = Date.now,
): string {
  const [snapshot, setSnapshot] = useState<ElapsedSnapshot>(() => ({
    startedAt,
    running,
    elapsedMs: computeElapsedMs(startedAt, now),
  }));

  // Resets synchronously during render when startedAt/running change, rather than in an effect:
  // React's documented pattern for state that must track a prop, without an extra render pass.
  if (snapshot.startedAt !== startedAt || snapshot.running !== running) {
    setSnapshot({ startedAt, running, elapsedMs: computeElapsedMs(startedAt, now) });
  }

  useEffect(() => {
    if (!running) {
      return;
    }
    const interval = setInterval(() => {
      setSnapshot((previous) => ({ ...previous, elapsedMs: computeElapsedMs(startedAt, now) }));
    }, TICK_MS);
    return () => {
      clearInterval(interval);
    };
  }, [startedAt, running, now]);

  return formatElapsed(snapshot.elapsedMs);
}
