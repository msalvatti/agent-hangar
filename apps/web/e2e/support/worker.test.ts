/**
 * Unit tests for the worker's command-line matcher.
 *
 * Layer: unit test.
 *
 * The rest of the module spawns and signals processes and is exercised by the end-to-end run. This
 * matcher is pure, and it is the part that decides whether a recorded process id may be signalled,
 * so a match that is too loose would let a stale id reach an unrelated process group.
 */
import { describe, expect, it } from 'vitest';

import { isWorkerCommandLine } from './worker';

describe('isWorkerCommandLine', () => {
  /** The invocation the harness spawns must be recognised, however the shell reports its prefix. */
  it('recognises the worker invocation', () => {
    expect(isWorkerCommandLine('node /path/to/pnpm --filter worker dev')).toBe(true);
    expect(isWorkerCommandLine('pnpm --filter worker dev')).toBe(true);
  });

  /**
   * The bare word appears in this repository's own paths and in unrelated command lines; matching
   * it would let a reused process id be mistaken for the worker and its whole group signalled.
   */
  it('refuses a command line that merely contains the word', () => {
    expect(isWorkerCommandLine('node /tmp/worker-guard-check.mjs')).toBe(false);
    expect(isWorkerCommandLine('/usr/bin/some-worker --serve')).toBe(false);
    expect(isWorkerCommandLine('pnpm --filter web dev')).toBe(false);
  });

  /** No output at all is not a match; `ps` prints nothing for an id that has gone. */
  it('refuses empty output', () => {
    expect(isWorkerCommandLine('')).toBe(false);
  });
});
