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
  /** Environment injected at start. Secrets arrive here and nowhere else. */
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
   * Secrets do not belong here: this is for values that must survive the workspace, not values
   * that must be hidden from it. Credentials still travel in {@link WorkspaceSpec.env}.
   */
  files?: readonly WorkspaceFile[];
}

/** One file placed into a workspace before it starts. */
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
  /** Extra environment for this process only. */
  env?: Readonly<Record<string, string>>;
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
