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
import { afterEach, describe, expect, it } from 'vitest';

import { CommandError } from './process';
import {
  isNoSuchProcessError,
  isSameWorker,
  isWorkerCommandLine,
  ownsRecordedGroup,
  stopWorker,
} from './worker';
import type { WorkerHandle } from './worker';

const HANDLE: WorkerHandle = { pid: 4321, startedAt: 'Thu Aug 20 06:39:22 2026' };

/** What `ps` reports for the worker this run started. */
const OWN_LEADER = { commandLine: 'pnpm --filter worker dev', startedAt: HANDLE.startedAt };

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
});

describe('ownsRecordedGroup', () => {
  /** The leader is still there and is ours, so the group it leads is ours to stop. */
  it('accepts the group of a leader that identifies as this run', () => {
    expect(ownsRecordedGroup(HANDLE, OWN_LEADER, true)).toBe(true);
  });

  /**
   * The leader is there but belongs to somebody else, so a live group under that id is theirs.
   * Signalling it would reach a tree this run never started.
   */
  it('refuses a live group whose leader belongs to another run', () => {
    const other = {
      commandLine: 'pnpm --filter worker dev',
      startedAt: 'Wed Aug 19 15:43:45 2026',
    };
    expect(ownsRecordedGroup(HANDLE, other, true)).toBe(false);
  });

  /**
   * The package runner exits while the worker it supervises drains, so a group can outlive the id
   * that was recorded for it. Treating that as stopped is what would start a second worker on the
   * queues the first is still consuming — the whole reason the previous one is stopped at all.
   */
  it('accepts a group that outlived its recorded leader', () => {
    expect(ownsRecordedGroup(HANDLE, undefined, true)).toBe(true);
  });

  /** Leader gone and group empty: the run really did end, and there is nothing to signal. */
  it('refuses a group that is gone along with its leader', () => {
    expect(ownsRecordedGroup(HANDLE, undefined, false)).toBe(false);
  });
});

describe('isNoSuchProcessError', () => {
  /**
   * A `ps` that ran and exited non-zero has answered: nothing holds the id. That answer is what
   * lets the caller treat the leader as gone.
   */
  it('reads a non-zero exit as the process being absent', () => {
    const ran = new CommandError('ps', ['-p', '4321'], '', '', 1);
    expect(isNoSuchProcessError(ran)).toBe(true);
  });

  /**
   * A `ps` that never started has answered nothing, and the caller signals a whole process group on
   * the strength of this word. Silence must not arrive as "absent".
   */
  it('refuses to read a failure to start as the process being absent', () => {
    const neverRan = new CommandError('ps', ['-p', '4321'], '', 'spawn ps ENOENT', undefined);
    expect(isNoSuchProcessError(neverRan)).toBe(false);
  });

  /** Anything that is not a command failure says nothing about a process either. */
  it('refuses an error that did not come from running a command', () => {
    expect(isNoSuchProcessError(new Error('boom'))).toBe(false);
    expect(isNoSuchProcessError(undefined)).toBe(false);
  });
});

describe('stopWorker', () => {
  const realPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = realPath;
  });

  /**
   * With `ps` unreachable the harness knows nothing about the recorded id, and the recorded id may
   * by then belong to an unrelated process group. Failing here is what keeps a signal from being
   * sent on the strength of an inspection that never happened.
   */
  it('fails rather than deciding anything when the inspection cannot be run', async () => {
    // An empty PATH is the cheapest true "ps cannot be started": the spawn fails with ENOENT,
    // exactly as a missing or non-executable `ps` would.
    process.env.PATH = '';
    await expect(
      stopWorker({ pid: 999_999, startedAt: 'Thu Aug 20 06:39:22 2026' }),
    ).rejects.toThrow(/ps/);
  });
});
