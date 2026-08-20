/**
 * Unit tests for the worker-local environment schema.
 *
 * Layer: unit.
 * Goal: `docker` is the default, `fake` is accepted, anything else fails at boot with a message
 * naming the variable.
 * Mocks: none (the environment is passed explicitly).
 */
import { ConfigError } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { parseWorkerEnv, WORKSPACE_RUNNERS } from './env.js';

describe('parseWorkerEnv', () => {
  /**
   * An environment that names no runner gets the Docker one: falling back to the fake runner
   * would make a misconfigured worker accept turns and produce output that executes nothing.
   */
  it('defaults to the docker runner', () => {
    expect(parseWorkerEnv({}).WORKSPACE_RUNNER).toBe('docker');
  });

  /**
   * The fake runner is selectable, which is how the UI and the harness run without Docker.
   */
  it('accepts the fake runner', () => {
    expect(parseWorkerEnv({ WORKSPACE_RUNNER: 'fake' }).WORKSPACE_RUNNER).toBe('fake');
  });

  /**
   * A typo fails at boot rather than at the first job, and the message names the variable so the
   * fix does not need a source dive.
   */
  it('rejects an unknown runner, naming the variable', () => {
    expect(() => parseWorkerEnv({ WORKSPACE_RUNNER: 'podman' })).toThrow(ConfigError);
    expect(() => parseWorkerEnv({ WORKSPACE_RUNNER: 'podman' })).toThrow(/WORKSPACE_RUNNER/);
  });

  /**
   * The exported list is what the container switches on; a runner added to one without the other
   * would compile and then fail at run time.
   */
  it('exposes exactly the runners the container can build', () => {
    expect(WORKSPACE_RUNNERS).toEqual(['docker', 'fake']);
  });
});
