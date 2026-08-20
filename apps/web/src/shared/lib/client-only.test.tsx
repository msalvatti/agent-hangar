/**
 * Tests for the browser-only value hooks.
 *
 * Layer: unit.
 * Goal: the server pass sees `null` and never reads the browser at all, the browser pass sees the
 * real value, and unmounting a subscriber is inert.
 * Mocks: none.
 */
import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { useClientOnly, useLocalTimeZone } from './client-only';

/**
 * Renders whatever {@link useClientOnly} reports for a given reader.
 *
 * @param props - The reader to hand the hook.
 */
function Probe({ read }: { read: () => string }) {
  return <span data-testid="value">{String(useClientOnly(read))}</span>;
}

/**
 * Renders whatever {@link useLocalTimeZone} reports.
 */
function ZoneProbe() {
  return <span data-testid="zone">{String(useLocalTimeZone())}</span>;
}

describe('useClientOnly', () => {
  // Nothing browser-shaped may reach the markup: the value is absent there, which is the one
  // answer the browser cannot contradict when it hydrates over it.
  it('reports nothing while server-rendering', () => {
    const markup = renderToStaticMarkup(<Probe read={() => 'Macintosh'} />);
    expect(markup).toContain('null');
    expect(markup).not.toContain('Macintosh');
  });

  // Stronger than the markup: the reader is not merely ignored on the server, it is not run.
  // A reader that touches `navigator` or `matchMedia` would throw there.
  it('does not run the reader while server-rendering', () => {
    const read = vi.fn(() => 'Macintosh');
    renderToStaticMarkup(<Probe read={read} />);
    expect(read).not.toHaveBeenCalled();
  });

  // In the browser the hook is transparent: whatever the reader answers is what callers see.
  it('reports the value in the browser', () => {
    render(<Probe read={() => 'Macintosh'} />);
    expect(screen.getByTestId('value')).toHaveTextContent('Macintosh');
  });

  // These values never change, so the subscription is a formality; tearing it down must still be
  // safe, since React does it on every unmount.
  it('unsubscribes without complaint', () => {
    const { unmount } = render(<Probe read={() => 'Macintosh'} />);
    expect(() => {
      unmount();
    }).not.toThrow();
  });
});

describe('useLocalTimeZone', () => {
  // The zone the machine running the render is in is not the reader's, so the server offers none.
  it('reports no zone while server-rendering', () => {
    expect(renderToStaticMarkup(<ZoneProbe />)).toContain('null');
  });

  // In the browser it is the zone `Intl` resolves, which is the one the reader's clock shows.
  it('reports the resolved zone in the browser', () => {
    render(<ZoneProbe />);
    expect(screen.getByTestId('zone')).toHaveTextContent(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });
});
