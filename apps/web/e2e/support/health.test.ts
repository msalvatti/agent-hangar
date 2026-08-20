/**
 * Unit tests for the health poller.
 *
 * Layer: unit test.
 */
import { describe, expect, it } from 'vitest';

import { createApi } from './api';
import type { E2eFetcher } from './api';
import { createHealthHelper } from './health';

const BASE_URL = 'http://127.0.0.1:3900';

function healthBody(ok: boolean): string {
  return JSON.stringify({
    ok,
    instance: 'test',
    checks: {
      db: { ok },
      redis: { ok },
      docker: { ok },
      image: { ok },
      worker: { ok },
    },
  });
}

function apiReturning(bodies: readonly string[]) {
  let index = 0;
  const fetcher: E2eFetcher = async () => {
    const text = bodies[Math.min(index, bodies.length - 1)] ?? '';
    index += 1;
    return Promise.resolve({ status: 200, text });
  };
  return createApi(fetcher, BASE_URL);
}

describe('createHealthHelper', () => {
  /** A single read parses the contract body. */
  it('reads the endpoint once', async () => {
    const health = createHealthHelper(apiReturning([healthBody(true)]), 1);
    await expect(health.read()).resolves.toMatchObject({ ok: true, instance: 'test' });
  });

  /** A condition that already holds returns without polling again. */
  it('returns immediately when the condition already holds', async () => {
    const health = createHealthHelper(apiReturning([healthBody(true)]), 1);
    await expect(
      health.waitFor((body) => body.ok, 1_000, 'health to be ok'),
    ).resolves.toMatchObject({ ok: true });
  });

  /** A condition that becomes true later is caught by a later poll. */
  it('polls until the condition holds', async () => {
    const health = createHealthHelper(apiReturning([healthBody(false), healthBody(true)]), 1);
    await expect(
      health.waitFor((body) => body.ok, 1_000, 'health to be ok'),
    ).resolves.toMatchObject({ ok: true });
  });

  /** A condition that never holds fails with what was waited for and what was last seen. */
  it('fails with the condition and the last body when the budget runs out', async () => {
    const health = createHealthHelper(apiReturning([healthBody(false)]), 1);
    await expect(health.waitFor((body) => body.ok, 5, 'health to be ok')).rejects.toThrow(
      /waiting for health to be ok; last health was/,
    );
  });
});
