/**
 * Tests for the user-message transcript row.
 */
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { assertPresent } from '../lib/assert';
import { formatTimestamp } from '../lib/format';

import { UserMessage } from './UserMessage';

const SENT_AT = '2026-08-20T15:35:17.824Z';

/**
 * Finds the row's outer element, the one carrying the tooltip.
 *
 * @param container - The render container.
 * @returns The row element.
 */
function row(container: HTMLElement): Element {
  return assertPresent(
    container.querySelector('[data-item-kind="user"]'),
    'the user row is rendered',
  );
}

describe('UserMessage', () => {
  // The "You" label and the message text both render.
  it('renders the You label and the message text', () => {
    render(<UserMessage text="Fix the flaky test" />);
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Fix the flaky test')).toBeInTheDocument();
  });

  // Whitespace/newlines in the text are preserved (pre-wrap), not collapsed.
  it('preserves whitespace in multi-line text', () => {
    render(<UserMessage text={'line one\nline two'} />);
    const bubble = screen.getByText((_, element) => element?.textContent === 'line one\nline two');
    expect(bubble).toHaveClass('whitespace-pre-wrap');
  });

  // A prompt is operator-typed, so it is the one transcript string a credential can enter by
  // hand. It goes through the same display-layer masking as every other row: the token shape must
  // not survive on screen after the prompt is submitted.
  it.each([GITHUB_CANARY, OPENAI_CANARY])('masks a secret shape in the prompt', (canary) => {
    render(<UserMessage text={`use ${canary} to clone`} />);
    expect(screen.getByText('use [REDACTED] to clone')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(canary);
  });

  // data-item-kind identifies the row for the Transcript container's keyed rendering.
  it('carries data-item-kind="user"', () => {
    const { container } = render(<UserMessage text="hi" />);
    expect(container.querySelector('[data-item-kind="user"]')).not.toBeNull();
  });

  // Hovering a prompt used to show the machine-readable instant. It now shows the wall-clock time
  // of whoever is reading, in their own zone.
  it('shows the prompt time as a readable local tooltip', () => {
    const { container } = render(<UserMessage text="hi" at={SENT_AT} />);
    const readerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const title = row(container).getAttribute('title');
    expect(title).not.toBe(SENT_AT);
    expect(title).toBe(formatTimestamp(SENT_AT, readerZone));
  });

  // The server has no reader to have a zone, so the markup it produces carries no tooltip at all.
  // Formatting there is the second half of the same defect the shortcut labels had: the string
  // would differ from the one the browser produces and hydration would report the two as
  // disagreeing.
  it('puts no timestamp in the server markup', () => {
    const markup = renderToString(<UserMessage text="hi" at={SENT_AT} />);
    expect(markup).not.toContain(SENT_AT);
    expect(markup).not.toContain('title=');
  });

  // A row with no timestamp has nothing to say on hover.
  it('renders no tooltip without a timestamp', () => {
    const { container } = render(<UserMessage text="hi" />);
    expect(row(container)).not.toHaveAttribute('title');
  });

  // Neither does a row whose timestamp cannot be read as one.
  it('renders no tooltip for an unreadable timestamp', () => {
    const { container } = render(<UserMessage text="hi" at="not a timestamp" />);
    expect(row(container)).not.toHaveAttribute('title');
  });
});
