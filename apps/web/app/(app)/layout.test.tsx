/**
 * Tests for the app shell layout: the grid that seats the sidebar beside the page.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { assertPresent } from '@/shared/transcript';

import AppLayout from './layout';

vi.mock('@/features/shell', () => ({
  AppSidebar: () => <div data-testid="app-sidebar" />,
}));

describe('AppLayout', () => {
  /*
   * The sidebar remembers whether it was left as the 260 px column or the 56 px rail, and that
   * choice is allowed to disagree with the viewport. A track pinned to a breakpoint would then be
   * the wrong width for the sidebar sitting in it, and the sidebar would be painted over the page
   * instead of beside it. Sizing the track from its content is what keeps the two agreeing.
   */
  it('sizes the sidebar track from the sidebar rather than from a breakpoint', () => {
    render(<AppLayout>{null}</AppLayout>);
    const grid = assertPresent(
      screen.getByTestId('app-sidebar').parentElement,
      'the sidebar is a cell of the shell grid',
    );

    expect(grid).toHaveClass('grid', 'grid-cols-1', 'md:grid-cols-[auto_1fr]');
    expect(grid.className).not.toMatch(/grid-cols-\[\d/);
  });

  // The page keeps the remaining track and scrolls inside it rather than growing the document.
  it('gives the page the remaining track', () => {
    render(<AppLayout>{null}</AppLayout>);
    const main = screen.getByRole('main');

    expect(main).toHaveClass('flex', 'min-w-0', 'flex-col', 'overflow-hidden');
  });
});
