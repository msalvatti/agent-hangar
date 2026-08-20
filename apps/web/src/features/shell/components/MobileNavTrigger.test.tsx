/**
 * Tests for `MobileNavTrigger`: the button that opens the sidebar drawer.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MobileNavTrigger } from './MobileNavTrigger';

describe('MobileNavTrigger', () => {
  // The button is icon-only, so its accessible name has to come from the label.
  it('is named for assistive technology', () => {
    render(<MobileNavTrigger onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument();
  });

  // Clicking is what opens the drawer.
  it('reports a click', async () => {
    const onOpen = vi.fn();
    render(<MobileNavTrigger onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
