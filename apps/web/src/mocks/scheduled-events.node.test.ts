/** @vitest-environment node */
/**
 * Unit tests for the `GET /api/runs/:id/events` mock stream.
 *
 * Layer: unit.
 * Goal: the endpoint serves the scripted frame script as `text/event-stream`, replays only frames
 * after `from`, streams instantly for an already-terminal run, and settles an active run to
 * SUCCEEDED/FAILED (per scenario) once the script has been sent.
 * Mocks: MSW node server; a `location` shim (the `node` environment has none, and MSW resolves
 * its handlers' relative paths against it) plus a plain absolute-URL `fetch`.
 */
import type { RunDetail } from '@agent-hangar/core';
import { afterEach, describe, expect, it } from 'vitest';

import { setScenario } from '@/mocks/scenario';
import { registerMockServer } from '@/mocks/vitest';

import { resetScheduledStore } from './scheduled';

// The `node` test environment has no `location` global; MSW resolves a handler's relative path
// against it to build the absolute pattern it matches requests with. Without it, every relative
// handler path here would stay unresolved and never match this file's absolute-URL fetches.
Object.defineProperty(globalThis, 'location', {
  value: new URL('http://localhost/'),
  configurable: true,
});

registerMockServer();

afterEach(() => {
  resetScheduledStore();
  setScenario('default');
});

function parseFrames(body: string): { id: string; event: string }[] {
  return body
    .trim()
    .split('\n\n')
    .filter((block) => block.length > 0)
    .map((block) => {
      const idLine = block.split('\n').find((line) => line.startsWith('id: '));
      const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
      return { id: idLine?.slice(4) ?? '', event: eventLine?.slice(7) ?? '' };
    });
}

describe('GET /api/runs/:id/events', () => {
  /** An unknown run id answers 404. */
  it('answers 404 for an unknown run', async () => {
    const response = await fetch('http://localhost/api/runs/missing/events');
    expect(response.status).toBe(404);
  });

  /** An already-terminal run streams its whole script immediately, ending in `turn.completed`. */
  it('streams the full script instantly for a terminal run', async () => {
    const response = await fetch('http://localhost/api/runs/run-nightly-success/events');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const frames = parseFrames(await response.text());
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.at(-1)?.event).toBe('turn.completed');
  });

  /** `from` replays only frames whose id is strictly greater. */
  it('replays only frames after `from`', async () => {
    const full = parseFrames(
      await (await fetch('http://localhost/api/runs/run-nightly-success/events')).text(),
    );
    const replayed = parseFrames(
      await (await fetch('http://localhost/api/runs/run-nightly-success/events?from=3')).text(),
    );
    expect(replayed.length).toBe(full.length - 3);
  });

  /** Streaming the events of a RUNNING run settles it to SUCCEEDED with the final message. */
  it('settles an active run to SUCCEEDED with output', async () => {
    await fetch('http://localhost/api/runs/run-nightly-running/events');
    const detail = (await (
      await fetch('http://localhost/api/runs/run-nightly-running')
    ).json()) as RunDetail;
    expect(detail.run.status).toBe('SUCCEEDED');
    expect(detail.output).not.toBeNull();
  });

  /** Under the `infra-down` scenario, streaming settles the run to FAILED instead. */
  it('settles an active run to FAILED under the infra-down scenario', async () => {
    setScenario('infra-down');
    await fetch('http://localhost/api/runs/run-nightly-running/events');
    const detail = (await (
      await fetch('http://localhost/api/runs/run-nightly-running')
    ).json()) as RunDetail;
    expect(detail.run.status).toBe('FAILED');
    expect(detail.run.error).toBe('Workspace unavailable.');
  });
});
