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
  // The reset below runs on the very first render too — the snapshot it seeds is compared against
  // the props it was seeded from — so what this initialiser holds is never what the hook returns.
  // Stryker disable ObjectLiteral
  const [snapshot, setSnapshot] = useState<ElapsedSnapshot>(() => ({
    startedAt,
    running,
    elapsedMs: computeElapsedMs(startedAt, now),
  }));
  // Stryker restore ObjectLiteral

  // Resets synchronously during render when startedAt/running change, rather than in an effect:
  // React's documented pattern for state that must track a prop, without an extra render pass.
  if (snapshot.startedAt !== startedAt || snapshot.running !== running) {
    setSnapshot({ startedAt, running, elapsedMs: computeElapsedMs(startedAt, now) });
  }

  useEffect(() => {
    if (!running) {
      return;
    }
    // A tick that lost the rest of the snapshot is repaired by the reset above on the render it
    // causes, which recomputes from the same clock — so what the label shows is the same either way.
    // Stryker disable ObjectLiteral
    const interval = setInterval(() => {
      setSnapshot((previous) => ({ ...previous, elapsedMs: computeElapsedMs(startedAt, now) }));
    }, TICK_MS);
    // Stryker restore ObjectLiteral
    return () => {
      clearInterval(interval);
    };
  }, [startedAt, running, now]);

  return formatElapsed(snapshot.elapsedMs);
}
