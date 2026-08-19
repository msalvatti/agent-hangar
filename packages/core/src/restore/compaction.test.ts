/**
 * Unit tests for tool-call summaries.
 *
 * Layer: unit.
 * Goal: every tool and outcome renders its exact line, long and multi-line commands are made
 * safe for a one-line summary, malformed arguments degrade to a placeholder, and durations read
 * the way a human expects.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { humanDuration, MAX_SUMMARY_COMMAND_CHARS, toolSummaryText } from './compaction.js';
import type { ToolCallSummaryInput } from './compaction.js';

/**
 * Builds a logged shell call with a successful outcome.
 *
 * @param overrides - Fields to change.
 * @returns The summariser input.
 */
function shellCall(overrides: Partial<ToolCallSummaryInput> = {}): ToolCallSummaryInput {
  return {
    toolName: 'run_shell',
    args: { command: 'pnpm test' },
    exitCode: 0,
    status: 'SUCCEEDED',
    durationMs: 12_000,
    ...overrides,
  };
}

describe('humanDuration', () => {
  /**
   * Each unit boundary is pinned, including the rounding just below a minute and the dropped zero
   * seconds remainder on a whole number of minutes.
   */
  it('renders every unit boundary', () => {
    expect(humanDuration(null)).toBe('n/a');
    expect(humanDuration(0)).toBe('0 ms');
    expect(humanDuration(350)).toBe('350 ms');
    expect(humanDuration(999)).toBe('999 ms');
    expect(humanDuration(1000)).toBe('1 s');
    expect(humanDuration(12_000)).toBe('12 s');
    expect(humanDuration(59_499)).toBe('59 s');
    expect(humanDuration(60_000)).toBe('1 min');
    expect(humanDuration(123_000)).toBe('2 min 3 s');
    expect(humanDuration(3_600_000)).toBe('60 min');
  });

  /**
   * The total is rounded before it is split into minutes and seconds. Rounding the remainder on
   * its own lets the carry escape and renders a duration no clock can show: 119_999 ms came out as
   * "1 min 60 s", and 59_999 ms as "60 s" one branch earlier.
   */
  it('carries a rounded-up remainder instead of rendering 60 seconds', () => {
    expect(humanDuration(119_999)).toBe('2 min');
    expect(humanDuration(119_500)).toBe('2 min');
    expect(humanDuration(59_999)).toBe('1 min');
    expect(humanDuration(59_500)).toBe('1 min');
    expect(humanDuration(3_599_999)).toBe('60 min');
    expect(humanDuration(179_500)).toBe('3 min');
  });
});

describe('toolSummaryText', () => {
  /**
   * The ordinary shell line carries the command, the exit code and how long it took, which is what
   * a later turn needs to know it already ran the tests.
   */
  it('summarises a shell call that exited', () => {
    expect(toolSummaryText(shellCall())).toBe('ran `pnpm test` → exit 0 (12 s)');
    expect(toolSummaryText(shellCall({ exitCode: 1, status: 'FAILED', durationMs: 350 }))).toBe(
      'ran `pnpm test` → exit 1 (350 ms)',
    );
  });

  /**
   * A timeout has no exit code to report, so it says what actually happened instead of inventing
   * one.
   */
  it('summarises a shell call that timed out', () => {
    expect(
      toolSummaryText(shellCall({ status: 'TIMED_OUT', exitCode: null, durationMs: 300_000 })),
    ).toBe('ran `pnpm test` → timed out after 5 min');
  });

  /**
   * A call that failed without recording an exit code — the process was killed, or the runtime
   * died — reads as a failure rather than as exit `null`.
   */
  it('summarises a shell call that failed without an exit code', () => {
    expect(toolSummaryText(shellCall({ status: 'FAILED', exitCode: null, durationMs: 1200 }))).toBe(
      'ran `pnpm test` → failed (1 s)',
    );
  });

  /**
   * A long command is elided so one summary cannot dominate the compaction item, and the ellipsis
   * makes the truncation visible to the model.
   */
  it('elides a long command', () => {
    const command = 'a'.repeat(MAX_SUMMARY_COMMAND_CHARS + 20);
    const summary = toolSummaryText(shellCall({ args: { command } }));
    expect(summary).toBe(`ran \`${'a'.repeat(MAX_SUMMARY_COMMAND_CHARS)}…\` → exit 0 (12 s)`);
  });

  /**
   * A command exactly at the limit is kept whole, so the boundary is inclusive.
   */
  it('keeps a command exactly at the limit', () => {
    const command = 'b'.repeat(MAX_SUMMARY_COMMAND_CHARS);
    expect(toolSummaryText(shellCall({ args: { command } }))).toBe(
      `ran \`${command}\` → exit 0 (12 s)`,
    );
  });

  /**
   * A heredoc or a multi-line script collapses to one line, because the summary is one line by
   * construction and embedded newlines would break the compaction list.
   */
  it('collapses a multi-line command', () => {
    expect(toolSummaryText(shellCall({ args: { command: 'git add .\n  git commit -m x' } }))).toBe(
      'ran `git add . git commit -m x` → exit 0 (12 s)',
    );
  });

  /**
   * Arguments come from a JSON column and are treated as untrusted: anything that is not an object
   * with a string command degrades to a placeholder instead of throwing mid-compaction.
   */
  it('degrades malformed arguments to a placeholder', () => {
    expect(toolSummaryText(shellCall({ args: null }))).toBe('ran `?` → exit 0 (12 s)');
    expect(toolSummaryText(shellCall({ args: 'pnpm test' }))).toBe('ran `?` → exit 0 (12 s)');
    expect(toolSummaryText(shellCall({ args: {} }))).toBe('ran `?` → exit 0 (12 s)');
    expect(toolSummaryText(shellCall({ args: { command: 42 } }))).toBe('ran `?` → exit 0 (12 s)');
  });

  /**
   * A write reports the path and the byte count, measured from the logged content so the number
   * matches what actually landed on disk.
   */
  it('summarises a write from its content', () => {
    expect(
      toolSummaryText({
        toolName: 'write_file',
        args: { path: 'src/auth.ts', content: 'héllo' },
        exitCode: null,
        status: 'SUCCEEDED',
        durationMs: 5,
      }),
    ).toBe('wrote src/auth.ts (6 bytes)');
  });

  /**
   * When the content was not logged — a large write the redactor truncated, for instance — the
   * count the tool reported is used, and a missing count reads as zero rather than as `NaN`.
   */
  it('falls back to the reported byte count', () => {
    const base = {
      toolName: 'write_file',
      args: { path: 'src/auth.ts' },
      exitCode: null,
      status: 'SUCCEEDED',
      durationMs: 5,
    } as const;
    expect(toolSummaryText({ ...base, resultBytes: 4096 })).toBe('wrote src/auth.ts (4096 bytes)');
    expect(toolSummaryText({ ...base, resultBytes: null })).toBe('wrote src/auth.ts (0 bytes)');
    expect(toolSummaryText(base)).toBe('wrote src/auth.ts (0 bytes)');
  });

  /**
   * A write whose path was not logged still produces a line rather than throwing, so one damaged
   * row cannot break the compaction of a whole turn.
   */
  it('degrades a write with no logged path', () => {
    expect(
      toolSummaryText({
        toolName: 'write_file',
        args: {},
        exitCode: null,
        status: 'SUCCEEDED',
        durationMs: 5,
      }),
    ).toBe('wrote ? (0 bytes)');
  });

  /**
   * Reads and directory listings need no outcome: they either produced content the model already
   * saw or they did not, and repeating the bytes would waste the window.
   */
  it('summarises reads and listings', () => {
    expect(
      toolSummaryText({
        toolName: 'read_file',
        args: { path: 'README.md' },
        exitCode: null,
        status: 'SUCCEEDED',
        durationMs: 2,
      }),
    ).toBe('read README.md');
    expect(
      toolSummaryText({
        toolName: 'read_file',
        args: {},
        exitCode: null,
        status: 'SUCCEEDED',
        durationMs: 2,
      }),
    ).toBe('read ?');
  });

  /**
   * `list_dir` defaults to the workspace root, which the log records as an absent path; showing
   * the root is more useful than showing a placeholder.
   */
  it('summarises a listing of the workspace root', () => {
    const base = {
      toolName: 'list_dir',
      exitCode: null,
      status: 'SUCCEEDED',
      durationMs: 2,
    } as const;
    expect(toolSummaryText({ ...base, args: { path: 'src' } })).toBe('listed src');
    expect(toolSummaryText({ ...base, args: {} })).toBe('listed /');
  });

  /**
   * A tool name this build does not know — a log row written by a newer version — is reported
   * rather than silently summarised as something else.
   */
  it('reports an unknown tool', () => {
    expect(() =>
      toolSummaryText(shellCall({ toolName: 'teleport' as unknown as 'run_shell' })),
    ).toThrow(/unhandled case: "teleport"/);
  });
});
