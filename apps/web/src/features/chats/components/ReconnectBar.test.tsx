/**
 * Tests for `ReconnectBar`: the quiet notice shown while the stream is down.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ReconnectBar } from './ReconnectBar';

describe('ReconnectBar', () => {
  // The bar is a polite status, not an alert: the replay fills the gap by itself.
  it('announces the reconnection politely', () => {
    render(<ReconnectBar />);
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…');
  });

  // The spinner is suppressed for operators who asked for reduced motion.
  it('disables its spin under reduced motion', () => {
    const { container } = render(<ReconnectBar />);
    expect(container.querySelector('.animate-spin')?.getAttribute('class')).toContain(
      'motion-reduce',
    );
  });
});
