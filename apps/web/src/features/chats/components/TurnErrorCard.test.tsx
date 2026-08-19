/**
 * Tests for `TurnErrorCard`: the failure card and the next step it offers.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { README_IMAGE_HREF } from '../lib/turn-error';

import { TurnErrorCard } from './TurnErrorCard';

describe('TurnErrorCard', () => {
  // Every failure offers Retry, which re-sends the prompt.
  it('always offers a retry', async () => {
    const onRetry = vi.fn();
    render(<TurnErrorCard error={{ code: 'network', message: 'boom' }} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The model could not be reached');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // A rejected key is fixed in Settings, so the card links there.
  it('links to settings for a credential failure', () => {
    render(<TurnErrorCard error={{ code: 'auth', message: 'boom' }} onRetry={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  // A missing workspace image is fixed by following the setup guide.
  it('links to the setup guide when the image is missing', () => {
    render(
      <TurnErrorCard
        error={{ code: 'WORKSPACE_IMAGE_MISSING', message: 'boom' }}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole('link', { name: 'Read setup guide' })).toHaveAttribute(
      'href',
      README_IMAGE_HREF,
    );
  });

  // A retry-only failure offers no second link to distract from it.
  it('offers no secondary link for a plain retry', () => {
    render(<TurnErrorCard error={{ code: 'rate_limit', message: 'boom' }} onRetry={vi.fn()} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
