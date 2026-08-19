/**
 * Tests for the streaming-text cursor.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StreamCursor } from './StreamCursor';

describe('StreamCursor', () => {
  // The cursor is decorative and must never be announced to assistive tech.
  it('is aria-hidden and pulses via opacity only', () => {
    render(<StreamCursor />);
    const cursor = screen.getByTestId('stream-cursor');
    expect(cursor).toHaveAttribute('aria-hidden', 'true');
    expect(cursor).toHaveClass('animate-pulse');
    expect(cursor).toHaveClass('motion-reduce:animate-none');
  });
});
