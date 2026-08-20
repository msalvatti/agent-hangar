/**
 * The narrow slice of the Docker Engine API the workspace runner uses.
 *
 * Layer: service (port).
 *
 * Declared as a structural subset of dockerode's own types so the real client satisfies it with no
 * adapter, while unit tests drive the runner with an in-memory fake and never open a socket. Only
 * this folder may import dockerode at all (ESLint `no-restricted-imports`), and only the factory in
 * `index.ts` constructs the real client.
 */
import type Dockerode from 'dockerode';

/** The hijacked duplex returned by `exec.start`: writable stdin, readable multiplexed output. */
export interface DockerExecStream extends AsyncIterable<Uint8Array> {
  /** Writes a chunk to the process's stdin. */
  write(chunk: Uint8Array): boolean;
  /** Registers a one-shot listener, used to await `'drain'`. */
  once(event: 'drain', listener: () => void): unknown;
  /** Half-closes stdin so the process sees EOF. */
  end(): unknown;
  /** Ends the iteration early after a timeout or an abort. */
  destroy(error?: Error): unknown;
}

/** Options accepted by `exec.start`; `stdin` is false for the runner's internal captures. */
export interface DockerExecStartOptions {
  /** Take over the HTTP connection so the raw stream is available. */
  hijack: true;
  /** Attach the writable half. */
  stdin: boolean;
}

/** A created exec instance. */
export interface DockerExecApi {
  /**
   * Starts the exec and returns its hijacked stream.
   *
   * @param opts - Hijack and stdin flags.
   * @returns The duplex carrying stdin and the multiplexed output.
   */
  start(opts: DockerExecStartOptions): Promise<DockerExecStream>;
  /**
   * Reads the exec's status.
   *
   * @returns Exit code (null while running) and whether the process is still running.
   */
  inspect(): Promise<{ ExitCode: number | null; Running: boolean }>;
}

/** Options accepted by `container.exec`. */
export interface DockerExecCreateOptions {
  /** Argument vector to run. */
  Cmd: string[];
  /** Attach the writable half of the stream. */
  AttachStdin: boolean;
  /** Attach stdout. */
  AttachStdout: boolean;
  /** Attach stderr. */
  AttachStderr: boolean;
  /** Always false: a TTY would merge stdout and stderr into one stream. */
  Tty: boolean;
  /** Working directory for the process. */
  WorkingDir?: string | undefined;
  /** Extra environment for this process only, as `KEY=VALUE`. */
  Env?: string[] | undefined;
  /** User to run as; always the image's unprivileged `agent`. */
  User?: string | undefined;
}

/** Container state as reported by `inspect`. */
export interface DockerContainerState {
  /** Docker's status word (`running`, `exited`, `created`, ...). */
  Status: string;
  /** Whether the main process is alive. */
  Running: boolean;
  /** RFC 3339 timestamp of the last start. */
  StartedAt: string;
  /** Whether the kernel OOM killer stopped the container. */
  OOMKilled?: boolean | undefined;
  /** Exit code of the main process once it stopped. */
  ExitCode?: number | undefined;
}

/** The container operations the runner performs. */
export interface DockerContainerApi {
  /** Container id assigned by the daemon. */
  id: string;
  /**
   * Starts the container.
   *
   * @returns Resolves once the daemon accepted the request.
   */
  start(): Promise<unknown>;
  /**
   * Stops the container with a grace period.
   *
   * @param opts - `t` is the grace period in seconds.
   * @returns Resolves once the container stopped; rejects with 304 when already stopped.
   */
  stop(opts: { t: number }): Promise<unknown>;
  /**
   * Removes the container.
   *
   * @param opts - `v` also removes anonymous volumes; `force` removes a running container.
   * @returns Resolves once the container is gone.
   */
  remove(opts: { v: boolean; force: boolean }): Promise<unknown>;
  /**
   * Kills the container's main process.
   *
   * @returns Resolves once the daemon accepted the request.
   */
  kill(): Promise<unknown>;
  /**
   * Reads the container's state.
   *
   * @returns Identity, state and labels; rejects with 404 when the container is gone.
   */
  inspect(): Promise<{
    Id: string;
    State: DockerContainerState;
    Config: { Labels: Record<string, string> };
  }>;
  /**
   * Creates an exec instance inside the container.
   *
   * @param opts - Command, attachment flags and process environment.
   * @returns The created exec, not yet started.
   */
  exec(opts: DockerExecCreateOptions): Promise<DockerExecApi>;
  /**
   * Extracts a tar archive into a directory of the container's filesystem.
   *
   * The daemon does this as root and honours the ownership in each tar header, which is how a file
   * the container's own user cannot replace gets there in the first place. Usable before the
   * container has ever been started.
   *
   * @param file - The tar archive.
   * @param options - `path` is the directory the archive is extracted into; it must exist.
   * @returns Resolves once the daemon has extracted the archive.
   */
  putArchive(file: Buffer, options: { path: string }): Promise<unknown>;
}

/** The daemon-level operations the runner performs. */
export interface DockerApi {
  /**
   * References an image by name.
   *
   * @param name - Image reference (tag or digest).
   * @returns A handle whose `inspect` rejects with 404 when the image is absent.
   */
  getImage(name: string): { inspect(): Promise<unknown> };
  /**
   * Creates a container.
   *
   * @param opts - Full create options, as produced by `buildContainerCreateOptions`.
   * @returns The created container; rejects with 409 when the name is taken.
   */
  createContainer(opts: Dockerode.ContainerCreateOptions): Promise<DockerContainerApi>;
  /**
   * References an existing container by id.
   *
   * @param id - Container id.
   * @returns A handle; its methods reject with 404 when the container is gone.
   */
  getContainer(id: string): DockerContainerApi;
  /**
   * Lists containers matching a label selector.
   *
   * @param opts - `all` includes stopped containers; `filters.label` holds `key=value` selectors.
   * @returns One entry per matching container.
   */
  listContainers(opts: {
    all: boolean;
    filters: { label: string[] };
  }): Promise<{ Id: string; Labels: Record<string, string> }[]>;
}

/** HTTP status the daemon returns when a container, image or exec does not exist. */
const STATUS_NOT_FOUND = 404;

/** HTTP status the daemon returns when a stop/start is already satisfied. */
const STATUS_NOT_MODIFIED = 304;

/** HTTP status the daemon returns when a name is taken or a state forbids the operation. */
const STATUS_CONFLICT = 409;

/**
 * Reads the HTTP status off a daemon rejection.
 *
 * dockerode attaches `statusCode` to its errors but types them as `unknown` at the call site, so
 * the value is narrowed defensively rather than cast.
 *
 * @param err - Anything caught from a daemon call.
 * @returns The status code, or `undefined` when the value is not a daemon error.
 */
function statusCodeOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('statusCode' in err)) {
    return undefined;
  }
  const { statusCode } = err;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

/**
 * Tells whether a daemon rejection means "does not exist".
 *
 * @param err - Anything caught from a daemon call.
 * @returns `true` for HTTP 404.
 */
export function isDockerNotFound(err: unknown): boolean {
  return statusCodeOf(err) === STATUS_NOT_FOUND;
}

/**
 * Tells whether a daemon rejection means "already in the requested state".
 *
 * @param err - Anything caught from a daemon call.
 * @returns `true` for HTTP 304.
 */
export function isDockerNotModified(err: unknown): boolean {
  return statusCodeOf(err) === STATUS_NOT_MODIFIED;
}

/**
 * Tells whether a daemon rejection means "conflicts with existing state".
 *
 * @param err - Anything caught from a daemon call.
 * @returns `true` for HTTP 409.
 */
export function isDockerConflict(err: unknown): boolean {
  return statusCodeOf(err) === STATUS_CONFLICT;
}
