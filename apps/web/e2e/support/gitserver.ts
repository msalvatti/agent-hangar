/**
 * Lifecycle of the local git server container the end-to-end suite clones from.
 *
 * Layer: test support (spawns processes).
 *
 * The container is named after the instance and reused when it is already running, so a developer
 * can keep it up between runs with `E2E_KEEP_STACK=1` and a crashed run cannot leave a second one
 * behind. The health poll always dials loopback; the URL handed back names the host a workspace
 * container must dial, which is a different address.
 */
import { LOOPBACK } from './env';
import { exec, succeeds, waitUntil } from './process';

/** Image tag built from `infra/test/gitserver`. */
export const GITSERVER_IMAGE = 'agent-hangar/gitserver:test';

/** Port the server listens on inside its container. */
const CONTAINER_PORT = 8080;

/** Budget for the container to answer `/healthz`. */
const READY_TIMEOUT_MS = 60_000;

/** Interval between health probes. */
const READY_INTERVAL_MS = 500;

/** A running git server. */
export interface GitServerHandle {
  /** Base URL a workspace container dials. */
  url: string;
  /** Name of the container, for teardown. */
  containerName: string;
}

/** Options of {@link startGitServer}. */
export interface StartGitServerOptions {
  /** Host port the container is published on. */
  port: number;
  /** Instance slug, so two checkouts get separate containers. */
  instance: string;
  /** Host a workspace container reaches the server by. */
  host: string;
  /** Image to run; built from `infra/test/gitserver` when absent locally. */
  image?: string;
  /** Directory holding `infra/test/gitserver`, for the build. */
  repoRoot: string;
}

/** Container name of one instance's git server. */
export function gitServerContainerName(instance: string): string {
  return `ah-e2e-gitserver-${instance}`;
}

async function isRunning(containerName: string): Promise<boolean> {
  const { stdout } = await exec('docker', [
    'ps',
    '--filter',
    `name=^${containerName}$`,
    '--format',
    '{{.Names}}',
  ]);
  return stdout.trim() === containerName;
}

async function isHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${LOOPBACK}:${String(port)}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Starts the git server, building its image first when it is missing.
 *
 * @param options - Port, instance, workspace-facing host and repository root.
 * @returns A handle naming the URL and the container.
 * @throws Error when the container never answers `/healthz`.
 */
export async function startGitServer(options: StartGitServerOptions): Promise<GitServerHandle> {
  const image = options.image ?? GITSERVER_IMAGE;
  const containerName = gitServerContainerName(options.instance);
  if (!(await succeeds('docker', ['image', 'inspect', image]))) {
    await exec('docker', ['build', '-t', image, 'infra/test/gitserver'], { cwd: options.repoRoot });
  }
  if (!(await isRunning(containerName))) {
    await exec('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--publish',
      `0.0.0.0:${String(options.port)}:${String(CONTAINER_PORT)}`,
      image,
    ]);
  }
  await waitUntil(async () => isHealthy(options.port), {
    timeoutMs: READY_TIMEOUT_MS,
    intervalMs: READY_INTERVAL_MS,
    description: `the git server to answer /healthz on port ${String(options.port)}`,
  });
  return { url: `http://${options.host}:${String(options.port)}`, containerName };
}

/**
 * Stops the git server, tolerating a container that is already gone.
 *
 * @param handle - Handle returned by {@link startGitServer}.
 */
export async function stopGitServer(handle: GitServerHandle): Promise<void> {
  await succeeds('docker', ['stop', handle.containerName]);
}
