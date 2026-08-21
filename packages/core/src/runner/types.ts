/**
 * `WorkspaceRunner` contract: the only abstraction that knows how to run an isolated workspace.
 *
 * Layer: service (port).
 *
 * One implementation ships (`DockerWorkspaceRunner`, under `runner/docker/`); a cloud runner is
 * a second implementation of this same interface. Nothing outside `runner/docker/` imports the
 * Docker SDK — an ESLint `no-restricted-imports` rule enforces it.
 */

/** Everything a runner needs to create a workspace. */
export interface WorkspaceSpec {
  /** Stable id from the Workspace row; used to name/label the container. */
  workspaceId: string;
  /** Whether the workspace backs a chat or a scheduled job run. */
  kind: 'CHAT' | 'JOB';
  /** Image reference (tag or digest). */
  image: string;
  /**
   * Environment injected at start, and therefore carried by every process of the container for
   * its whole life.
   *
   * No credential belongs here. `/proc/<pid>/environ` is readable by any process of the same user,
   * every process in a workspace runs as that one user, and the workspace runs shell commands a
   * language model chose — so a value placed here is a value the agent can read back at any time.
   * Credentials travel per execution instead, as {@link ExecSpec.files}.
   */
  env: Readonly<Record<string, string>>;
  /** Resource ceilings; the runner must enforce or reject. */
  limits: WorkspaceLimits;
  /** Labels for discovery/GC (instance name, chat id, job run id). */
  labels: Readonly<Record<string, string>>;
  /**
   * Content placed inside the workspace before it starts, owned by root.
   *
   * The environment is the wrong channel for anything the workspace must not be able to restate.
   * A container runs commands a language model chose after reading untrusted repository content,
   * and a command may set any variable it likes for the process it starts — so a policy the
   * workspace reads out of its own environment is a policy the workspace can rewrite. A file the
   * runner places before the first process runs, owned by a user the workspace is not, cannot be.
   *
   * This is for values that must outlive every process of the workspace: they are placed once and
   * stay. A credential is the opposite case and belongs in {@link ExecSpec.files}, which is placed
   * for one execution and removed by the process that reads it.
   */
  files?: readonly WorkspaceFile[];
}

/** One file placed into a workspace by the runner. */
export interface WorkspaceFile {
  /** Absolute path inside the container; its parent directory must already exist. */
  path: string;
  /** UTF-8 content written to that path. */
  content: string;
}

/** Resource ceilings applied to a workspace. */
export interface WorkspaceLimits {
  /** CPU quota, e.g. `2`. */
  cpus: number;
  /** Memory ceiling in bytes, e.g. 2 GiB. */
  memoryBytes: number;
  /** Maximum number of processes, e.g. `512`. */
  pids: number;
  /** Disk ceiling in bytes; advisory on Docker Desktop. */
  diskBytes?: number;
}

/** Opaque reference to a created workspace. */
export interface WorkspaceHandle {
  /** Stable id from the Workspace row. */
  workspaceId: string;
  /** Runner-specific reference (Docker container id, cloud task ARN, ...). Opaque to callers. */
  runnerRef: string;
}

/** A process to run inside a workspace. */
export interface ExecSpec {
  /** Command and arguments (no shell unless the command is a shell). */
  cmd: readonly string[];
  /** Working directory inside the workspace; defaults to the image workdir. */
  cwd?: string;
  /** Extra environment for this process only. Never a credential; see {@link ExecSpec.files}. */
  env?: Readonly<Record<string, string>>;
  /**
   * Content placed inside the workspace immediately before this process starts.
   *
   * This is the channel a credential travels on. The environment cannot be one — neither the
   * container's nor this process's — because `/proc/<pid>/environ` is readable by any process of
   * the same user and every process in a workspace is that same user, so an agent shell command
   * reads back whatever was injected. A file can be taken off the filesystem the moment it has
   * been read, which is what turns "for as long as the container lives" into "until the runtime
   * has started".
   *
   * The runner places these into a directory the workspace user owns, so the reader can unlink
   * them; it is the reader's job to do so, and to fail loudly rather than continue without what it
   * came for. They are written to the container's own storage, which its destruction removes, and
   * a runner that can offer memory instead should.
   */
  files?: readonly WorkspaceFile[];
  /** Data written to stdin, then stdin is closed. Used for the agent protocol. */
  stdin?: AsyncIterable<Uint8Array> | Uint8Array | string;
  /** Wall-clock limit; on expiry the runner kills the process and yields `exit` with `signal: 'TIMEOUT'`. */
  timeoutMs?: number;
  /** Aborting stops the exec and ends the event stream. */
  signal?: AbortSignal;
}

/** Signals that can be delivered to an exec. */
export type ExecSignal = 'INT' | 'TERM' | 'KILL';

/**
 * Events yielded by {@link WorkspaceRunner.exec}.
 *
 * The first event is always `started`; it carries the `execRef` used by
 * {@link WorkspaceRunner.signal}. The last event is always `exit`.
 */
export type ExecEvent =
  | { type: 'started'; execRef: string }
  | { type: 'stdout'; data: Uint8Array }
  | { type: 'stderr'; data: Uint8Array }
  | { type: 'exit'; code: number | null; signal?: string };

/** Git state captured from a workspace before it is destroyed (restore hints). */
export interface WorkspaceSnapshot {
  /** When the snapshot was taken. */
  takenAt: Date;
  /** Git state of `/workspace`; nulls when the directory is not a repository. */
  git: {
    branch: string | null;
    headSha: string | null;
    dirty: boolean;
    /** Commits not on `origin/<branch>`. */
    ahead: number;
    /** Commits on `origin/<branch>` not checked out. */
    behind: number;
  };
  /** Short `git status --porcelain` + `git diff --stat`, truncated to 16 KB. */
  summary: string;
}

/** Liveness of a workspace. */
export type WorkspaceHealth =
  | { status: 'healthy'; uptimeMs: number }
  | { status: 'unhealthy'; reason: string }
  | { status: 'gone' };

/** Runs isolated workspaces. Implementations must be safe to call concurrently. */
export interface WorkspaceRunner {
  /** Human-readable runner id stored on `Workspace.runnerKind` ("docker"). */
  readonly kind: string;

  /**
   * Reports whether an image is present and could be started, without starting anything.
   *
   * Nothing is ever pulled or built implicitly, so "the image is missing" is a state an operator
   * has to be told about — at boot and on the health card — rather than one a turn discovers by
   * failing. Answering it needs the runner: only it can reach the host the workspaces run on.
   *
   * @param image - Image reference (tag or digest), as it would appear in a {@link WorkspaceSpec}.
   * @returns `true` when the host has the image; `false` when it does not. Rejects only when the
   *   host could not be asked, which is a different failure and must not be reported as absence.
   */
  imageExists(image: string): Promise<boolean>;

  /** Create and start an isolated workspace. Resolves when the container accepts exec. */
  create(spec: WorkspaceSpec, opts?: { signal?: AbortSignal }): Promise<WorkspaceHandle>;

  /**
   * Run a process inside the workspace and stream its output. Never throws on non-zero exit.
   * Always yields `{ type: 'started', execRef }` first.
   */
  exec(handle: WorkspaceHandle, spec: ExecSpec): AsyncIterable<ExecEvent>;

  /** Deliver a signal to the main process of a previous exec (cancellation). */
  signal(handle: WorkspaceHandle, execRef: string, sig: ExecSignal): Promise<void>;

  /** Read git state so it can be persisted before destroy (restore hints). */
  snapshot(handle: WorkspaceHandle): Promise<WorkspaceSnapshot>;

  /** Stop and remove the workspace and all its storage. Idempotent. */
  destroy(handle: WorkspaceHandle): Promise<void>;

  /** Liveness check; `gone` means destroyed or never existed. */
  health(handle: WorkspaceHandle): Promise<WorkspaceHealth>;

  /** Enumerate workspaces created by this runner for a label selector (GC, doctor). */
  list(labels: Readonly<Record<string, string>>): Promise<WorkspaceHandle[]>;
}
