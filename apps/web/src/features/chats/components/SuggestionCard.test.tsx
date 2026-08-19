/**
 * Tests for `SuggestionCard`: the starter-prompt card of the home screen.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Compass } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { SuggestionCard } from './SuggestionCard';

describe('SuggestionCard', () => {
  // The card is a button carrying its title, so it is reachable by role and by name.
  it('renders as a button named by its title', () => {
    render(
      <SuggestionCard
        title="Explore and understand code"
        icon={Compass}
        tone="accent"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Explore and understand code' })).toBeInTheDocument();
  });

  // Clicking is what fills the composer, so the handler must fire exactly once.
  it('calls onSelect when clicked', async () => {
    const onSelect = vi.fn();
    render(
      <SuggestionCard title="Fix issues" icon={Compass} tone="destructive" onSelect={onSelect} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Fix issues' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  // Spec 10 §10 requires a pointer cursor and a visible focus ring on every interactive element.
  it('carries the pointer cursor and focus ring classes', () => {
    render(<SuggestionCard title="Build" icon={Compass} tone="warning" onSelect={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Build' });
    expect(button.className).toContain('cursor-pointer');
    expect(button.className).toContain('focus-visible:ring-2');
  });

  // The icon tint is the card's only decorative colour and is chosen by tone.
  it('tints the icon per tone', () => {
    const { container } = render(
      <SuggestionCard title="Review" icon={Compass} tone="success" onSelect={vi.fn()} />,
    );
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('text-success/80');
  });
});
