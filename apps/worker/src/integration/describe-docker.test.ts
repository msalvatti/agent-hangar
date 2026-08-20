/**
 * Unit tests for the Docker suite gate.
 *
 * Layer: unit.
 * Goal: the suite runs only with the opt-in and both connection URLs, skips locally with an
 * instruction naming exactly what is missing, and refuses to skip in CI. `describeDocker` itself
 * is probed by pinning `process.env` around each registration, never by letting collection of
 * this file depend on the real one — see the `describe('describeDocker', ...)` block below.
 * Mocks: none (the decision logic is exercised with an injected environment).
 */
import { describe, expect, it } from 'vitest';

import {
  describeDocker,
  DOCKER_AVAILABLE_ENV,
  registerDockerSuite,
  shouldRunDockerSuite,
} from './describe-docker.js';

const READY = {
  [DOCKER_AVAILABLE_ENV]: '1',
  DATABASE_URL: 'postgresql://ah:ah@127.0.0.1:3311/agent_hangar_w2b_test',
  REDIS_URL: 'redis://127.0.0.1:3312',
};

describe('shouldRunDockerSuite', () => {
  /**
   * With the opt-in and both URLs the suite runs, and there is nothing to print.
   */
  it('runs with the opt-in and both connection URLs', () => {
    expect(shouldRunDockerSuite(READY)).toEqual({ run: true, reason: '' });
  });

  /**
   * Locally the skip is visible and names precisely what to set, so a developer does not have to
   * read the source to run the suite.
   */
  it('skips locally, naming everything that is missing', () => {
    const decision = shouldRunDockerSuite({});

    expect(decision.run).toBe(false);
    expect(decision.reason).toContain('DOCKER_AVAILABLE=1');
    expect(decision.reason).toContain('DATABASE_URL');
    expect(decision.reason).toContain('REDIS_URL');
    expect(decision.reason).toContain('pnpm infra:image');
  });

  /**
   * An empty URL is as missing as an absent one; a shell that exported it blank must not produce a
   * suite that connects to nothing.
   */
  it('treats an empty URL as missing', () => {
    const decision = shouldRunDockerSuite({ ...READY, REDIS_URL: '' });

    expect(decision.run).toBe(false);
    expect(decision.reason).toContain('REDIS_URL');
    expect(decision.reason).not.toContain('DATABASE_URL');
  });

  /**
   * In CI the suite is the only proof the container hardening works against a real daemon, so it
   * must fail rather than skip.
   */
  it('refuses to skip in CI', () => {
    expect(() => shouldRunDockerSuite({ CI: 'true' })).toThrow(/@docker suite cannot run/);
    expect(() => shouldRunDockerSuite({ ...READY, CI: 'true' })).not.toThrow();
  });

  /**
   * An empty `CI` is not CI: a shell that exported it blank still gets the local skip.
   */
  it('treats an empty CI as not CI', () => {
    expect(shouldRunDockerSuite({ CI: '' }).run).toBe(false);
  });
});

registerDockerSuite({ run: true, reason: '' }, 'gate, declared runnable', () => {
  /**
   * A suite the gate declared runnable executes its body; that is the whole of the contract, and
   * the half a silently-broken gate would break.
   */
  it('executes its body', () => {
    expect(shouldRunDockerSuite(READY).run).toBe(true);
  });
});

registerDockerSuite({ run: false, reason: 'no daemon here' }, 'gate, declared unrunnable', () => {
  /**
   * A suite the gate declared unrunnable must never execute its body, however green the run looks.
   */
  it('never executes its body', () => {
    expect.unreachable('a skipped suite must not run');
  });
});

describe('describeDocker', () => {
  // `describeDocker` reads `process.env` itself (it calls `shouldRunDockerSuite()` with no
  // argument), so it cannot be probed by calling it once and reading a single outcome — that
  // outcome would depend on whichever shell happens to collect this file, and in CI that shell
  // has neither the opt-in nor the resources and does have `CI` set, which is exactly the
  // condition `shouldRunDockerSuite` is required to throw on. The probes below pin
  // `process.env` to a known shape around each registration instead, the same way
  // `describeDb` is probed in `packages/core/src/persistence/testing/db.test.ts`. `describe`
  // bodies run synchronously at collection time, so mutating `process.env` immediately before
  // each `describeDocker` call and restoring it immediately after is enough to make both
  // branches deterministic. `CI` is cleared for both probes: the throwing branch is already
  // covered above by calling `shouldRunDockerSuite` directly with an explicit environment,
  // never by letting collection itself depend on the real one.
  const savedDockerAvailable = process.env[DOCKER_AVAILABLE_ENV];
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const savedRedisUrl = process.env.REDIS_URL;
  const savedCi = process.env.CI;

  process.env[DOCKER_AVAILABLE_ENV] = READY[DOCKER_AVAILABLE_ENV];
  process.env.DATABASE_URL = READY.DATABASE_URL;
  process.env.REDIS_URL = READY.REDIS_URL;
  Reflect.deleteProperty(process.env, 'CI');
  let ranWhenReady = false;
  describeDocker('probe suite (environment ready)', () => {
    /**
     * With every required variable present the wrapper registers a real suite, and its body
     * executes.
     */
    it('executes its body', () => {
      ranWhenReady = true;
      expect(true).toBe(true);
    });
  });

  Reflect.deleteProperty(process.env, DOCKER_AVAILABLE_ENV);
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  Reflect.deleteProperty(process.env, 'CI');
  describeDocker('probe suite (environment not ready)', () => {
    /**
     * With nothing set and no `CI`, the wrapper skips locally instead of throwing; a skipped
     * suite must never execute its body, however green the run looks.
     */
    it('never executes its body', () => {
      expect.unreachable('a skipped @docker suite must not run');
    });
  });

  if (savedDockerAvailable === undefined) {
    Reflect.deleteProperty(process.env, DOCKER_AVAILABLE_ENV);
  } else {
    process.env[DOCKER_AVAILABLE_ENV] = savedDockerAvailable;
  }
  if (savedDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = savedDatabaseUrl;
  }
  if (savedRedisUrl === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = savedRedisUrl;
  }
  if (savedCi === undefined) {
    Reflect.deleteProperty(process.env, 'CI');
  } else {
    process.env.CI = savedCi;
  }

  /**
   * The non-skipped probe above actually executed its `it`, proving the wrapper reads
   * `process.env` for real rather than only forwarding a decision it was handed.
   */
  it('registers a suite that runs when the environment was ready at registration time', () => {
    expect(ranWhenReady).toBe(true);
  });
});
