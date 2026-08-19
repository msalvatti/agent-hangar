/**
 * Resolved theme (`dark` | `light`) derived from the `.dark` class on the document element.
 *
 * Layer: hook.
 *
 * The root layout's inline script sets the class before paint from the stored preference or the
 * system setting; components that need the resolved value (e.g. the toaster) subscribe here
 * instead of depending on a theming library.
 */
'use client';

import { useSyncExternalStore } from 'react';

/** Resolved theme name. */
export type ResolvedTheme = 'dark' | 'light';

/** Class applied to `<html>` when the dark palette is active. */
export const DARK_CLASS = 'dark';

/**
 * Reads the resolved theme from a root element.
 *
 * @param root - Element carrying the theme class (defaults to `document.documentElement`).
 * @returns `dark` when the class is present, `light` otherwise.
 */
export function getResolvedTheme(root: Element = document.documentElement): ResolvedTheme {
  return root.classList.contains(DARK_CLASS) ? 'dark' : 'light';
}

/**
 * Subscribes to changes of the theme class on the document element.
 *
 * @param onChange - Called whenever the class attribute of `<html>` changes.
 * @returns Unsubscribe function.
 */
export function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => {
    observer.disconnect();
  };
}

function getServerTheme(): ResolvedTheme {
  return 'light';
}

function getClientTheme(): ResolvedTheme {
  return getResolvedTheme();
}

/**
 * React hook returning the resolved theme and re-rendering when it changes.
 *
 * @returns `dark` or `light` (`light` during server rendering).
 */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeToTheme, getClientTheme, getServerTheme);
}
