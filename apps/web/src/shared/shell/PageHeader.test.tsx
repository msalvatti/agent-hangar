/**
 * Tests for the shared page header layout: slot rendering, title truncation, and the mobile nav
 * trigger slot.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PageHeader } from './PageHeader';

describe('PageHeader', () => {
  // Title, leading and actions all render.
  it('renders the title, leading and actions slots', () => {
    render(
      <PageHeader
        title="Fix flaky auth test"
        leading={<span>repo-chip</span>}
        actions={<button type="button">Archive</button>}
      />,
    );
    expect(screen.getByText('Fix flaky auth test')).toBeInTheDocument();
    expect(screen.getByText('repo-chip')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  // The title carries the truncation class.
  it('truncates the title', () => {
    render(<PageHeader title="A very long chat title that should truncate" />);
    expect(screen.getByText('A very long chat title that should truncate')).toHaveClass('truncate');
  });

  // The nav trigger is present and scoped to below the md breakpoint.
  it('renders the nav trigger, hidden at md and above', () => {
    render(<PageHeader title="Chats" navTrigger={<button type="button">Menu</button>} />);
    const trigger = screen.getByRole('button', { name: 'Menu' });
    expect(trigger.parentElement).toHaveClass('md:hidden');
  });

  // With no navTrigger, no nav-trigger content renders, but the layout stays 3 columns.
  it('renders no nav trigger content when navTrigger is omitted', () => {
    const { container } = render(<PageHeader title="Chats" />);
    const grid = container.querySelector('.grid');
    expect(grid?.children).toHaveLength(3);
    expect(grid?.children[0]).toBeEmptyDOMElement();
  });

  // The header lives inside the HeaderSlot landmark.
  it('renders inside the HeaderSlot landmark', () => {
    render(<PageHeader title="Chats" />);
    expect(screen.getByTestId('header-slot')).toBeInTheDocument();
  });
});
