/**
 * Unit tests for the toaster's palette.
 *
 * Layer: unit.
 * Goal: toasts are painted in the palette the document is in. This is the one thing about the
 * primitive that is this project's own — the generated version reads the palette from
 * `next-themes`, which this app does not use — so it is the thing worth pinning.
 * Mocks: none.
 */
import { render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it } from 'vitest';

import { DARK_CLASS } from '@/shared/lib/theme';

import { Toaster } from './sonner';

afterEach(() => {
  toast.dismiss();
  document.documentElement.classList.remove(DARK_CLASS);
});

describe('Toaster', () => {
  /**
   * A toast is painted into a layer of its own, above the app's tree and inheriting none of the
   * palette the page sets on its own containers: sonner colours it from the theme it is handed.
   * Handed the wrong one, a toast lands as a light card over a dark page.
   */
  it.each([
    { label: 'dark', dark: true },
    { label: 'light', dark: false },
  ])('paints toasts in the $label palette the document is in', async ({ label, dark }) => {
    document.documentElement.classList.toggle(DARK_CLASS, dark);
    const { baseElement } = render(<Toaster />);

    toast('Settings saved');
    await screen.findByText('Settings saved');

    expect(baseElement.querySelector('[data-sonner-toaster]')).toHaveAttribute(
      'data-sonner-theme',
      label,
    );
  });
});
