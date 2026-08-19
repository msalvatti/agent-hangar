/**
 * Unit tests for `TimezoneCombobox`.
 *
 * Layer: unit.
 * Goal: the trigger shows the current value, opening lists the system zone first, search filters
 * the list, selecting a zone calls onChange and closes, and keyboard selection (Enter) works too.
 * Mocks: none — real `Intl` timezone data.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { systemTimezone } from '../lib/timezones';

import { TimezoneCombobox } from './TimezoneCombobox';

/**
 * `cmdk` (the command-menu library backing this combobox) measures its list with a
 * `ResizeObserver`, which jsdom does not implement. This minimal stand-in satisfies the
 * `observe`/`unobserve`/`disconnect` calls without ever firing a callback — the tests below don't
 * depend on resize-driven behaviour.
 */
class StubResizeObserver implements ResizeObserver {
  observe(): void {
    // Intentionally inert: no test below depends on resize-driven behaviour.
  }
  unobserve(): void {
    // Intentionally inert: no test below depends on resize-driven behaviour.
  }
  disconnect(): void {
    // Intentionally inert: no test below depends on resize-driven behaviour.
  }
}

/** Stands in for `Element.scrollIntoView`, another jsdom-unimplemented API `cmdk` calls. */
function stubScrollIntoView(): void {
  // Intentionally inert: no test below depends on scroll position.
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  Element.prototype.scrollIntoView = stubScrollIntoView;
});

describe('TimezoneCombobox', () => {
  /** The trigger shows the current value. */
  it('shows the current value on the trigger', () => {
    render(<TimezoneCombobox value="America/Sao_Paulo" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Timezone' })).toHaveTextContent('America/Sao_Paulo');
  });

  /** Opening the combobox lists the system zone under its own group, first. */
  it('opens and lists the system zone first', async () => {
    const user = userEvent.setup();
    render(<TimezoneCombobox value="UTC" onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Timezone' }));
    expect(await screen.findByPlaceholderText('Search timezones…')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getAllByText(systemTimezone()).length).toBeGreaterThan(0);
  });

  /** Typing filters the visible options. */
  it('filters options by search', async () => {
    const user = userEvent.setup();
    render(<TimezoneCombobox value="UTC" onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Timezone' }));
    await user.type(screen.getByPlaceholderText('Search timezones…'), 'Tokyo');
    expect(await screen.findByText('Asia/Tokyo')).toBeInTheDocument();
  });

  /** Clicking a zone calls onChange with it and closes the dialog. */
  it('selects a zone and closes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimezoneCombobox value="UTC" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Timezone' }));
    await user.type(screen.getByPlaceholderText('Search timezones…'), 'Tokyo');
    await user.click(await screen.findByText('Asia/Tokyo'));
    expect(onChange).toHaveBeenCalledWith('Asia/Tokyo');
    expect(screen.queryByPlaceholderText('Search timezones…')).not.toBeInTheDocument();
  });

  /** Enter selects the highlighted option via the keyboard. */
  it('selects the highlighted option with Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimezoneCombobox value="UTC" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Timezone' }));
    await user.type(screen.getByPlaceholderText('Search timezones…'), 'Tokyo');
    await screen.findByText('Asia/Tokyo');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('Asia/Tokyo');
  });
});
