/**
 * Unit tests for the Docker suite gate.
 *
 * Layer: unit.
 * Goal: the suite runs only with the opt-in and both connection URLs, skips locally with an
 * instruction naming exactly what is missing, and refuses to skip in CI.
 * Mocks: none (the environment is passed explicitly).
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

describeDocker('gate, deciding from the environment', () => {
  /**
   * The environment-reading wrapper registers a suite either way; which way depends on the shell
   * this file is collected in, and both are correct.
   */
  it('registers a suite from the environment', () => {
    expect(shouldRunDockerSuite().run).toBe(true);
  });
});
