/**
 * Tests for `useEscapeToStop`: the Escape binding that interrupts a running turn.
 *
 * Layer: unit.
 * Goal: Escape opens the confirmation only while a turn can still be stopped, no other key does,
 * the binding follows the current `active` value, and it is dropped when the hook unmounts.
 * Mocks: none; the events are dispatched on the real window jsdom provides.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useEscapeToStop } from './useEscapeToStop';

/**
 * Presses one key on the window, the way the browser delivers it.
 *
 * @param key - The `KeyboardEvent.key` value.
 */
function press(key: string): void {
  globalThis.dispatchEvent(new KeyboardEvent('keydown', { key }));
}

describe('useEscapeToStop', () => {
  /** Escape during a live turn is the spec's interrupt, so it opens the confirmation. */
  it('opens the confirmation on Escape while a turn is live', () => {
    const onStop = vi.fn();
    renderHook(() => {
      useEscapeToStop(true, onStop);
    });

    press('Escape');

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  /**
   * And nothing else does. The handler runs on every keystroke the page sees, so a condition that
   * ignores which key arrived turns typing in the composer into a stop confirmation per character.
   */
  it.each(['Enter', 'a', 'Tab'])('ignores %s', (key) => {
    const onStop = vi.fn();
    renderHook(() => {
      useEscapeToStop(true, onStop);
    });

    press(key);

    expect(onStop).not.toHaveBeenCalled();
  });

  /**
   * Escape keeps its usual meaning while nothing is running — it closes menus and dialogs — so the
   * binding applies only to a turn that can still be stopped.
   */
  it('does nothing on Escape while no turn is live', () => {
    const onStop = vi.fn();
    renderHook(() => {
      useEscapeToStop(false, onStop);
    });

    press('Escape');

    expect(onStop).not.toHaveBeenCalled();
  });

  /**
   * The binding follows the turn rather than the mount: a chat is usually opened idle and starts a
   * turn afterwards, which is exactly the case a handler bound once would never react to.
   */
  it('starts stopping once a turn becomes live', () => {
    const onStop = vi.fn();
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => {
        useEscapeToStop(active, onStop);
      },
      { initialProps: { active: false } },
    );

    rerender({ active: true });
    press('Escape');

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  /**
   * Leaving the chat takes the binding with it. A listener left on the window keeps calling into an
   * unmounted view, and it accumulates one more per chat the operator opens.
   */
  it('drops the binding when the view goes away', () => {
    const onStop = vi.fn();
    const { unmount } = renderHook(() => {
      useEscapeToStop(true, onStop);
    });

    unmount();
    press('Escape');

    expect(onStop).not.toHaveBeenCalled();
  });
});
