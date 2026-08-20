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
 * Which command modifier a platform spells the shortcuts with.
 */
export type ShortcutPlatform = 'mac' | 'other';

/**
 * Which modifier spelling a user agent calls for.
 *
 * @param userAgent - The browser's user-agent string.
 * @returns `mac` for an Apple platform, `other` everywhere else.
 */
export function platformFromUserAgent(userAgent: string): ShortcutPlatform {
  return userAgent.includes('Mac') ? 'mac' : 'other';
}

/**
 * Human-readable label for a shortcut, using `Ctrl` off macOS.
 *
 * The platform is a parameter rather than something read here: the answer lives in `navigator`,
 * which no server has, so a function that read it could not be called while rendering markup the
 * browser will hydrate.
 *
 * @param name - Which shortcut to label.
 * @param platform - Which modifier spelling to use.
 * @returns The label to show in a tooltip.
 */
export function shortcutLabel(name: ShortcutName, platform: ShortcutPlatform): string {
  const { key, label } = SHORTCUTS[name];
  return platform === 'mac' ? label : `Ctrl+${key.toUpperCase()}`;
}

/**
 * The accessible name of a control, with its shortcut appended once the platform is known.
 *
 * While the platform is unknown — server rendering, and the hydration pass that must match it —
 * the name is the plain label. Naming a shortcut there would mean guessing a modifier, and a guess
 * is wrong half the time: the control would announce a key combination that does not exist on the
 * machine in front of the reader, and then silently change once the browser corrected it. An
 * absent shortcut is never wrong, and the name only ever gains the parenthetical.
 *
 * @param label - What the control does.
 * @param name - Its shortcut, or `null` when it has none.
 * @param platform - The platform, or `null` while it is still unknown.
 * @returns The name to put on `aria-label`/`title`.
 */
export function shortcutHint(
  label: string,
  name: ShortcutName | null,
  platform: ShortcutPlatform | null,
): string {
  if (name === null || platform === null) {
    return label;
  }
  return `${label} (${shortcutLabel(name, platform)})`;
}
