/**
 * Global keyboard shortcuts of the app shell and the predicates that decide when they fire.
 *
 * Layer: feature (lib).
 */

/** Name of a global shortcut. */
export type ShortcutName = 'search' | 'newChat' | 'settings';

/** One shortcut: the key pressed together with the platform's command modifier. */
export interface ShortcutDefinition {
  key: string;
  /** Label shown in tooltips on macOS. */
  label: string;
}

/** Every global shortcut, keyed by what it does. */
export const SHORTCUTS: Readonly<Record<ShortcutName, ShortcutDefinition>> = {
  search: { key: 'k', label: '⌘K' },
  newChat: { key: 'n', label: '⌘N' },
  settings: { key: ',', label: '⌘,' },
};

/**
 * Whether a keyboard event is the command-modified press of `key`.
 *
 * @param event - The keyboard event.
 * @param key - The unmodified key, lowercase.
 * @returns `true` when Meta or Control is held without Alt or Shift and the key matches.
 */
export function isShortcut(event: KeyboardEvent, key: string): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === key
  );
}

/**
 * Whether an event target is a field the user may be typing into.
 *
 * @param target - The event target.
 * @returns `true` for inputs, textareas and anything `contenteditable`.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

/**
 * Human-readable label for a shortcut, using `Ctrl` off macOS.
 *
 * @param name - Which shortcut to label.
 * @returns The label to show in a tooltip.
 */
export function shortcutLabel(name: ShortcutName): string {
  const { key, label } = SHORTCUTS[name];
  const isMac = globalThis.navigator.userAgent.includes('Mac');
  return isMac ? label : `Ctrl+${key.toUpperCase()}`;
}
