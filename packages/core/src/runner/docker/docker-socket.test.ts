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

import { resolveDockerSocket } from './docker-socket.ts';
import { DockerRunnerError } from './errors.ts';

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
  it.each(['1', 'true', 'yes', '0'])('rejects DOCKER_TLS_VERIFY=%s', (value) => {
    const resolve = (): unknown =>
      resolveDockerSocket({
        env: { DOCKER_HOST: 'tcp://docker.internal:2376', DOCKER_TLS_VERIFY: value },
        homedir: () => HOME,
        exists: () => false,
      });

    expect(resolve).toThrow(DockerRunnerError);
    // The message is the whole of the remedy: an operator who set this variable deliberately has
    // to be told which two transports this runner does speak.
    expect(resolve).toThrow(
      'DOCKER_TLS_VERIFY is not supported by this runner; use a unix socket or plain tcp',
    );
  });

  /**
   * Docker reads this variable as "any non-empty value enables verification", so matching only
   * `'1'` left `DOCKER_TLS_VERIFY=true` resolving to a plaintext `http` client. That is not a
   * cosmetic gap: the first request over that transport is `createContainer`, whose body carries
   * the workspace environment — the GitHub PAT and the OpenAI key — so the downgrade would put
   * them on the wire in clear. Empty and unset are the only values that mean "no TLS".
   */
  it.each(['', undefined])('resolves normally when DOCKER_TLS_VERIFY is %p', (value) => {
    const resolution = resolveDockerSocket({
      env: { DOCKER_HOST: 'tcp://docker.internal:2375', DOCKER_TLS_VERIFY: value },
      homedir: () => HOME,
      exists: () => false,
    });

    expect(resolution.source).toBe('DOCKER_HOST');
    expect(resolution.options).toEqual({ host: 'docker.internal', port: 2375, protocol: 'http' });
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
    // Zero is not a port, and a check that only refuses negatives lets it through to a connection
    // that can never be made.
    ['zero tcp port', 'tcp://docker.internal:0'],
    // A scheme this runner does not speak, written with a port: read as a tcp authority it parses
    // perfectly well, and the runner would then talk plain HTTP to an ssh endpoint.
    ['unknown scheme with a port', 'ssh://build-host:22'],
  ])('throws a typed error for a DOCKER_HOST with a %s', (_case, value) => {
    const resolve = (): unknown =>
      resolveDockerSocket({
        env: { DOCKER_HOST: value },
        homedir: () => HOME,
        exists: () => false,
      });

    expect(resolve).toThrow(DockerRunnerError);
    // Naming the value, because this is configuration and the operator has to see which spelling
    // of it was refused.
    expect(resolve).toThrow(`unsupported DOCKER_HOST "${value}"`);
  });

  /**
   * The highest port there is, accepted: the ceiling is the last usable number rather than the
   * first refused one, and a check written one short of it refuses a daemon an operator can
   * legitimately be running.
   */
  it('accepts the highest tcp port', () => {
    expect(
      resolveDockerSocket({
        env: { DOCKER_HOST: 'tcp://docker.internal:65535' },
        homedir: () => HOME,
        exists: () => false,
      }).options,
    ).toStrictEqual({ host: 'docker.internal', port: 65_535, protocol: 'http' });
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
