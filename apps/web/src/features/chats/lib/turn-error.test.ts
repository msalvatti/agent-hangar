/**
 * Tests for `describeTurnError`: the copy and next action per failure code.
 */
import { GITHUB_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import { describeTurnError, README_IMAGE_ANCHOR, README_IMAGE_HREF } from './turn-error';

describe('describeTurnError', () => {
  // Each declared code gets its own title and the action that actually helps.
  it.each([
    ['auth', 'OpenAI rejected the key', 'settings'],
    ['WORKSPACE_IMAGE_MISSING', 'Workspace image missing', 'readme'],
    ['image_missing', 'Workspace image missing', 'readme'],
    ['context_length', 'The conversation grew too long', 'retry'],
    ['rate_limit', 'The model is rate limiting', 'retry'],
    ['network', 'The model could not be reached', 'retry'],
  ] as const)('describes %s', (code, title, action) => {
    expect(describeTurnError({ code, message: 'boom' })).toEqual({
      title,
      message: 'boom',
      action,
    });
  });

  // A code the runtime adds later still renders with a usable retry.
  it('falls back for an unknown code', () => {
    const described = describeTurnError({ code: 'something_new', message: 'boom' });
    expect(described.title).toBe('The turn failed');
    expect(described.action).toBe('retry');
  });

  // A secret that leaked into the message is masked before it can reach the screen.
  it('masks a secret-shaped message', () => {
    const described = describeTurnError({ code: 'auth', message: `token ${GITHUB_CANARY}` });
    expect(described.message).not.toContain(GITHUB_CANARY);
  });
});

describe('the setup-guide link', () => {
  /**
   * Written out rather than derived from the constant the card renders: the anchor is what carries
   * the reader to the section about building the workspace image, and an empty one leaves a button
   * that reloads the page they are already on — which reads as a dead control on the one card
   * whose whole purpose is to send them somewhere.
   */
  it('points at the workspace-image section of the guide', () => {
    expect(README_IMAGE_ANCHOR).toBe('#workspace-image');
    expect(README_IMAGE_HREF).toBe('/#workspace-image');
  });
});
