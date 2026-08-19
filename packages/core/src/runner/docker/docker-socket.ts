/**
 * Resolution of the Docker daemon endpoint.
 *
 * Layer: service (adapter).
 *
 * The runner never guesses: it follows one documented order — `DOCKER_HOST`, then the per-user
 * Docker Desktop socket, then the system socket — and reports which source won so `pnpm doctor`
 * can print it. Pure except for the two injectable probes (`homedir`, `exists`), so the whole
 * order is unit-tested without a daemon.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type Dockerode from 'dockerode';

import { DockerRunnerError } from './errors.js';

/** Constructor options for the dockerode client, as produced by {@link resolveDockerSocket}. */
export type DockerodeOptions = Dockerode.DockerOptions;

/** Which of the three candidate endpoints was selected. */
export type DockerSocketSource = 'DOCKER_HOST' | 'user-socket' | 'system-socket';

/** The endpoint the runner will connect to, plus the reason it was chosen. */
export interface DockerSocketResolution {
  /** Options to pass to the dockerode constructor. */
  options: DockerodeOptions;
  /** Where the endpoint came from; surfaced by diagnostics, never by an error message. */
  source: DockerSocketSource;
}

/** Injectable probes so the resolution order can be exercised without touching the host. */
export interface ResolveDockerSocketDeps {
  /** Environment to read `DOCKER_HOST` / `DOCKER_TLS_VERIFY` from; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Home directory lookup; defaults to `os.homedir`. */
  homedir?: (() => string) | undefined;
  /** Existence probe for the user socket; defaults to `fs.existsSync`. */
  exists?: ((path: string) => boolean) | undefined;
}

/** `DOCKER_HOST` scheme for a local unix socket. */
const UNIX_SCHEME = 'unix://';

/** `DOCKER_HOST` scheme for a plaintext TCP daemon. */
const TCP_SCHEME = 'tcp://';

/** Docker Desktop / Colima per-user socket, relative to the home directory. */
const USER_SOCKET_RELATIVE_PATH = '.docker/run/docker.sock';

/** Socket published by a system-wide daemon installation. */
const SYSTEM_SOCKET_PATH = '/var/run/docker.sock';

/**
 * Builds the dockerode options for a `tcp://` endpoint.
 *
 * The port must be explicit. Docker listens on 2375 without TLS and 2376 with it; picking a
 * default here would silently send traffic to the wrong daemon, so an authority without a port is
 * rejected instead.
 *
 * @param value - The raw `DOCKER_HOST` value, used verbatim in the error message.
 * @returns Host, port and plaintext protocol for the dockerode constructor.
 * @throws DockerRunnerError when the authority is missing, malformed or has no port.
 */
function parseTcpDockerHost(value: string): DockerodeOptions {
  const authority = value.slice(TCP_SCHEME.length);
  const separator = authority.lastIndexOf(':');
  const host = authority.slice(0, separator);
  const port = Number(authority.slice(separator + 1));

  if (separator <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new DockerRunnerError(`unsupported DOCKER_HOST "${value}"`);
  }

  return { host, port, protocol: 'http' };
}

/**
 * Builds the dockerode options for an explicit `DOCKER_HOST`.
 *
 * @param value - Non-empty `DOCKER_HOST` value.
 * @returns Options for the dockerode constructor.
 * @throws DockerRunnerError for an unsupported scheme or an unparsable value.
 */
function parseDockerHost(value: string): DockerodeOptions {
  if (value.startsWith(UNIX_SCHEME)) {
    const socketPath = value.slice(UNIX_SCHEME.length);
    if (socketPath.length === 0) {
      throw new DockerRunnerError(`unsupported DOCKER_HOST "${value}"`);
    }
    return { socketPath };
  }

  if (value.startsWith(TCP_SCHEME)) {
    return parseTcpDockerHost(value);
  }

  throw new DockerRunnerError(`unsupported DOCKER_HOST "${value}"`);
}

/**
 * Resolves where the Docker daemon lives.
 *
 * Order: an explicit `DOCKER_HOST`, then `~/.docker/run/docker.sock` (Docker Desktop, OrbStack and
 * Colima publish the socket per user), then `/var/run/docker.sock`. The system socket is returned
 * without an existence check: the first daemon call fails with a clear error anyway, and probing
 * would only turn a precise "cannot connect" into a vaguer one.
 *
 * @param deps - Optional probes; the defaults read the real environment and filesystem.
 * @returns The selected endpoint and the source that produced it.
 * @throws DockerRunnerError when `DOCKER_HOST` is unsupported or requires TLS.
 */
export function resolveDockerSocket(deps: ResolveDockerSocketDeps = {}): DockerSocketResolution {
  const env = deps.env ?? process.env;
  const dockerHost = env.DOCKER_HOST;

  if (dockerHost !== undefined && dockerHost.length > 0) {
    // A TLS daemon needs a CA, a client certificate and a key that this runner does not manage;
    // connecting in plaintext instead would be a silent downgrade, so refuse loudly.
    if (env.DOCKER_TLS_VERIFY === '1') {
      throw new DockerRunnerError(
        'DOCKER_TLS_VERIFY is not supported by this runner; use a unix socket or plain tcp',
      );
    }
    return { options: parseDockerHost(dockerHost), source: 'DOCKER_HOST' };
  }

  const userSocketPath = join((deps.homedir ?? homedir)(), USER_SOCKET_RELATIVE_PATH);
  if ((deps.exists ?? existsSync)(userSocketPath)) {
    return { options: { socketPath: userSocketPath }, source: 'user-socket' };
  }

  return { options: { socketPath: SYSTEM_SOCKET_PATH }, source: 'system-socket' };
}
