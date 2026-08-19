/**
 * Unit tests for the git snapshot helpers and the capture flow.
 *
 * Layer: unit.
 * Goal: the snapshot degrades to nulls and zeros for every ordinary-but-awkward repository state
 * instead of failing — the snapshot is the only trace of a chat's work that outlives the container,
 * so losing it because of a detached HEAD or a missing remote would lose the restore hints — and
 * the summary stays inside the byte budget that bounds what is written to Postgres.
 * Mocks: the command runner is a table lookup; no container is involved.
 */
import { describe, expect, it } from 'vitest';

import { captureGitSnapshot, parseAheadBehind, truncateSummary } from './git-snapshot.js';
import type { CaptureResult } from './git-snapshot.js';

/** Instant every snapshot is stamped with. */
const TAKEN_AT = new Date('2026-01-01T00:00:00.000Z');

/**
 * Builds a runner that answers by substring match on the joined command.
 *
 * @param table - Command fragment to result mapping; unmatched commands exit 0 with no output.
 * @returns A capture function plus the commands it received.
 */
function runnerFor(table: Record<string, Partial<CaptureResult>>): {
  run: (cmd: readonly string[]) => Promise<CaptureResult>;
  commands: string[];
} {
  const commands: string[] = [];
  return {
    commands,
    run: async (cmd) => {
      const joined = cmd.join(' ');
      commands.push(joined);
      const match = Object.entries(table).find(([fragment]) => joined.includes(fragment));
      return Promise.resolve({ code: 0, stdout: '', stderr: '', ...(match?.[1] ?? {}) });
    },
  };
}

describe('truncateSummary', () => {
  /**
   * A summary inside the budget is passed through byte for byte: truncation must never alter text
   * that fits, or the transcript would show a diff that differs from the real one.
   */
  it('leaves a summary inside the budget untouched', () => {
    expect(truncateSummary(' M f.txt\n')).toBe(' M f.txt\n');
  });

  /**
   * Boundary: exactly 16 384 bytes still fits; one byte more is cut to exactly the budget and ends
   * with the marker, so a reader can tell the summary is incomplete.
   */
  it('cuts an oversized summary to the budget and marks it', () => {
    expect(truncateSummary('x'.repeat(16_384))).toHaveLength(16_384);

    const truncated = truncateSummary('x'.repeat(16_385));

    expect(Buffer.byteLength(truncated, 'utf8')).toBe(16_384);
    expect(truncated.endsWith('\n[truncated]')).toBe(true);
  });

  /**
   * The budget bounds BYTES, not characters, because it bounds a database column and an SSE frame.
   * A summary of multi-byte characters must therefore be cut earlier than its character count
   * suggests.
   */
  it('measures the budget in bytes, not characters', () => {
    const truncated = truncateSummary('é'.repeat(10_000));

    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(16_384);
    expect(truncated.endsWith('\n[truncated]')).toBe(true);
  });
});

describe('parseAheadBehind', () => {
  /**
   * `--left-right --count origin/<branch>...HEAD` prints the upstream's exclusive commits first;
   * swapping the two would tell the user to pull when they need to push.
   */
  it('reads the left count as behind and the right as ahead', () => {
    expect(parseAheadBehind('2\t5\n')).toEqual({ behind: 2, ahead: 5 });
  });

  /**
   * Anything that is not two integers — an empty result, a git message, a partial line — degrades
   * to zeros rather than putting `NaN` into a persisted row.
   */
  it.each([
    ['empty output', ''],
    ['a single number', '3'],
    ['non-numeric output', 'fatal: bad revision'],
    ['a fractional count', '1.5\t2'],
  ])('falls back to zeros for %s', (_case, output) => {
    expect(parseAheadBehind(output)).toEqual({ ahead: 0, behind: 0 });
  });
});

describe('captureGitSnapshot', () => {
  /**
   * The full happy path, including the order of the commands: the upstream comparison must use the
   * branch that was just read, not a hard-coded `main`.
   */
  it('captures the full state of a dirty, diverged repository', async () => {
    const { run, commands } = runnerFor({
      '--is-inside-work-tree': { stdout: 'true\n' },
      '--abbrev-ref': { stdout: 'feature\n' },
      'rev-parse HEAD': { stdout: `${'b'.repeat(40)}\n` },
      '--porcelain': { stdout: ' M f.txt\n' },
      '--left-right': { stdout: '1\t4\n' },
      '--stat': { stdout: ' f.txt | 2 +-\n' },
    });

    const snapshot = await captureGitSnapshot(run, TAKEN_AT);

    expect(snapshot).toEqual({
      takenAt: TAKEN_AT,
      git: { branch: 'feature', headSha: 'b'.repeat(40), dirty: true, ahead: 4, behind: 1 },
      summary: ' M f.txt\n\n f.txt | 2 +-\n',
    });
    expect(commands.some((cmd) => cmd.includes('origin/feature...HEAD'))).toBe(true);
  });

  /**
   * A clean checkout is not dirty, and whitespace-only porcelain output (which git never produces
   * but a truncated read could) must not be mistaken for pending changes.
   */
  it('reports a clean checkout as not dirty', async () => {
    const { run } = runnerFor({
      '--is-inside-work-tree': { stdout: 'true\n' },
      '--abbrev-ref': { stdout: 'main\n' },
      '--porcelain': { stdout: '\n' },
    });

    expect((await captureGitSnapshot(run, TAKEN_AT)).git.dirty).toBe(false);
  });

  /**
   * Outside a repository nothing is inspected further: the remaining commands would all fail, and
   * running them would only slow down every destroy of a workspace that never cloned anything.
   */
  it('stops after the first probe outside a repository', async () => {
    const { run, commands } = runnerFor({ '--is-inside-work-tree': { code: 128 } });

    const snapshot = await captureGitSnapshot(run, TAKEN_AT);

    expect(snapshot.git).toEqual({
      branch: null,
      headSha: null,
      dirty: false,
      ahead: 0,
      behind: 0,
    });
    expect(commands).toHaveLength(1);
  });

  /**
   * On a detached HEAD git answers the literal string `HEAD`, which is not a branch name. Treating
   * it as one would make the upstream comparison ask for `origin/HEAD`.
   */
  it('treats a detached HEAD as no branch and skips the upstream comparison', async () => {
    const { run, commands } = runnerFor({
      '--is-inside-work-tree': { stdout: 'true\n' },
      '--abbrev-ref': { stdout: 'HEAD\n' },
      'rev-parse HEAD': { stdout: `${'c'.repeat(40)}\n` },
    });

    const snapshot = await captureGitSnapshot(run, TAKEN_AT);

    expect(snapshot.git.branch).toBeNull();
    expect(snapshot.git).toMatchObject({ ahead: 0, behind: 0 });
    expect(commands.some((cmd) => cmd.includes('--left-right'))).toBe(false);
  });

  /**
   * A repository with no commits yet: `rev-parse HEAD` fails, and an empty branch name from a
   * failing `--abbrev-ref` must not become the branch either.
   */
  it('reports null branch and head on an unborn repository', async () => {
    const { run } = runnerFor({
      '--is-inside-work-tree': { stdout: 'true\n' },
      '--abbrev-ref': { code: 128, stdout: '' },
      'rev-parse HEAD': { code: 128 },
    });

    const snapshot = await captureGitSnapshot(run, TAKEN_AT);

    expect(snapshot.git.branch).toBeNull();
    expect(snapshot.git.headSha).toBeNull();
  });

  /**
   * A branch that was never pushed has no `origin/` counterpart, so `rev-list` fails. Divergence
   * degrades to zeros rather than discarding the branch and head that were read successfully.
   */
  it('keeps the rest of the snapshot when the upstream is missing', async () => {
    const { run } = runnerFor({
      '--is-inside-work-tree': { stdout: 'true\n' },
      '--abbrev-ref': { stdout: 'feature\n' },
      'rev-parse HEAD': { stdout: `${'d'.repeat(40)}\n` },
      '--left-right': { code: 128, stderr: 'fatal: bad revision\n' },
    });

    const snapshot = await captureGitSnapshot(run, TAKEN_AT);

    expect(snapshot.git).toMatchObject({ branch: 'feature', ahead: 0, behind: 0 });
  });
});
