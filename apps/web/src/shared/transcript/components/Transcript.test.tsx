/**
 * Tests for the transcript scroll container: every item kind, empty state, auto-follow, jump to
 * latest, readOnly, and the bare streaming cursor.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { TranscriptItem } from '../types';

import { Transcript } from './Transcript';

const ITEMS: readonly TranscriptItem[] = [
  { kind: 'user', id: 'u1', text: 'Fix the flaky test' },
  { kind: 'assistant', id: 'a1', text: 'Looking into it.', streaming: false },
  {
    kind: 'tool',
    id: 't1',
    callId: 'c1',
    name: 'run_shell',
    args: { command: 'pnpm test' },
    seq: 0,
    status: 'succeeded',
    stdout: 'ok\n',
    stderr: '',
    shownBytes: 3,
    totalBytes: 3,
    exitCode: 0,
    durationMs: 100,
    startedAt: 0,
  },
  { kind: 'notice', id: 'n1', tone: 'success', text: 'Pushed agent/x @ abcdef1' },
  { kind: 'error', id: 'e1', code: 'E', message: 'boom' },
];

/** Items whose optional fields (`at`, `durationMs`) are set, for the pass-through branches. */
const ITEMS_WITH_OPTIONAL_FIELDS: readonly TranscriptItem[] = [
  { kind: 'user', id: 'u2', text: 'Timestamped message', at: '2026-01-01T00:00:00.000Z' },
  {
    kind: 'notice',
    id: 'n2',
    tone: 'success',
    text: 'Prepared agent/x at abcdef1',
    durationMs: 2_100,
  },
];

/** Stubs the scroll geometry jsdom does not compute, so auto-follow logic is testable. */
function stubScrollGeometry(
  element: HTMLElement,
  {
    scrollHeight,
    clientHeight,
    scrollTop,
  }: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    value: scrollTop,
    writable: true,
  });
}

describe('Transcript', () => {
  // Every item kind renders its own row, tagged with data-item-kind for the kinds that carry it.
  it('renders every item kind', () => {
    render(<Transcript items={ITEMS} phase="succeeded" />);
    expect(screen.getByText('Fix the flaky test')).toBeInTheDocument();
    expect(screen.getByText('Looking into it.')).toBeInTheDocument();
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
    expect(screen.getByText('Pushed agent/x @ abcdef1')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });

  // A user item's `at` and a notice item's `durationMs`, when present, are passed through.
  it('passes through an optional at and durationMs when present', () => {
    const { container } = render(
      <Transcript items={ITEMS_WITH_OPTIONAL_FIELDS} phase="succeeded" />,
    );
    expect(container.querySelector('[data-item-kind="user"]')).toHaveAttribute(
      'title',
      '2026-01-01T00:00:00.000Z',
    );
    expect(screen.getByText('2.1 s')).toBeInTheDocument();
  });

  // Empty items with phase idle shows the (default or custom) empty text.
  it('shows the default empty text when idle with no items', () => {
    render(<Transcript items={[]} phase="idle" />);
    expect(screen.getByText('No messages yet.')).toBeInTheDocument();
  });

  // A caller can replace the empty text without losing the empty state itself.
  it('shows a custom empty text when provided', () => {
    render(<Transcript items={[]} phase="idle" emptyText="Nothing here yet." />);
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
  });

  // The container carries the required test hook and landmark attributes.
  it('exposes the transcript test id and region role', () => {
    render(<Transcript items={[]} phase="idle" />);
    const region = screen.getByTestId('transcript');
    expect(region).toHaveAttribute('role', 'region');
    expect(region).toHaveAttribute('aria-label', 'Transcript');
  });

  // While at the bottom, appending an item scrolls the container to the new bottom.
  it('auto-follows (scrolls to bottom) when items change while at the bottom', () => {
    const { container, rerender } = render(
      <Transcript items={ITEMS.slice(0, 1)} phase="running" />,
    );
    const region = container.querySelector<HTMLElement>('[data-testid="transcript"]')!;
    stubScrollGeometry(region, { scrollHeight: 500, clientHeight: 300, scrollTop: 200 });

    rerender(<Transcript items={ITEMS} phase="running" />);
    expect(region.scrollTop).toBe(500);
  });

  // When scrolled away from the bottom, the Jump to latest pill appears.
  it('shows Jump to latest when scrolled away from the bottom', () => {
    const { container } = render(<Transcript items={ITEMS} phase="succeeded" />);
    const region = container.querySelector<HTMLElement>('[data-testid="transcript"]')!;
    stubScrollGeometry(region, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
    fireEvent.scroll(region);
    expect(screen.getByRole('button', { name: /Jump to latest/i })).toBeInTheDocument();
  });

  // Clicking Jump to latest scrolls to the bottom and hides the pill again.
  it('clicking Jump to latest scrolls to the bottom and re-enables follow', async () => {
    const user = userEvent.setup();
    const { container } = render(<Transcript items={ITEMS} phase="succeeded" />);
    const region = container.querySelector<HTMLElement>('[data-testid="transcript"]')!;
    stubScrollGeometry(region, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
    fireEvent.scroll(region);
    const scrollTo = vi.fn();
    region.scrollTo = scrollTo;

    await user.click(screen.getByRole('button', { name: /Jump to latest/i }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
    expect(screen.queryByRole('button', { name: /Jump to latest/i })).toBeNull();
  });

  // Under prefers-reduced-motion, the jump is instant rather than smooth.
  it('jumps instantly under prefers-reduced-motion', async () => {
    const user = userEvent.setup();
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia });
    const { container } = render(<Transcript items={ITEMS} phase="succeeded" />);
    const region = container.querySelector<HTMLElement>('[data-testid="transcript"]')!;
    stubScrollGeometry(region, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
    fireEvent.scroll(region);
    const scrollTo = vi.fn();
    region.scrollTo = scrollTo;

    await user.click(screen.getByRole('button', { name: /Jump to latest/i }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' });

    Reflect.deleteProperty(window, 'matchMedia');
  });

  // readOnly hides tool Stop buttons even for a running tool.
  it('hides the Stop button on a running tool when readOnly', () => {
    const runningItems: readonly TranscriptItem[] = [
      { ...ITEMS[2], status: 'running' } as TranscriptItem,
    ];
    render(<Transcript items={runningItems} phase="running" readOnly onStopTool={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Stop tool' })).toBeNull();
  });

  // onStopTool is wired to the running tool's Stop button when not readOnly.
  it('wires onStopTool to a running tool Stop button', async () => {
    const user = userEvent.setup();
    const onStopTool = vi.fn();
    const runningItems: readonly TranscriptItem[] = [
      { ...ITEMS[2], status: 'running' } as TranscriptItem,
    ];
    render(<Transcript items={runningItems} phase="running" onStopTool={onStopTool} />);
    await user.click(screen.getByRole('button', { name: 'Stop tool' }));
    expect(onStopTool).toHaveBeenCalledWith('c1');
  });

  // While running/preparing and the last item is not a streaming assistant bubble, a bare cursor
  // line shows the turn is still active.
  it('shows a bare stream cursor while running with no active streaming bubble', () => {
    render(<Transcript items={ITEMS} phase="running" />);
    expect(screen.getByTestId('stream-cursor')).toBeInTheDocument();
  });

  // No bare cursor when the last item is already a streaming assistant bubble (it has its own).
  it('does not duplicate the cursor when the last item is a streaming assistant bubble', () => {
    const streamingItems: readonly TranscriptItem[] = [
      { kind: 'assistant', id: 'a2', text: 'Working…', streaming: true },
    ];
    render(<Transcript items={streamingItems} phase="running" />);
    expect(screen.getAllByTestId('stream-cursor')).toHaveLength(1);
  });

  // No bare cursor once the turn is terminal.
  it('shows no bare cursor once the turn has finished', () => {
    render(<Transcript items={ITEMS} phase="succeeded" />);
    expect(screen.queryByTestId('stream-cursor')).toBeNull();
  });
});
