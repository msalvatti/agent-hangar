/**
 * Unit tests for the `GET /api/runs/:id/events` mock stream.
 *
 * Layer: unit.
 * Goal: the endpoint serves the scripted frames as `text/event-stream`, replays only the frames
 * after `from`, and settles a still-active run to the outcome its script ends on.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`.
 *
 * Runs under the suite's default jsdom environment rather than a plain Node one: the mock
 * bootstrap resolves the relative URLs `apiFetch` sends against `location.origin`, and only jsdom
 * provides `location`.
 */
import type { RunDetail } from '@agent-hangar/core';
import { afterEach, describe, expect, it } from 'vitest';

import { setScenario } from '@/mocks/scenario';

import { resetScheduledStore } from './scheduled';

afterEach(() => {
  resetScheduledStore();
});

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

  /** Requesting an active run's stream settles it, so the detail matches what was streamed. */
  it('settles an active run to SUCCEEDED with its final message', async () => {
    await fetch('/api/runs/run-nightly-running/events');
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

  /** Under the failing-turn scenario the same request settles the run to FAILED with its error. */
  it('settles an active run to FAILED under the failing-turn scenario', async () => {
    setScenario('failing-turn');
    await fetch('/api/runs/run-nightly-running/events');
    const detail = await fetchRun('run-nightly-running');
    expect(detail.run.status).toBe('FAILED');
    expect(detail.run.error).toBe('OpenAI rejected the API key (401)');
  });
});
