/**
 * Unit tests for the `@redis` integration helpers.
 *
 * Layer: unit.
 * Goal: the helper reads the configured URL, describes it by host and port only even when the URL
 * carries credentials, generates a collision-free key prefix, and bounds how long a ping may hang.
 * Mocks: fake timers for the ping timeout; no Redis.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  describeRedisTarget,
  PING_TIMEOUT_MS,
  pingOrFail,
  requireRedisUrl,
  uniquePrefix,
} from './redis.integration-helper.js';

describe('requireRedisUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * A configured URL is returned as-is, which is what the suites connect with.
   */
  it('returns a configured URL', () => {
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:3252');
    expect(requireRedisUrl()).toBe('redis://127.0.0.1:3252');
  });

  /**
   * An unset or empty variable both mean "no Redis"; an empty string is what a shell that exported
   * `REDIS_URL=` leaves behind, and treating it as configured would produce a confusing connect
   * failure instead of the skip instruction.
   */
  it('treats an unset or empty variable as absent', () => {
    vi.stubEnv('REDIS_URL', '');
    expect(requireRedisUrl()).toBeNull();
    vi.stubEnv('REDIS_URL', undefined);
    expect(requireRedisUrl()).toBeNull();
  });
});

describe('describeRedisTarget', () => {
  /**
   * The local URL is described by host and port, which is what an operator needs to know which
   * instance did not answer.
   */
  it('describes a local URL by host and port', () => {
    expect(describeRedisTarget('redis://127.0.0.1:3252')).toBe('127.0.0.1:3252');
  });

  /**
   * A connection string is exactly the kind of value that grows a password later. Should one ever
   * appear, the failure message must still name only the endpoint — this is the regression test
   * for that, not a comment promising it.
   */
  it('never echoes credentials from a URL that carries them', () => {
    const described = describeRedisTarget('rediss://admin:hunter2@redis.internal:6380');
    expect(described).toBe('redis.internal:6380');
    expect(described).not.toContain('hunter2');
    expect(described).not.toContain('admin');
    expect(describeRedisTarget('redis://:hunter2@redis.internal')).not.toContain('hunter2');
  });

  /**
   * A value that is not a URL is described generically rather than echoed, so a malformed setting
   * cannot spill whatever it actually held.
   */
  it('describes an unparsable value generically', () => {
    expect(describeRedisTarget('not a url')).toBe('the configured Redis URL');
  });
});

describe('uniquePrefix', () => {
  /**
   * Two suites running against the same Redis must not share queue keys, or each would see the
   * other's jobs; the prefix is what keeps them apart.
   */
  it('generates a distinct prefix per call', () => {
    const first = uniquePrefix();
    const second = uniquePrefix();
    expect(first).toMatch(/^ah-test-/);
    expect(first).not.toBe(second);
  });
});

describe('pingOrFail', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A Redis that answers lets the suite proceed without waiting out the timeout.
   */
  it('resolves when Redis answers', async () => {
    const connection = { ping: vi.fn().mockResolvedValue('PONG') };
    await expect(pingOrFail(connection, 'redis://127.0.0.1:3252')).resolves.toBeUndefined();
  });

  /**
   * A Redis that never answers must fail the suite with the endpoint and the command that starts
   * it, rather than hanging the run until the test runner's own timeout.
   */
  it('fails with an actionable message when Redis is silent', async () => {
    vi.useFakeTimers();
    const connection = { ping: vi.fn().mockReturnValue(new Promise<string>(() => undefined)) };
    const attempt = pingOrFail(connection, 'rediss://admin:hunter2@redis.internal:6380');
    const assertion = expect(attempt).rejects.toThrow(/redis\.internal:6380.*pnpm infra:up/s);
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    await assertion;
    await expect(attempt).rejects.not.toThrow(/hunter2/);
  });
});
