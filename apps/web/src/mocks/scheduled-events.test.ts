/**
 * Unit tests for the `GET /api/runs/:id/events` mock stream.
 *
 * Layer: unit.
 * Goal: the endpoint serves the scripted frames as `text/event-stream`, replays only the frames
 * after `from`, and settles a still-active run to the outcome its script ends on only once the
 * terminal frame is actually delivered — not the moment the stream is opened — so a cancel
 * requested while the script is still playing back wins over the script's own ending.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`.
 *
 * Runs under the suite's default jsdom environment rather than a plain Node one: the mock
 * bootstrap resolves the relative URLs `apiFetch` sends against `location.origin`, and only jsdom
 * provides `location`.
 */
import type { RunDetail } from '@agent-hangar/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setScenario } from '@/mocks/scenario';

import { resetScheduledStore } from './scheduled';

afterEach(() => {
  resetScheduledStore();
});

/** Posts a cancel request for a run, mirroring what `useRunActions`'s `stop` sends. */
async function cancelRun(runId: string): Promise<void> {
  await fetch(`/api/turns/${runId}/cancel`, { method: 'POST' });
}

/** Parses raw SSE text into its `id`/`event` pairs, ignoring heartbeat comments. */
function parseFrames(body: string): { id: string; event: string }[] {
  return body
    .trim()
    .split('\n\n')
    .filter((block) => block.length > 0 && !block.startsWith(': '))
    .map((block) => {
      const lines = block.split('\n');
      const idLine = lines.find((line) => line.startsWith('id: '));
      const eventLine = lines.find((line) => line.startsWith('event: '));
      return {
        id: idLine?.slice('id: '.length) ?? '',
        event: eventLine?.slice('event: '.length) ?? '',
      };
    });
}

/** Reads a run's detail through the mock API. */
async function fetchRun(runId: string): Promise<RunDetail> {
  const response = await fetch(`/api/runs/${runId}`);
  return (await response.json()) as RunDetail;
}

describe('GET /api/runs/:id/events', () => {
  /** An unknown id is a 404, not an empty stream that would hang the drawer. */
  it('answers 404 for an unknown run', async () => {
    const response = await fetch('/api/runs/missing/events');
    expect(response.status).toBe(404);
  });

  /** A finished run replays its whole script as an event stream, ending on completion. */
  it('streams the full script for a terminal run', async () => {
    const response = await fetch('/api/runs/run-nightly-success/events');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const frames = parseFrames(await response.text());
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.at(-1)?.event).toBe('turn.completed');
  });

  /** `from` is a resume point: a reconnect replays only what the client has not seen. */
  it('replays only the frames after `from`', async () => {
    const full = parseFrames(await (await fetch('/api/runs/run-nightly-success/events')).text());
    const third = full[2];
    if (third === undefined) {
      throw new Error('expected the script to have more than three frames');
    }
    const replayed = parseFrames(
      await (await fetch(`/api/runs/run-nightly-success/events?from=${third.id}`)).text(),
    );
    expect(replayed.length).toBe(full.length - 3);
  });

  /**
   * Opening an active run's stream must not settle it on the spot: the script still has to play
   * out with its own delays, and a Stop click in that window has to find an active run to
   * cancel. Settling here immediately (rather than when the terminal frame is actually
   * delivered) is exactly the bug that made cancellation a no-op.
   */
  it('does not settle the run before its terminal frame is actually delivered', async () => {
    await fetch('/api/runs/run-nightly-running/events');
    const detail = await fetchRun('run-nightly-running');
    expect(detail.run.status).toBe('RUNNING');
  });

  /**
   * Requesting an active run's stream settles it once the script actually reaches its terminal
   * frame, so the detail eventually matches what was streamed.
   */
  it('settles an active run to SUCCEEDED with its final message once the script finishes', async () => {
    vi.useFakeTimers();
    await fetch('/api/runs/run-nightly-running/events');
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    const detail = await fetchRun('run-nightly-running');
    expect(detail.run.status).toBe('SUCCEEDED');
    expect(detail.output).not.toBeNull();
  });

  /**
   * The expired-stream scenario sends a resume marker and no turn events at all, so there is no
   * outcome to record: the run keeps running rather than being reported as finished.
   */
  it('leaves an active run running when the script carries no outcome', async () => {
    setScenario('expired-stream');
    await fetch('/api/runs/run-nightly-running/events');
    const detail = await fetchRun('run-nightly-running');
    expect(detail.run.status).toBe('RUNNING');
  });

  /**
   * Under the failing-turn scenario the same request settles the run to FAILED with its error,
   * once the script's terminal frame is actually delivered.
   */
  it('settles an active run to FAILED under the failing-turn scenario once the script finishes', async () => {
    setScenario('failing-turn');
    vi.useFakeTimers();
    await fetch('/api/runs/run-nightly-running/events');
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    const detail = await fetchRun('run-nightly-running');
    expect(detail.run.status).toBe('FAILED');
    expect(detail.run.error).toBe('OpenAI rejected the API key (401)');
  });

  /**
   * A cancel requested while the script is still streaming must win over the script's own
   * ending: the run stays CANCELLED once its terminal frame is later delivered, instead of being
   * overwritten back to SUCCEEDED. This is the guarantee the run drawer's Stop button depends on.
   */
  it('keeps a run CANCELLED once its terminal frame is later delivered', async () => {
    vi.useFakeTimers();
    await fetch('/api/runs/run-nightly-running/events');
    await cancelRun('run-nightly-running');
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    const detail = await fetchRun('run-nightly-running');
    expect(detail.run.status).toBe('CANCELLED');
  });
});
