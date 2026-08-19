/**
 * Tests for the tool-call row: collapsed summaries per tool, redaction, running/succeeded/failed/
 * timed-out meta, keyboard toggling, expanded arguments/output, copy, and truncation.
 */
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOOL_OUTPUT_DISPLAY_LIMIT_BYTES } from '../types';
import type { ToolTranscriptItem } from '../types';

import { ToolCallRow } from './ToolCallRow';

function makeItem(overrides: Partial<ToolTranscriptItem> = {}): ToolTranscriptItem {
  return {
    kind: 'tool',
    id: 'tool-c1',
    callId: 'c1',
    name: 'run_shell',
    args: { command: 'pnpm test' },
    seq: 0,
    status: 'running',
    stdout: '',
    stderr: '',
    shownBytes: 0,
    totalBytes: null,
    exitCode: null,
    durationMs: null,
    startedAt: 0,
    ...overrides,
  };
}

describe('ToolCallRow', () => {
  // Real timers by default (Base UI's Collapsible does its own height measurement); fake timers
  // are opted into only by the one test that needs to control the live elapsed clock.
  afterEach(() => {
    vi.useRealTimers();
  });

  // Collapsed-row summaries per tool, including the unknown-shape fallback.
  it.each([
    ['run_shell', { command: 'rg -n "login" tests/' }, 'rg -n "login" tests/'],
    [
      'read_file',
      { path: 'tests/auth/login.test.ts', startLine: 1, endLine: 80 },
      'tests/auth/login.test.ts:1-80',
    ],
    ['write_file', { path: 'tests/auth/login.test.ts' }, 'tests/auth/login.test.ts'],
    ['list_dir', { path: 'tests/auth' }, 'tests/auth'],
  ] as const)('summarizes %s arguments in the collapsed row', (name, args, expected) => {
    render(<ToolCallRow item={makeItem({ name, args })} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  // An unrecognized shape falls back to a JSON dump rather than throwing.
  it('falls back to a JSON summary for an unexpected shape', () => {
    render(<ToolCallRow item={makeItem({ name: 'run_shell', args: { odd: true } })} />);
    expect(screen.getByText('{ "odd": true }')).toBeInTheDocument();
  });

  // A secret shape embedded in the arguments never reaches the DOM, in the summary or expanded.
  it('never renders a canary secret from the arguments', async () => {
    const user = userEvent.setup();
    render(
      <ToolCallRow
        item={makeItem({ args: { command: `curl -H "Authorization: Bearer ${GITHUB_CANARY}"` } })}
      />,
    );
    await user.click(screen.getByRole('button'));
    expect(document.body.textContent).not.toContain(GITHUB_CANARY);
  });

  // A secret shape embedded in tool output (stdout/stderr) is masked in the expanded view and in
  // the value the copy button writes — defence in depth even though the worker already redacts.
  it('never renders a canary secret from stdout/stderr, and masks the copied value', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <ToolCallRow
        item={makeItem({
          stdout: `token=${GITHUB_CANARY}\n`,
          stderr: `leaked ${OPENAI_CANARY}\n`,
        })}
      />,
    );
    await user.click(screen.getByRole('button'));
    expect(document.body.textContent).not.toContain(GITHUB_CANARY);
    expect(document.body.textContent).not.toContain(OPENAI_CANARY);

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).not.toContain(GITHUB_CANARY);
    expect(copied).not.toContain(OPENAI_CANARY);
  });

  // Running: pulsing dot, live elapsed time, and a Stop button that fires onStop.
  it('shows a live elapsed time while running and fires onStop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onStop = vi.fn();
    render(<ToolCallRow item={makeItem({ status: 'running', startedAt: 0 })} onStop={onStop} />);
    expect(screen.getByText('00:00')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByText('00:03')).toBeInTheDocument();
    vi.useRealTimers();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Stop tool' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  // No Stop button renders when onStop is not provided.
  it('renders no Stop button without onStop', () => {
    render(<ToolCallRow item={makeItem({ status: 'running' })} />);
    expect(screen.queryByRole('button', { name: 'Stop tool' })).toBeNull();
  });

  // Succeeded: exit code and duration.
  it('shows exit code and duration when succeeded', () => {
    render(
      <ToolCallRow
        item={makeItem({ name: 'run_shell', status: 'succeeded', exitCode: 0, durationMs: 300 })}
      />,
    );
    expect(screen.getByText('exit 0 · 0.3 s')).toBeInTheDocument();
  });

  // A null durationMs (defensive: the field is nullable in the model) renders as 0.0 s.
  it('shows 0.0 s when durationMs is null and succeeded', () => {
    render(
      <ToolCallRow
        item={makeItem({ name: 'run_shell', status: 'succeeded', exitCode: 0, durationMs: null })}
      />,
    );
    expect(screen.getByText('exit 0 · 0.0 s')).toBeInTheDocument();
  });

  // write_file also shows the byte count once succeeded.
  it('shows the byte count for a succeeded write_file', () => {
    render(
      <ToolCallRow
        item={makeItem({
          name: 'write_file',
          args: { path: 'src/index.ts' },
          status: 'succeeded',
          exitCode: 0,
          durationMs: 100,
          totalBytes: 2_048,
        })}
      />,
    );
    expect(screen.getByText('exit 0 · 0.1 s · 2.0 KB')).toBeInTheDocument();
  });

  // A null durationMs when failed also renders as 0.0 s.
  it('shows 0.0 s when durationMs is null and failed', () => {
    render(<ToolCallRow item={makeItem({ status: 'failed', exitCode: 1, durationMs: null })} />);
    expect(screen.getByText('exit 1 · 0.0 s')).toBeInTheDocument();
  });

  // Failed: exit code + duration in the destructive colour.
  it('shows a destructive exit code and duration when failed', () => {
    render(<ToolCallRow item={makeItem({ status: 'failed', exitCode: 1, durationMs: 500 })} />);
    const meta = screen.getByText('exit 1 · 0.5 s');
    expect(meta).toHaveClass('text-destructive');
  });

  // Timed out: destructive "timed out" text, no exit code.
  it('shows "timed out" in the destructive colour when timed out', () => {
    render(<ToolCallRow item={makeItem({ status: 'timed_out' })} />);
    const meta = screen.getByText('timed out');
    expect(meta).toHaveClass('text-destructive');
  });

  // Enter and Space both toggle the row via native button semantics.
  it('toggles via keyboard (Enter and Space)', async () => {
    const user = userEvent.setup();
    render(<ToolCallRow item={makeItem({ stdout: 'ok\n' })} />);
    const trigger = screen.getByRole('button', { name: /run_shell/ });
    trigger.focus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard(' ');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  // defaultOpen renders the row already expanded.
  it('starts expanded when defaultOpen is true', () => {
    render(<ToolCallRow item={makeItem({ stdout: 'ok\n' })} defaultOpen />);
    expect(screen.getByRole('button', { name: /run_shell/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  // Expanded content shows the arguments and the combined stdout/stderr output.
  it('shows arguments and output when expanded', async () => {
    const user = userEvent.setup();
    render(
      <ToolCallRow
        item={makeItem({ args: { command: 'echo hi' }, stdout: 'hi\n', stderr: 'warn\n' })}
      />,
    );
    await user.click(screen.getByRole('button'));
    const log = screen.getByRole('log');
    expect(within(log).getByText('hi', { exact: false })).toBeInTheDocument();
    const stderrBlock = within(log).getByText('warn', { exact: false });
    expect(stderrBlock).toHaveClass('border-destructive');
    expect(screen.getByText(/"command": "echo hi"/)).toBeInTheDocument();
  });

  // Empty output renders "No output." instead of an empty log region.
  it('shows "No output." when stdout and stderr are both empty', async () => {
    const user = userEvent.setup();
    render(<ToolCallRow item={makeItem()} />);
    await user.click(screen.getByRole('button'));
    expect(screen.getByText('No output.')).toBeInTheDocument();
    expect(screen.queryByRole('log')).toBeNull();
  });

  // The truncation footer appears only when totalBytes exceeds shownBytes.
  it('shows the truncation footer when totalBytes exceeds shownBytes', async () => {
    const user = userEvent.setup();
    render(
      <ToolCallRow
        item={makeItem({
          stdout: 'x'.repeat(TOOL_OUTPUT_DISPLAY_LIMIT_BYTES),
          shownBytes: TOOL_OUTPUT_DISPLAY_LIMIT_BYTES,
          totalBytes: TOOL_OUTPUT_DISPLAY_LIMIT_BYTES + 1_000,
        })}
      />,
    );
    await user.click(screen.getByRole('button'));
    expect(screen.getByText(/truncated — /)).toBeInTheDocument();
  });

  // No truncation footer when the full output is shown.
  it('shows no truncation footer when output was not capped', async () => {
    const user = userEvent.setup();
    render(<ToolCallRow item={makeItem({ stdout: 'hi\n', shownBytes: 3, totalBytes: 3 })} />);
    await user.click(screen.getByRole('button'));
    expect(screen.queryByText(/truncated — /)).toBeNull();
  });
});

describe('ToolCallRow copy button', () => {
  // The output copy button writes the combined stdout/stderr text. The clipboard mock is
  // installed after userEvent.setup(): userEvent installs its own clipboard stub during setup
  // (to support copy/paste simulation), which would otherwise shadow this one.
  it('copies the output text', async () => {
    const user = userEvent.setup();
    render(<ToolCallRow item={makeItem({ stdout: 'out\n', stderr: 'err\n' })} />);
    await user.click(screen.getByRole('button', { name: /run_shell/ }));

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('out\nerr\n');
    });
  });
});
