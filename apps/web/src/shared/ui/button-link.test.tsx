/**
 * Tests for `ButtonLink`: a link that looks like a button and is still announced as a link.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ButtonLink } from './button-link';

describe('ButtonLink', () => {
  // The whole point of the component: an element that navigates is exposed as a link, so neither
  // a `type` an anchor cannot carry nor a `role` that contradicts the destination reaches the DOM.
  it('renders an anchor announced as a link, carrying no button attributes', () => {
    render(<ButtonLink href="/settings">Open Settings</ButtonLink>);

    const link = screen.getByRole('link', { name: 'Open Settings' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/settings');
    expect(link).not.toHaveAttribute('type');
    expect(link).not.toHaveAttribute('role');
    expect(link).not.toHaveAttribute('tabindex');
  });

  // The variants are the button's own, so a caller styles a link exactly as it styles a button;
  // omitting them has to fall back to the button's defaults rather than to no styling at all.
  it('paints the requested variant and falls back to the button defaults', () => {
    const { rerender } = render(
      <ButtonLink href="/settings" variant="outline" size="sm" className="w-full">
        Sized
      </ButtonLink>,
    );

    const styled = screen.getByRole('link', { name: 'Sized' });
    expect(styled).toHaveClass('bg-background', 'h-7', 'w-full');

    rerender(<ButtonLink href="/settings">Default</ButtonLink>);
    expect(screen.getByRole('link', { name: 'Default' })).toHaveClass('bg-primary', 'h-8');
  });
});
