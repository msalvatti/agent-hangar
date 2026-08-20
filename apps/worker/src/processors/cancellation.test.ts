/**
 * Unit tests for the cancellation watch.
 *
 * Layer: unit.
 * Goal: a cancellation that arrives before anything is running is remembered rather than dropped,
 * one that arrives while the exec is running reaches it, and the subscription is given back.
 * Mocks: the in-memory command listener of the test container, driven directly.
 */
import { describe, expect, it } from 'vitest';

import { createTestContainer } from '../testing/index.js';

import { openCancellationWatch } from './cancellation.js';

const TURN_ID = 'turn-1';

describe('openCancellationWatch', () => {
  /**
   * The window this exists for: Stop is pressed while the workspace is still being created, so
   * there is no exec to signal and no listener yet. Redis pub/sub delivers once and keeps nothing,
   * so the request has to be remembered here — and it is not replayed to a listener registered
   * afterwards, because by then the caller has already read it and decided what to do.
   */
  it('remembers a cancellation that arrived before any listener', async () => {
    const container = createTestContainer();
    const watch = await openCancellationWatch(container, TURN_ID);

    expect(watch.requested()).toBe(false);
    expect(container.commands.emitCancel(TURN_ID)).toBe(true);
    expect(watch.requested()).toBe(true);

    let delivered = 0;
    watch.onCancel(() => {
      delivered += 1;
    });
    expect(delivered).toBe(0);

    await watch.close();
  });

  /**
   * Once the exec is running it is the listener that acts on a cancellation, and the watch still
   * records that one arrived.
   */
  it('forwards a cancellation to the registered listener', async () => {
    const container = createTestContainer();
    const watch = await openCancellationWatch(container, TURN_ID);
    let delivered = 0;
    watch.onCancel(() => {
      delivered += 1;
    });

    container.commands.emitCancel(TURN_ID);

    expect(delivered).toBe(1);
    expect(watch.requested()).toBe(true);
    await watch.close();
  });

  /**
   * The subscriber connection is shared by every concurrent turn, so a finished turn must give its
   * channel back.
   */
  it('ends the subscription when it is closed', async () => {
    const container = createTestContainer();
    const watch = await openCancellationWatch(container, TURN_ID);

    await watch.close();

    expect(container.commands.subscriptions).toBe(0);
    expect(container.commands.emitCancel(TURN_ID)).toBe(false);
    expect(watch.key).toBe(TURN_ID);
  });
});
