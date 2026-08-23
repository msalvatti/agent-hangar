/**
 * Tests for `useKeyboardShortcuts`: the global ⌘K / ⌘N / ⌘, bindings.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useKeyboardShortcuts } from './useKeyboardShortcuts';

/** Renders the hook with spies for each handler. */
function renderShortcuts() {
  const handlers = { onSearch: vi.fn(), onNewChat: vi.fn(), onSettings: vi.fn() };
  const view = renderHook(() => {
    useKeyboardShortcuts(handlers);
  });
  return { handlers, ...view };
}

/**
 * Dispatches a keydown on the window.
 *
 * @param init - Key and modifier flags.
 * @returns The dispatched event.
 */
function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { cancelable: true, ...init });
  globalThis.dispatchEvent(event);
  return event;
}

describe('useKeyboardShortcuts', () => {
  // Each binding runs its own handler and stops the browser's default.
  it.each([
    ['k', 'onSearch'],
    ['n', 'onNewChat'],
    [',', 'onSettings'],
  ] as const)('runs %s', (key, handler) => {
    const { handlers } = renderShortcuts();
    const event = press({ key, metaKey: true });
    expect(handlers[handler]).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  /**
   * The bindings follow the handlers they are currently given. A view re-renders with new closures
   * whenever what a shortcut should do changes — which chat is open, which dialog is on screen —
   * and a listener bound once goes on calling the version of the handler that existed at mount.
   */
  it('runs the handlers it is currently given', () => {
    const first = vi.fn();
    const second = vi.fn();
    // The other two are built once rather than per render: a fresh function on every render changes
    // the effect's dependencies every time, which rebinds the listener continuously and measures
    // the test's own churn instead of the hook's.
    const others = { onNewChat: vi.fn(), onSettings: vi.fn() };
    const { rerender } = renderHook(
      ({ onSearch }: { onSearch: () => void }) => {
        useKeyboardShortcuts({ onSearch, ...others });
      },
      { initialProps: { onSearch: first } },
    );

    rerender({ onSearch: second });
    press({ key: 'k', metaKey: true });

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  /**
   * A key without the command modifier keeps its normal meaning — and the browser keeps it: the
   * handler runs on every keystroke the page sees, so a press it does not claim has to leave the
   * event alone as well as leave the handlers uncalled. Swallowing the default is how a plain `k`
   * stops reaching whatever the user was typing into.
   */
  it('ignores an unmodified key', () => {
    const { handlers } = renderShortcuts();

    const event = press({ key: 'k' });

    expect(handlers.onSearch).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  // The shortcut still works while a field has focus, because it carries a modifier.
  it('fires while typing in a field', () => {
    const { handlers } = renderShortcuts();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    expect(handlers.onSearch).toHaveBeenCalledTimes(1);
    input.remove();
  });

  // Holding a shortcut down must not fire it repeatedly.
  it('ignores auto-repeat', () => {
    const { handlers } = renderShortcuts();
    press({ key: 'k', metaKey: true, repeat: true });
    expect(handlers.onSearch).not.toHaveBeenCalled();
  });

  // Unmounting the shell must unbind the listener.
  it('removes the listener on unmount', () => {
    const { handlers, unmount } = renderShortcuts();
    unmount();
    press({ key: 'k', metaKey: true });
    expect(handlers.onSearch).not.toHaveBeenCalled();
  });
});
