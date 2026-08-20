/**
 * Binds Escape to the stop confirmation while a turn is live.
 *
 * Layer: feature (hook).
 */
'use client';

import { useEffect } from 'react';

/**
 * Calls `onStop` when Escape is pressed and `active` is true.
 *
 * Escape is the spec's shortcut for interrupting a turn (spec 10 §3); it is bound only while a
 * turn is actually running, so it keeps its usual meaning everywhere else.
 *
 * @param active - `true` while a turn can still be stopped.
 * @param onStop - Opens the confirmation.
 */
export function useEscapeToStop(active: boolean, onStop: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && active) {
        onStop();
      }
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown);
    };
  }, [active, onStop]);
}
