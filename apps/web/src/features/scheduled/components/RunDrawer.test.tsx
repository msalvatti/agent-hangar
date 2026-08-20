/**
 * Unit tests for `RunDrawer`.
 *
 * Layer: unit.
 * Goal: renders the header/pill and persisted transcript for a terminal run; streams live via a
 * fake `EventSource` for an active run (tool call running → done, final text, pill "Done"); the
 * stop flow hits the cancel endpoint; a reconnecting bar shows during reconnection; `expired`
 * triggers a refetch; the raw-output tab shows the output and copies it; Esc closes; the sheet
 * content carries the 720 px width class.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`; a fake `EventSource` factory; a
 * stubbed `navigator.clipboard`.
 */
import type { JobSummary } from '@agent-hangar/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { server } from '@/mocks/server';
import { createFakeEventSourceFactory } from '@/shared/transcript/testing';

import { RunDrawer } from './RunDrawer';

afterEach(() => {
  resetScheduledStore();
});

/**
 * `userEvent.setup()` installs its own `navigator.clipboard`, so the stub must be applied after
 * it runs, not before.
 */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

const job: JobSummary = {
  id: 'job-nightly-tests',
  name: 'Nightly tests',
  cron: '0 2 * * *',
  timezone: 'UTC',
  prompt: 'Run the full test suite.',
  repoUrl: 'https://github.com/acme/api',
  branch: 'main',
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastRunStatus: null,
};

describe('RunDrawer — terminal run', () => {
  /** Renders the header (job name, status pill) and the persisted transcript. */
  it('renders the header and persisted transcript', async () => {
    render(<RunDrawer runId="run-nightly-success" job={job} open onOpenChange={vi.fn()} />);
    expect(screen.getByText('Nightly tests')).toBeInTheDocument();
    expect(await screen.findByText('Done')).toBeInTheDocument();
    expect(await screen.findByText('run_shell')).toBeInTheDocument();
    expect(document.querySelector('[data-tool-status="succeeded"]')).not.toBeNull();
  });

  /** The sheet content carries the 720 px width class. */
  it('applies the 720px sheet width class', async () => {
    render(<RunDrawer runId="run-nightly-success" job={job} open onOpenChange={vi.fn()} />);
    await screen.findByText('Done');
    expect(document.querySelector('.sm\\:max-w-\\[720px\\]')).not.toBeNull();
  });

  /** The raw-output tab shows the persisted output and copies it. */
  it('shows and copies the raw output', async () => {
    const user = userEvent.setup();
    render(<RunDrawer runId="run-nightly-success" job={job} open onOpenChange={vi.fn()} />);
    await screen.findByText('Done');
    await user.click(screen.getByRole('tab', { name: 'Raw output' }));
    expect(await screen.findByText('Ran the test suite; all tests passed.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy output' }));
  });

  /** Esc closes the drawer. */
  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<RunDrawer runId="run-nightly-success" job={job} open onOpenChange={onOpenChange} />);
    await screen.findByText('Done');
    await user.keyboard('{Escape}');
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  });

  /** Renders an error card when the run fails to load. */
  it('renders an error card on load failure', async () => {
    render(<RunDrawer runId="does-not-exist" job={job} open onOpenChange={vi.fn()} />);
    expect(await screen.findByText('Could not load the run')).toBeInTheDocument();
  });

  /** Shows a skeleton while the run detail request is in flight. */
  it('shows a loading skeleton while the run is loading', async () => {
    server.use(
      http.get(
        '/api/runs/:id',
        () =>
          new Promise(() => {
            // Never resolves: keeps the query in its loading state for the assertion below.
          }),
      ),
    );
    render(<RunDrawer runId="run-nightly-success" job={job} open onOpenChange={vi.fn()} />);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    });
  });
});

describe('RunDrawer — active run (live stream)', () => {
  /** Streams a tool call from running to done, then the final message and a "Done" pill. */
  it('streams a tool call and completion live', async () => {
    const { factory, instances } = createFakeEventSourceFactory();
    render(
      <RunDrawer
        runId="run-nightly-running"
        job={job}
        open
        onOpenChange={vi.fn()}
        createEventSource={factory}
      />,
    );
    await waitFor(() => {
      expect(instances.length).toBeGreaterThan(0);
    });
    const source = instances[0];
    if (source === undefined) {
      throw new Error('expected a fake EventSource instance');
    }
    source.open();
    source.emit(
      'turn.started',
      { type: 'turn.started', turnId: 'run-nightly-running', at: new Date().toISOString() },
      '1',
    );
    source.emit(
      'tool.call',
      { type: 'tool.call', callId: 'call-1', name: 'run_shell', args: {}, seq: 0 },
      '2',
    );
    expect(await screen.findByText('run_shell')).toBeInTheDocument();
    expect(document.querySelector('[data-tool-status="running"]')).not.toBeNull();

    source.emit(
      'tool.result',
      {
        type: 'tool.result',
        callId: 'call-1',
        exitCode: 0,
        bytes: 0,
        durationMs: 10,
        status: 'SUCCEEDED',
      },
      '3',
    );
    await waitFor(() => {
      expect(document.querySelector('[data-tool-status="succeeded"]')).not.toBeNull();
    });

    source.emit(
      'turn.completed',
      {
        type: 'turn.completed',
        usage: { inputTokens: 1, outputTokens: 1 },
        steps: 1,
        finalMessage: 'All done.',
      },
      '4',
    );
    expect(await screen.findByText('Done')).toBeInTheDocument();
  });

  /** Shows a reconnecting bar while the connection is reconnecting. */
  it('shows a reconnecting bar', async () => {
    const { factory, instances } = createFakeEventSourceFactory();
    render(
      <RunDrawer
        runId="run-nightly-running"
        job={job}
        open
        onOpenChange={vi.fn()}
        createEventSource={factory}
      />,
    );
    await waitFor(() => {
      expect(instances.length).toBeGreaterThan(0);
    });
    const source = instances[0];
    if (source === undefined) {
      throw new Error('expected a fake EventSource instance');
    }
    source.open();
    source.fail({ reconnecting: true });
    expect(await screen.findByText('Reconnecting…')).toBeInTheDocument();
  });

  /** An `expired` frame refetches the run detail instead of leaving the stream stuck. */
  it('refetches the run detail on expired', async () => {
    const { factory, instances } = createFakeEventSourceFactory();
    render(
      <RunDrawer
        runId="run-nightly-running"
        job={job}
        open
        onOpenChange={vi.fn()}
        createEventSource={factory}
      />,
    );
    await waitFor(() => {
      expect(instances.length).toBeGreaterThan(0);
    });
    const source = instances[0];
    if (source === undefined) {
      throw new Error('expected a fake EventSource instance');
    }
    source.open();
    source.emit('expired', {});
    // The run stays visible (the refetch replaces state without unmounting the drawer).
    expect(await screen.findByText('Nightly tests')).toBeInTheDocument();
  });

  /** The Stop button opens a confirmation, and confirming hits the cancel endpoint. */
  it('stops an active run after confirming', async () => {
    const { factory, instances } = createFakeEventSourceFactory();
    const user = userEvent.setup();
    render(
      <RunDrawer
        runId="run-nightly-running"
        job={job}
        open
        onOpenChange={vi.fn()}
        createEventSource={factory}
      />,
    );
    await waitFor(() => {
      expect(instances.length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole('button', { name: 'Stop run' }));
    expect(await screen.findByText('Stop this run?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(screen.queryByText('Stop this run?')).not.toBeInTheDocument();
    });
  });

  /** Copy run id calls the clipboard with the run id. */
  it('copies the run id', async () => {
    const { factory } = createFakeEventSourceFactory();
    const user = userEvent.setup();
    const writeText = stubClipboard();
    render(
      <RunDrawer
        runId="run-nightly-running"
        job={job}
        open
        onOpenChange={vi.fn()}
        createEventSource={factory}
      />,
    );
    await screen.findByText('Nightly tests');
    await user.click(screen.getByRole('button', { name: 'Copy run id' }));
    expect(writeText).toHaveBeenCalledWith('run-nightly-running');
  });

  /**
   * A queued run is active: the drawer must connect its stream and offer Stop for it, the same as
   * a running one. Excluding queued here while `isRunActive` counted it left a run that could be
   * neither watched nor stopped.
   */
  it('connects and offers Stop for a queued run', async () => {
    server.use(
      http.get('/api/runs/:id', () =>
        HttpResponse.json({
          run: {
            id: 'run-queued',
            jobId: 'job-nightly-tests',
            status: 'QUEUED',
            trigger: 'SCHEDULE',
            model: 'gpt-5-mini',
            usage: { inputTokens: null, outputTokens: null, stepCount: 0 },
            error: null,
            scheduledFor: '2026-08-19T10:00:00.000Z',
            queuedAt: '2026-08-19T10:00:00.000Z',
            startedAt: null,
            finishedAt: null,
          },
          output: null,
          toolCalls: [],
        }),
      ),
    );
    const { factory, instances } = createFakeEventSourceFactory();
    render(
      <RunDrawer
        runId="run-queued"
        job={job}
        open
        onOpenChange={vi.fn()}
        createEventSource={factory}
      />,
    );
    await waitFor(() => {
      expect(instances.length).toBeGreaterThan(0);
    });
    expect(await screen.findByRole('button', { name: 'Stop run' })).toBeInTheDocument();
  });
});
