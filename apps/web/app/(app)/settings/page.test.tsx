/**
 * Tests for the settings route.
 *
 * Layer: unit.
 * Goal: `/settings` is the settings screen — the destination of the ⌘, shortcut and of every
 * "add your credentials" prompt.
 * Mocks: the settings feature.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SettingsPage, { metadata } from './page';

vi.mock('@/features/settings', () => ({
  SettingsView: () => <div data-testid="settings-view" />,
}));

describe('SettingsPage', () => {
  /** Several places in the app send the reader to this path; it has to be the settings screen. */
  it('renders the settings screen', () => {
    render(<SettingsPage />);

    expect(screen.getByTestId('settings-view')).toBeInTheDocument();
  });

  /** The tab names the section. */
  it('titles the tab', () => {
    expect(metadata.title).toBe('Settings — Agent Hangar');
  });
});
