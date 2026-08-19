/**
 * Tests for `ThemeToggle`: the sidebar's theme cycler.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DARK_CLASS } from '@/shared/lib/theme';

import { THEME_STORAGE_KEY } from '../hooks/useTheme';
import { stubMatchMedia } from '../testing/media-query';
import type { MatchMediaStub } from '../testing/media-query';

import { ThemeToggle } from './ThemeToggle';

let media: MatchMediaStub | null = null;

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove(DARK_CLASS);
    media = stubMatchMedia([]);
  });

  afterEach(() => {
    media?.restore();
    media = null;
  });

  // The accessible name says which theme is active and what the button does.
  it('names the current theme', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: 'Theme: system. Switch theme' })).toBeInTheDocument();
  });

  // Clicking steps to the next preference and stores it.
  it('cycles to light and then to dark', async () => {
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button', { name: 'Theme: light. Switch theme' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button'));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true);
  });
});
