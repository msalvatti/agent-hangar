/**
 * Unit tests for {@link DockerRunnerError}.
 *
 * Layer: unit.
 * Goal: the runner's error carries the stable `DOCKER_RUNNER` code, stays inside the shared
 * `AgentHangarError` hierarchy so `isAgentHangarError` and the API error mapper recognise it, and
 * preserves the underlying daemon failure as `cause` without copying it into the message.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { AgentHangarError, isAgentHangarError } from '../../errors.ts';

import { DockerRunnerError } from './errors.ts';

describe('DockerRunnerError', () => {
  /**
   * The code is the branching key every caller uses; the message is passed through untouched so
   * the runner controls exactly which identifiers reach the caller.
   */
  it('exposes the DOCKER_RUNNER code and the given message', () => {
    const error = new DockerRunnerError('container name already exists: ah-ws-test-a');

    expect(error.code).toBe('DOCKER_RUNNER');
    expect(error.message).toBe('container name already exists: ah-ws-test-a');
    expect(error.name).toBe('DockerRunnerError');
  });

  /**
   * The API layer maps errors by `instanceof AgentHangarError`; a runner error that fell outside
   * the hierarchy would be reported to the client as an unknown internal failure.
   */
  it('is part of the AgentHangarError hierarchy', () => {
    const error = new DockerRunnerError('daemon unreachable');

    expect(error).toBeInstanceOf(AgentHangarError);
    expect(isAgentHangarError(error)).toBe(true);
  });

  /**
   * The daemon error is kept as `cause` for diagnostics; omitting the options object must not
   * invent a cause, because `undefined` and "no cause at all" are distinguishable on `Error`.
   */
  it('preserves the cause when given and leaves it unset otherwise', () => {
    const cause = new Error('socket hang up');

    expect(new DockerRunnerError('cannot inspect image x', { cause }).cause).toBe(cause);
    expect('cause' in new DockerRunnerError('cannot inspect image x')).toBe(false);
  });
});
