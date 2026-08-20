/**
 * Tests for `InfraDownNotice`: the card that says which dependency is stopping a turn.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InfraDownNotice } from './InfraDownNotice';

describe('InfraDownNotice', () => {
  // Nothing failing is nothing to say; the composer stands alone.
  it('renders nothing when no probe is failing', () => {
    const { container } = render(<InfraDownNotice failing={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  /*
   * The dependency is named and the command is shown, because neither is something the browser can
   * do anything about: the only useful next action is a command in a terminal.
   */
  it('names the failing dependency and the command that fixes it', () => {
    render(<InfraDownNotice failing={['image']} />);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Workspace image is not available, so a turn cannot run.');
    expect(notice).toHaveTextContent('pnpm infra:image');
  });

  /*
   * Only the first failing probe is reported. The worker is what measures Docker and the image, so
   * when it is silent the two below it are unknown rather than broken — naming all three would
   * bury the one thing to do, and two of the three would be wrong.
   */
  it('reports only the first failing probe', () => {
    render(<InfraDownNotice failing={['worker', 'docker', 'image']} />);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Worker is not available, so a turn cannot run.');
    expect(notice).toHaveTextContent('pnpm dev');
    expect(notice).not.toHaveTextContent('Docker');
  });
});
