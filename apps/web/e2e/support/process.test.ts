/**
 * Unit tests for how a failed command reports what went wrong.
 *
 * Layer: unit test.
 *
 * The rest of the module spawns processes and polls, and the end-to-end run is what exercises it.
 * What is pinned here is the one distinction a caller acts on: whether a command ran and failed, or
 * never ran at all. `worker.ts` decides whether to signal a process group from that difference, so
 * it is measured against the operating system rather than against a description of it — the field
 * it reads is populated by Node, and a test that asserted the shape by hand would pass whether or
 * not it is ever filled in.
 */
import { describe, expect, it } from 'vitest';

import { CommandError, exec } from './process';

/** A process id far above any the kernel hands out, so nothing holds it. */
const UNUSED_PID = 999_999;

describe('exec', () => {
  /**
   * A command that ran and exited non-zero carries its status, which is the caller's evidence that
   * the command actually reported something.
   */
  it('reports the exit status of a command that ran and failed', async () => {
    const failure = await exec('ps', ['-p', String(UNUSED_PID), '-o', 'command=']).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CommandError);
    expect((failure as CommandError).exitCode).toBeGreaterThan(0);
  });

  /**
   * A command that could not be started carries no status: nothing ran, so there is nothing to
   * report. This is the case a caller must not mistake for an answer.
   */
  it('reports no exit status for a command that never started', async () => {
    const failure = await exec('agent-hangar-no-such-executable', []).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CommandError);
    expect((failure as CommandError).exitCode).toBeUndefined();
  });

  /** A command that succeeds returns what it wrote, so the failure paths above are the exception. */
  it('returns the output of a command that succeeds', async () => {
    const { stdout } = await exec('echo', ['ready']);
    expect(stdout.trim()).toBe('ready');
  });
});
