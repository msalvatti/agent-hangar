/**
 * Unit tests for the observed workspace-image status.
 *
 * Layer: unit.
 * Goal: it starts optimistic, because before any create there is nothing to report, and then
 * follows exactly what the last create said.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { createImageStatus } from './image-status.js';

describe('createImageStatus', () => {
  /**
   * Nothing has been created yet, so there is no observation to report; claiming the image is
   * missing would put a banner in front of a user whose image is fine.
   */
  it('starts optimistic', () => {
    expect(createImageStatus().present()).toBe(true);
  });

  /**
   * A create that reported the image missing is the only evidence the worker can get, and it is
   * kept until a create says otherwise.
   */
  it('follows what creates report, in both directions', () => {
    const status = createImageStatus();

    status.markMissing();
    expect(status.present()).toBe(false);

    status.markPresent();
    expect(status.present()).toBe(true);
  });
});
