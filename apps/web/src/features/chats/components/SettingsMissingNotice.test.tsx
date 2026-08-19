/**
 * Tests for `SettingsMissingNotice`: the card that replaces the composer without credentials.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SettingsMissingNotice } from './SettingsMissingNotice';

describe('SettingsMissingNotice', () => {
  // The copy is fixed by spec 10 §4.1 and is announced politely as a status.
  it('renders the exact notice copy inside a status region', () => {
    render(<SettingsMissingNotice />);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Add your GitHub token and OpenAI key in Settings to start.');
  });

  // Every error state must offer the next action; here that is a link to Settings.
  it('links to the settings page', () => {
    render(<SettingsMissingNotice />);
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });
});
