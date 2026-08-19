/**
 * Tests for the shortcut predicates and labels.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isEditableTarget, isShortcut, SHORTCUTS, shortcutLabel } from './shortcuts';

/**
 * Builds a keyboard event with the given modifiers.
 *
 * @param init - Key and modifier flags.
 * @returns The event.
 */
function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('isShortcut', () => {
  // Either command modifier counts, so the same binding works on macOS and elsewhere.
  it.each([{ metaKey: true }, { ctrlKey: true }])('matches with %o', (modifier) => {
    expect(isShortcut(keyEvent({ key: 'k', ...modifier }), 'k')).toBe(true);
  });

  // Upper case arrives when Caps Lock is on; the comparison is case-insensitive.
  it('matches an upper-case key', () => {
    expect(isShortcut(keyEvent({ key: 'K', metaKey: true }), 'k')).toBe(true);
  });

  // Anything else must not steal the key from the browser or the page.
  it.each([
    ['no modifier', { key: 'k' }],
    ['alt held', { key: 'k', metaKey: true, altKey: true }],
    ['shift held', { key: 'k', metaKey: true, shiftKey: true }],
    ['another key', { key: 'j', metaKey: true }],
  ])('does not match with %s', (_label, init) => {
    expect(isShortcut(keyEvent(init), 'k')).toBe(false);
  });
});

/**
 * Builds a non-editable element with `isContentEditable` reported as a browser would.
 *
 * @returns A plain `div`.
 */
function plainElement(): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'isContentEditable', { configurable: true, value: false });
  return element;
}

describe('isEditableTarget', () => {
  // Text fields are where an unmodified key must keep its normal meaning.
  it.each(['input', 'textarea'])('recognises a %s', (tag) => {
    expect(isEditableTarget(document.createElement(tag))).toBe(true);
  });

  // A rich-text host is editable too, even though it is a plain element.
  it('recognises a contenteditable element', () => {
    const element = document.createElement('div');
    Object.defineProperty(element, 'isContentEditable', { configurable: true, value: true });
    expect(isEditableTarget(element)).toBe(true);
  });

  // Ordinary elements and a missing target are not editable. jsdom leaves
  // `isContentEditable` undefined, so the flag is defined here the way a browser reports it.
  it.each([
    ['a plain element', plainElement()],
    ['nothing', null],
  ])('rejects %s', (_label, target) => {
    expect(isEditableTarget(target)).toBe(false);
  });
});

describe('shortcutLabel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // On macOS the label is the glyph form the spec shows in tooltips.
  it('uses the command glyph on macOS', () => {
    vi.spyOn(globalThis.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh)');
    expect(shortcutLabel('search')).toBe(SHORTCUTS.search.label);
  });

  // Elsewhere the same binding is spelled out with Ctrl.
  it('falls back to Ctrl off macOS', () => {
    vi.spyOn(globalThis.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux)');
    expect(shortcutLabel('newChat')).toBe('Ctrl+N');
  });
});
