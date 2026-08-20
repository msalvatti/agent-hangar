/**
 * Unit tests for how a recorded worker is identified.
 *
 * Layer: unit test.
 *
 * The rest of the module spawns and signals processes and is exercised by the end-to-end run. What
 * is pinned here is the decision that precedes a signal: `stopWorker` signals a whole process
 * group, so an identification that is too generous reaches a tree belonging to somebody else. On a
 * machine running several checkouts at once, every one of their workers shares this command line.
 */
import { describe, expect, it } from 'vitest';

import { isSameWorker, isWorkerCommandLine } from './worker';
import type { WorkerHandle } from './worker';

const HANDLE: WorkerHandle = { pid: 4321, startedAt: 'Thu Aug 20 06:39:22 2026' };

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

describe('isSameWorker', () => {
  /** The process this run started: same command line, same start time. */
  it('accepts the process the handle was taken from', () => {
    expect(isSameWorker(HANDLE, 'pnpm --filter worker dev', HANDLE.startedAt)).toBe(true);
  });

  /** `ps` pads its output; the comparison must not turn that into a mismatch. */
  it('tolerates surrounding whitespace in the reported start time', () => {
    expect(isSameWorker(HANDLE, 'pnpm --filter worker dev', `  ${HANDLE.startedAt}   `)).toBe(true);
  });

  /**
   * Another checkout's worker has this exact command line, so only the start time separates it
   * from ours. Accepting it would signal a process group belonging to a different run.
   */
  it('refuses another run whose worker shares the command line', () => {
    expect(isSameWorker(HANDLE, 'pnpm --filter worker dev', 'Wed Aug 19 15:43:45 2026')).toBe(
      false,
    );
  });

  /** An id reused by an unrelated program is refused on the command line alone. */
  it('refuses an unrelated program holding a reused id', () => {
    expect(isSameWorker(HANDLE, '/usr/bin/vim notes.txt', HANDLE.startedAt)).toBe(false);
  });

  /** Nothing has that id any more, so there is nothing to signal. */
  it('refuses a process that has gone', () => {
    expect(isSameWorker(HANDLE, undefined, undefined)).toBe(false);
    expect(isSameWorker(HANDLE, 'pnpm --filter worker dev', undefined)).toBe(false);
    expect(isSameWorker(HANDLE, undefined, HANDLE.startedAt)).toBe(false);
  });
});
