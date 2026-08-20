/**
 * Unit tests for the `@redis` integration helpers.
 *
 * Layer: unit.
 * Goal: the helper reads the configured URL, describes it by host and port only even when the URL
 * carries credentials, generates a collision-free key prefix, bounds how long a ping may hang, and
 * decides whether a `@redis` suite runs, skips or fails the run outright.
 * Mocks: fake timers for the ping timeout; no Redis.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CI_ENV,
  describeRedis,
  describeRedisTarget,
  PING_TIMEOUT_MS,
  pingOrFail,
  REDIS_URL_ENV,
  requireRedisUrl,
  shouldRunRedisSuite,
  uniquePrefix,
} from './redis.integration-helper.ts';

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

describe('shouldRunRedisSuite', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * A configured URL is what the suite connects with, and there is nothing to explain, so the
   * reason stays empty rather than carrying a message no caller would print.
   */
  it('returns the configured URL when Redis is configured', () => {
    vi.stubEnv(REDIS_URL_ENV, 'redis://127.0.0.1:3252');
    expect(shouldRunRedisSuite('@redis probe')).toEqual({ url: 'redis://127.0.0.1:3252' });
  });

  /**
   * In CI an unconfigured Redis must fail the run rather than skip: a skipped integration suite
   * reports the same green as a passing one, so a broken service would ship unnoticed. Throwing —
   * instead of returning a decision — is what makes that impossible for a caller to ignore, and
   * the message has to name the job that is supposed to provide the service.
   */
  it('throws instead of skipping when Redis is unconfigured in CI', () => {
    vi.stubEnv(REDIS_URL_ENV, '');
    vi.stubEnv(CI_ENV, 'true');
    expect(() => shouldRunRedisSuite('@redis probe')).toThrow(
      /REDIS_URL is not set.*\.github\/workflows\/ci\.yml/s,
    );
  });

  /**
   * Locally the same situation is ordinary — not everyone runs the stack — so it skips, and the
   * notice has to say which suite went missing and how to bring it back.
   */
  it('skips locally with a notice naming the suite and the command that starts the stack', () => {
    vi.stubEnv(REDIS_URL_ENV, '');
    vi.stubEnv(CI_ENV, undefined);
    const decision = shouldRunRedisSuite('@redis queue factories');
    // A running decision carries no reason at all, so there is nothing to read on that branch.
    const reason = decision.url === null ? decision.reason : '';
    expect(decision.url).toBeNull();
    expect(reason).toContain('@redis queue factories');
    expect(reason).toContain(REDIS_URL_ENV);
    expect(reason).toContain('pnpm infra:up');
  });
});

describe('describeRedis', () => {
  /**
   * Registered directly at collection time (describe bodies run synchronously, `it` bodies run
   * later), with the environment pinned around each call so the outcome does not depend on
   * whatever is exported in the shell actually running this suite.
   */
  const savedRedisUrl = process.env[REDIS_URL_ENV];
  const savedCi = process.env[CI_ENV];
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

  process.env[REDIS_URL_ENV] = 'redis://127.0.0.1:3252';
  Reflect.deleteProperty(process.env, CI_ENV);
  let urlHandedToTheSuite: string | null = null;
  describeRedis('probe suite (REDIS_URL set)', (url) => {
    /**
     * Runs for real, and records what it was handed so the assertions further down can prove both
     * that it ran and that the URL reached it.
     */
    it('receives the configured URL', () => {
      urlHandedToTheSuite = url;
      expect(url).toBe('redis://127.0.0.1:3252');
    });
  });

  Reflect.deleteProperty(process.env, REDIS_URL_ENV);
  Reflect.deleteProperty(process.env, CI_ENV);
  describeRedis('probe suite (REDIS_URL unset)', () => {
    /**
     * Registered but never executed: a skipped suite that still ran its body would connect to a
     * Redis the developer was just told is not there. Throwing is how that shows up as a failure
     * instead of a hang.
     */
    it('never actually runs', () => {
      throw new Error('a skipped @redis suite must not execute its body');
    });
  });

  const noticesPrinted = info.mock.calls.map((call) => String(call[0]));
  info.mockRestore();
  if (savedRedisUrl === undefined) {
    Reflect.deleteProperty(process.env, REDIS_URL_ENV);
  } else {
    process.env[REDIS_URL_ENV] = savedRedisUrl;
  }
  if (savedCi === undefined) {
    Reflect.deleteProperty(process.env, CI_ENV);
  } else {
    process.env[CI_ENV] = savedCi;
  }

  /**
   * The non-skipped probe above actually executed its `it`, and the URL reached the suite body —
   * which is the whole point of the callback taking one, rather than every suite re-reading the
   * environment.
   */
  it('runs the wrapped suite and hands it the configured URL', () => {
    expect(urlHandedToTheSuite).toBe('redis://127.0.0.1:3252');
  });

  /**
   * Exactly one notice was printed, for the suite that was skipped: a suite that runs must stay
   * silent, or the instruction stops meaning "something did not run".
   */
  it('prints the skip notice only for the suite it skipped', () => {
    expect(noticesPrinted).toHaveLength(1);
    expect(noticesPrinted[0]).toContain('probe suite (REDIS_URL unset)');
  });
});
