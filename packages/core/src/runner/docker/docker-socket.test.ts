/**
 * Unit tests for {@link resolveDockerSocket}.
 *
 * Layer: unit.
 * Goal: the documented resolution order (`DOCKER_HOST` → user socket → system socket) holds, each
 * branch reports the source that produced it, and every configuration this runner cannot honour
 * (TLS, unknown scheme, portless or malformed authority) fails with a typed error instead of
 * connecting somewhere unintended.
 * Mocks: the `env`, `homedir` and `exists` probes are injected; no filesystem or daemon is touched.
 */
import { describe, expect, it } from 'vitest';

import { resolveDockerSocket } from './docker-socket.js';
import { DockerRunnerError } from './errors.js';

/** Home directory used by every case that reaches the user-socket probe. */
const HOME = '/Users/tester';

/** Path the user-socket probe is expected to receive for {@link HOME}. */
const USER_SOCKET = `${HOME}/.docker/run/docker.sock`;

describe('resolveDockerSocket', () => {
  /**
   * An explicit unix `DOCKER_HOST` wins over both socket candidates and is passed through as a
   * plain path: dockerode takes `socketPath`, not a URL.
   */
  it('honours a unix:// DOCKER_HOST', () => {
    const resolution = resolveDockerSocket({
      env: { DOCKER_HOST: 'unix:///tmp/docker.sock' },
      homedir: () => HOME,
      exists: () => true,
    });

    expect(resolution).toEqual({
      options: { socketPath: '/tmp/docker.sock' },
      source: 'DOCKER_HOST',
    });
  });

  /**
   * A remote daemon is addressed by host and numeric port over plain http; the port must survive
   * as a number because dockerode passes it straight to the http agent.
   */
  it('parses a tcp:// DOCKER_HOST into host, numeric port and http protocol', () => {
    const resolution = resolveDockerSocket({
      env: { DOCKER_HOST: 'tcp://docker.internal:2375' },
      homedir: () => HOME,
      exists: () => false,
    });

    expect(resolution).toEqual({
      options: { host: 'docker.internal', port: 2375, protocol: 'http' },
      source: 'DOCKER_HOST',
    });
  });

  /**
   * Security boundary: a TLS-protected daemon needs a CA, certificate and key this runner does not
   * manage. Connecting in plaintext anyway would silently downgrade the transport, so the whole
   * resolution must fail instead.
   */
  it('rejects DOCKER_TLS_VERIFY=1', () => {
    expect(() =>
      resolveDockerSocket({
        env: { DOCKER_HOST: 'tcp://docker.internal:2376', DOCKER_TLS_VERIFY: '1' },
        homedir: () => HOME,
        exists: () => false,
      }),
    ).toThrow(DockerRunnerError);
  });

  /**
   * Values the runner cannot map to an endpoint must fail loudly and echo the offending value:
   * a wrong scheme, a `tcp://` authority without a port (2375 and 2376 mean different transports,
   * so guessing one is unsafe), a non-numeric or out-of-range port, and an empty unix path.
   */
  it.each([
    ['unknown scheme', 'ssh://build-host'],
    ['portless tcp authority', 'tcp://docker.internal'],
    ['non-numeric tcp port', 'tcp://docker.internal:http'],
    ['out-of-range tcp port', 'tcp://docker.internal:70000'],
    ['tcp port without a host', 'tcp://:2375'],
    ['empty unix path', 'unix://'],
    ['bare path', '/var/run/docker.sock'],
  ])('throws a typed error for a DOCKER_HOST with a %s', (_case, value) => {
    expect(() =>
      resolveDockerSocket({
        env: { DOCKER_HOST: value },
        homedir: () => HOME,
        exists: () => false,
      }),
    ).toThrow(DockerRunnerError);
  });

  /**
   * An exported-but-empty `DOCKER_HOST` is how shells leave a cleared variable; treating it as an
   * endpoint would fail every call, so it must fall through to the socket candidates.
   */
  it('falls through when DOCKER_HOST is set but empty', () => {
    const resolution = resolveDockerSocket({
      env: { DOCKER_HOST: '' },
      homedir: () => HOME,
      exists: () => true,
    });

    expect(resolution.source).toBe('user-socket');
  });

  /**
   * Docker Desktop, OrbStack and Colima publish the socket under the user's home directory; it is
   * preferred over the system socket and probed at exactly that path.
   */
  it('prefers the per-user socket when it exists', () => {
    const probed: string[] = [];
    const resolution = resolveDockerSocket({
      env: {},
      homedir: () => HOME,
      exists: (path) => {
        probed.push(path);
        return true;
      },
    });

    expect(probed).toEqual([USER_SOCKET]);
    expect(resolution).toEqual({ options: { socketPath: USER_SOCKET }, source: 'user-socket' });
  });

  /**
   * With no user socket the system path is returned unprobed: the first daemon call already fails
   * with a precise "cannot connect" message, which is more useful than a second existence check.
   */
  it('falls back to the system socket', () => {
    const resolution = resolveDockerSocket({
      env: {},
      homedir: () => HOME,
      exists: () => false,
    });

    expect(resolution).toEqual({
      options: { socketPath: '/var/run/docker.sock' },
      source: 'system-socket',
    });
  });

  /**
   * Called with no dependencies at all the function must still work off the real `process.env`,
   * `os.homedir` and `fs.existsSync`. Only the shape is asserted — the result legitimately differs
   * between machines and CI.
   */
  it('uses the real environment and filesystem when no dependencies are given', () => {
    const resolution = resolveDockerSocket();

    expect(['DOCKER_HOST', 'user-socket', 'system-socket']).toContain(resolution.source);
    expect(typeof resolution.options).toBe('object');
  });
});
