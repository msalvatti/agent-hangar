/**
 * Unit tests for the resolved-theme helpers and hook.
 *
 * Layer: hook.
 * Goal: the theme is read from the `.dark` class on `<html>`, and the hook re-renders when the
 * class toggles (MutationObserver subscription) and unsubscribes on unmount.
 * Mocks: none (jsdom).
 */
import { act, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { DARK_CLASS, getResolvedTheme, subscribeToTheme, useResolvedTheme } from './theme';

function ThemeProbe() {
  const theme = useResolvedTheme();
  return <output data-testid="theme">{theme}</output>;
}

async function flushObservers(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

describe('getResolvedTheme', () => {
  afterEach(() => {
    document.documentElement.classList.remove(DARK_CLASS);
  });

  /**
   * The presence of the `.dark` class decides the theme, on the document element by default or
   * on any root passed in.
   */
  it('reads the class from the document element or a given root', () => {
    expect(getResolvedTheme()).toBe('light');
    document.documentElement.classList.add(DARK_CLASS);
    expect(getResolvedTheme()).toBe('dark');
    const other = document.createElement('div');
    expect(getResolvedTheme(other)).toBe('light');
  });
});

describe('useResolvedTheme', () => {
  afterEach(() => {
    document.documentElement.classList.remove(DARK_CLASS);
  });

  /**
   * Server rendering has no document: the hook reports `light` (the server snapshot), matching
   * the light palette declared on `:root` before the inline script runs on the client.
   */
  it('reports light during server rendering', () => {
    document.documentElement.classList.add(DARK_CLASS);
    expect(renderToString(<ThemeProbe />)).toContain('light');
  });

  /**
   * Initial render reflects the current class; toggling it re-renders the consumer via the
   * MutationObserver subscription; after unmount further toggles notify nobody (no leak).
   */
  it('re-renders when the theme class toggles and stops after unmount', async () => {
    const { unmount } = render(<ThemeProbe />);
    expect(screen.getByTestId('theme')).toHaveTextContent('light');

    document.documentElement.classList.add(DARK_CLASS);
    await flushObservers();
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');

    document.documentElement.classList.remove(DARK_CLASS);
    await flushObservers();
    expect(screen.getByTestId('theme')).toHaveTextContent('light');

    let calls = 0;
    const unsubscribe = subscribeToTheme(() => {
      calls += 1;
    });
    unmount();
    unsubscribe();
    document.documentElement.classList.add(DARK_CLASS);
    await flushObservers();
    expect(calls).toBe(0);
  });
});
