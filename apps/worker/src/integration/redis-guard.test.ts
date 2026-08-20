/**
 * Unit tests for the Redis erasure guard.
 *
 * Layer: unit.
 * Goal: the guard fails closed — no opt-in, a Redis that is not this instance's, or a URL it
 * cannot read are all refusals — and no refusal ever repeats the connection string.
 * Mocks: none; the guard is a pure function over the configuration and an environment map.
 */
import { loadConfig } from '@agent-hangar/core';
import type { AppConfig } from '@agent-hangar/core';
import { DESTRUCTIVE_TESTS_ENV, DESTRUCTIVE_TESTS_OPT_IN } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import { assertRedisErasable } from './redis-guard.js';

/** A password that no legitimate refusal message could contain. */
const REDIS_PASSWORD = 'hunter2';

/** The opt-in, as the integration suite sets it. */
const OPTED_IN = { [DESTRUCTIVE_TESTS_ENV]: DESTRUCTIVE_TESTS_OPT_IN };

/**
 * Builds the configuration of a test instance.
 *
 * @param overrides - Environment values that replace the instance defaults.
 * @returns The validated configuration.
 */
function configFor(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    AH_INSTANCE: 'w2b-test',
    AH_PORT_BASE: '3310',
    WORKSPACE_IMAGE: 'agent-hangar/workspace:test',
    MASTER_KEY_PATH: '/nonexistent/master.key',
    ...overrides,
  });
}

describe('assertRedisErasable', () => {
  /**
   * The happy path: the opt-in is set and `REDIS_URL` is the loopback port this instance derives,
   * which is a Redis nothing but this instance uses.
   */
  it('accepts this instance own Redis when the opt-in is set', () => {
    const config = configFor();

    expect(() => {
      assertRedisErasable(config, OPTED_IN);
    }).not.toThrow();
    expect(config.REDIS_URL).toBe(`redis://127.0.0.1:${String(config.REDIS_PORT)}`);
  });

  /**
   * The opt-in is the repository's stated way of saying "this target is disposable", and the
   * database half of the same harness already demands it. Without it nothing is emptied.
   */
  it('refuses without the destructive opt-in', () => {
    expect(() => {
      assertRedisErasable(configFor(), {});
    }).toThrow(DESTRUCTIVE_TESTS_ENV);
  });

  /**
   * A value that is not exactly the opt-in is not the opt-in: "true" or "0" must not pass for it.
   */
  it('refuses an opt-in set to anything else', () => {
    expect(() => {
      assertRedisErasable(configFor(), { [DESTRUCTIVE_TESTS_ENV]: 'true' });
    }).toThrow(DESTRUCTIVE_TESTS_ENV);
  });

  /**
   * The case the guard exists for: `REDIS_URL` is independent of `DATABASE_URL`, so a shared Redis
   * named alongside a conventionally named test database passes every other check the suite has.
   * A host that is not loopback is refused however the opt-in is set.
   */
  it('refuses a Redis that is not on this machine', () => {
    const config = configFor({ REDIS_URL: 'redis://cache.internal:3312' });

    expect(() => {
      assertRedisErasable(config, OPTED_IN);
    }).toThrow(/not the Redis of instance/);
  });

  /**
   * Another instance's Redis is on the same machine but a different port, and emptying it would
   * take a colleague checkout's queues and streams with it.
   */
  it('refuses another instance Redis on the same machine', () => {
    const config = configFor({ REDIS_URL: 'redis://127.0.0.1:4312' });

    expect(() => {
      assertRedisErasable(config, OPTED_IN);
    }).toThrow(/not the Redis of instance/);
  });

  /**
   * A URL the parser cannot read names no target this guard can vouch for, so it fails closed
   * rather than falling through to the flush.
   */
  it('refuses a URL it cannot read', () => {
    const config = { ...configFor(), REDIS_URL: 'redis://[oops' };

    expect(() => {
      assertRedisErasable(config, OPTED_IN);
    }).toThrow(/not the Redis of instance/);
  });

  /**
   * The refusal is printed and logged, and a connection URL can carry a password in its userinfo,
   * its query or its fragment. The message names the target without repeating any of them.
   */
  it('names the target without repeating its credentials', () => {
    const config = configFor({
      REDIS_URL: `redis://ah:${REDIS_PASSWORD}@cache.internal:3312?password=${REDIS_PASSWORD}#${REDIS_PASSWORD}`,
    });

    const refusal = ((): string => {
      try {
        assertRedisErasable(config, OPTED_IN);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('the guard accepted a Redis it should have refused');
    })();

    expect(refusal).not.toContain(REDIS_PASSWORD);
    expect(refusal).toContain('cache.internal:3312');
  });
});
