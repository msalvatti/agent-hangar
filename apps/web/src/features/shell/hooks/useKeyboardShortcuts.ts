/**
 * Binds the app-wide keyboard shortcuts to the window.
 *
 * Layer: feature (hook).
 */
'use client';

import { useEffect } from 'react';

import { isShortcut, SHORTCUTS } from '../lib/shortcuts';

/** Handlers of {@link useKeyboardShortcuts}. */
export interface KeyboardShortcutHandlers {
  onSearch: () => void;
  onNewChat: () => void;
  onSettings: () => void;
}

/**
 * Registers a `keydown` listener for ⌘K / ⌘N / ⌘, (Ctrl off macOS).
 *
 * Every shortcut carries the command modifier, so it stays available while the user is typing:
 * only an unmodified key would need to yield to a focused field.
 *
 * @param handlers - What each shortcut does.
 */
export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers): void {
  const { onSearch, onNewChat, onSettings } = handlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) {
        return;
      }
      const action = isShortcut(event, SHORTCUTS.search.key)
        ? onSearch
        : isShortcut(event, SHORTCUTS.newChat.key)
          ? onNewChat
          : isShortcut(event, SHORTCUTS.settings.key)
            ? onSettings
            : null;
      if (action !== null) {
        event.preventDefault();
        action();
      }
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown);
    };
  }, [onSearch, onNewChat, onSettings]);
}
