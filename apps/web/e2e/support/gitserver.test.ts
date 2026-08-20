/**
 * Unit tests for when the git server's container may be reused.
 *
 * Layer: unit test.
 *
 * The rest of the module builds images and runs containers, and the end-to-end run exercises it.
 * What is pinned here is the decision that decides what the suite clones from: the fixture's
 * sources are edited like any other code in this suite, and reusing a container started before such
 * an edit is how a run passes against the previous checkout's fixture.
 */
import { describe, expect, it } from 'vitest';

import { canReuseContainer, gitServerImage } from './gitserver';

/** Image id this run built. */
const BUILT = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';

/** Image id of an earlier build of the same tag. */
const EARLIER = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';

describe('canReuseContainer', () => {
  /** A container created from exactly the image this run built serves the current fixture. */
  it('reuses a container running from the image just built', () => {
    expect(canReuseContainer(BUILT, BUILT)).toBe(true);
  });

  /**
   * A rebuild moves the tag but leaves a running container on the image it was created from, so
   * matching by tag would keep serving the fixture the sources no longer describe.
   */
  it('refuses a container running from an earlier build of the same tag', () => {
    expect(canReuseContainer(EARLIER, BUILT)).toBe(false);
  });

  /** Nothing running is nothing to reuse. */
  it('refuses when no container is running', () => {
    expect(canReuseContainer(undefined, BUILT)).toBe(false);
  });
});

describe('gitServerImage', () => {
  /**
   * The tag is a machine-global name, so it carries the instance: two checkouts building one tag
   * race, and the later build moves it under the earlier run, which then clones from the other
   * checkout's fixture despite having its own ports and containers.
   */
  it('names the image after the instance', () => {
    expect(gitServerImage('test-4200')).toBe('agent-hangar/gitserver:test-4200');
  });

  /** The default instance reproduces the tag this was before it carried one. */
  it('keeps the original tag for the default instance', () => {
    expect(gitServerImage('test')).toBe('agent-hangar/gitserver:test');
  });
});
