/**
 * Unit tests for the Docker runner factory.
 *
 * Layer: unit.
 * Goal: the single place that constructs a dockerode client passes it exactly the endpoint the
 * socket resolver selected, and returns a fully wired runner. This is the seam between the
 * unit-tested runner and the real daemon, so it is verified without opening a socket.
 * Mocks: the `dockerode` module.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../testing/fake-clock.ts';

import { DockerWorkspaceRunner } from './docker-workspace-runner.ts';
import { createDockerWorkspaceRunner } from './index.ts';

const { dockerodeConstructor } = vi.hoisted(() => ({ dockerodeConstructor: vi.fn() }));

vi.mock('dockerode', () => ({ default: dockerodeConstructor }));

beforeEach(() => {
  dockerodeConstructor.mockClear();
});

describe('createDockerWorkspaceRunner', () => {
  /**
   * The factory must hand dockerode the endpoint `resolveDockerSocket` chose — not a default and
   * not `process.env` read a second time — otherwise a configured `DOCKER_HOST` would be ignored.
   */
  it('constructs the client with the resolved endpoint', () => {
    const runner = createDockerWorkspaceRunner({
      instance: 'test',
      namePrefix: 'ah-ws-test-',
      env: { DOCKER_HOST: 'unix:///tmp/custom.sock' },
      clock: new FakeClock(),
    });

    expect(dockerodeConstructor).toHaveBeenCalledExactlyOnceWith({
      socketPath: '/tmp/custom.sock',
    });
    expect(runner).toBeInstanceOf(DockerWorkspaceRunner);
    expect(runner.kind).toBe('docker');
  });

  /**
   * Production calls the factory with neither an environment nor a clock; the defaults must
   * resolve the daemon from the real environment and still produce a usable runner.
   */
  it('falls back to the process environment and the system clock', () => {
    const runner = createDockerWorkspaceRunner({ instance: 'test', namePrefix: 'ah-ws-test-' });

    expect(dockerodeConstructor).toHaveBeenCalledOnce();
    expect(runner).toBeInstanceOf(DockerWorkspaceRunner);
  });
});
