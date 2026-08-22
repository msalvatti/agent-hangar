/**
 * Unit tests for the worker-local environment schema.
 *
 * Layer: unit.
 * Goal: `docker` is the default, `fake` is accepted, anything else fails at boot with a message
 * naming the variable; and the scripted provider's script path is read when it is set, absent
 * when it is not, and refused when it is blank.
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
   * More than one variable can be wrong at once, and the message is what the operator reads at a
   * terminal. Each problem is a line of its own naming the variable and what is wrong with it, so
   * a boot that failed for three reasons does not report one of them, and a list run together on
   * a single line is not something anyone reads twice.
   */
  it('lists every problem, one indented line each, naming the variable', () => {
    const failure = ((): Error => {
      try {
        parseWorkerEnv({ WORKSPACE_RUNNER: 'podman', FAKE_PROVIDER_SCRIPT_PATH: '' });
        throw new Error('the environment was accepted');
      } catch (error) {
        return error as Error;
      }
    })();

    const [headline, ...problems] = failure.message.split('\n');
    expect(headline).toBe('Invalid worker environment:');
    expect(problems).toHaveLength(2);
    for (const problem of problems) {
      expect(problem).toMatch(/^ {2}- (FAKE_PROVIDER_SCRIPT_PATH|WORKSPACE_RUNNER): \S/);
    }
  });

  /**
   * The path of a supplied scripted-provider script is worker-local: the web app can do nothing
   * with it, and only the worker builds a container environment.
   */
  it('reads the scripted-provider script path', () => {
    const env = parseWorkerEnv({ FAKE_PROVIDER_SCRIPT_PATH: '/scripts/script.json' });

    expect(env.FAKE_PROVIDER_SCRIPT_PATH).toBe('/scripts/script.json');
  });

  /**
   * Almost every run supplies no script, which has to be the quiet case: absent means the runtime
   * keeps the script built into it.
   */
  it('leaves the script path absent when nothing sets it', () => {
    expect(parseWorkerEnv({}).FAKE_PROVIDER_SCRIPT_PATH).toBeUndefined();
  });

  /**
   * A blank value is a mistake, not a way of unsetting the variable: silently ignoring it would
   * run the built-in script while the operator believes their own is in force.
   */
  it('refuses a blank script path', () => {
    expect(() => parseWorkerEnv({ FAKE_PROVIDER_SCRIPT_PATH: '' })).toThrow(ConfigError);
    expect(() => parseWorkerEnv({ FAKE_PROVIDER_SCRIPT_PATH: '' })).toThrow(
      /FAKE_PROVIDER_SCRIPT_PATH/u,
    );
  });

  /**
   * The exported list is what the container switches on; a runner added to one without the other
   * would compile and then fail at run time.
   */
  it('exposes exactly the runners the container can build', () => {
    expect(WORKSPACE_RUNNERS).toEqual(['docker', 'fake']);
  });
});
