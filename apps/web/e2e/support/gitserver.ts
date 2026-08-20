/**
 * Lifecycle of the local git server container the end-to-end suite clones from.
 *
 * Layer: test support (spawns processes).
 *
 * The container is named after the instance and reused when it is already running from the image
 * this run built, so a developer can keep it up between runs with `E2E_KEEP_STACK=1` and a crashed
 * run cannot leave a second one behind. The URL handed back names the host a workspace container
 * must dial, which is neither the address the port is published on nor the loopback address the
 * health poll uses.
 *
 * The server accepts anonymous pushes, so its port is published on one address — loopback, or the
 * bridge gateway where a container cannot reach loopback — and never on every interface.
 */
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
  /** Host address the container's port is published on. */
  bindAddress: string;
  /** Image to run; rebuilt from `infra/test/gitserver` before every run. */
  image?: string;
  /** Directory holding `infra/test/gitserver`, for the build. */
  repoRoot: string;
}

/** Container name of one instance's git server. */
function gitServerContainerName(instance: string): string {
  return `ah-e2e-gitserver-${instance}`;
}

/**
 * Whether a running container may be reused.
 *
 * The fixture's sources — `server.mjs`, `seed.sh`, the Dockerfile — are edited like any other code
 * in this suite, and a container started before such an edit serves the old ones. Reuse is
 * therefore a statement about which image the container came from, never about the tag it was
 * started under: the tag is moved by a rebuild, and a container keeps the image it was created
 * from.
 *
 * @param runningImageId - Image id the container was created from, or `undefined` when none runs.
 * @param builtImageId - Image id this run just built.
 * @returns `true` only when a container is running from exactly that image.
 */
export function canReuseContainer(
  runningImageId: string | undefined,
  builtImageId: string,
): boolean {
  return runningImageId !== undefined && runningImageId === builtImageId;
}

/**
 * Image id a running container was created from.
 *
 * A container that exits between the two questions is removed by `--rm`, and the inspection then
 * fails. Reporting "none" for that is safe, because not knowing leads to building a fresh
 * container. The worker's process inspection makes the opposite call for the opposite reason:
 * there, not knowing would lead to signalling a process group nobody identified.
 *
 * @param containerName - Name of the container.
 * @returns The image id, or `undefined` when no container of that name runs or it cannot be read.
 */
async function runningContainerImageId(containerName: string): Promise<string | undefined> {
  if (!(await isRunning(containerName))) {
    return undefined;
  }
  try {
    const { stdout } = await exec('docker', ['inspect', '--format', '{{.Image}}', containerName]);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Image id of a tag, as Docker resolves it now.
 *
 * @param image - Tag to resolve.
 * @returns The image id.
 */
async function imageId(image: string): Promise<string> {
  const { stdout } = await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
  return stdout.trim();
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

async function isHealthy(address: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${address}:${String(port)}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Starts the git server, rebuilding its image first.
 *
 * The image is rebuilt on every run rather than only when the tag is missing. Building when absent
 * makes the tag, not the fixture's sources, decide what the suite clones from: an edit to
 * `server.mjs`, `seed.sh` or the Dockerfile leaves the old image in place and the run passes
 * against the previous checkout's fixture. Docker's layer cache makes an unchanged rebuild a
 * no-op, so correctness here costs nothing worth keeping.
 *
 * A container already running from a different image is replaced for the same reason.
 *
 * @param options - Port, instance, workspace-facing host and repository root.
 * @returns A handle naming the URL and the container.
 * @throws Error when the container never answers `/healthz`.
 */
export async function startGitServer(options: StartGitServerOptions): Promise<GitServerHandle> {
  const image = options.image ?? GITSERVER_IMAGE;
  const containerName = gitServerContainerName(options.instance);
  await exec('docker', ['build', '-t', image, 'infra/test/gitserver'], { cwd: options.repoRoot });
  const built = await imageId(image);
  const running = await runningContainerImageId(containerName);
  if (!canReuseContainer(running, built)) {
    if (running !== undefined) {
      await succeeds('docker', ['stop', containerName]);
    }
    await exec('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--publish',
      `${options.bindAddress}:${String(options.port)}:${String(CONTAINER_PORT)}`,
      image,
    ]);
  }
  await waitUntil(async () => isHealthy(options.bindAddress, options.port), {
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
