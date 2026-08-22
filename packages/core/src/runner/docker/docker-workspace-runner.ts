/**
 * The Docker implementation of the `WorkspaceRunner` port.
 *
 * Layer: service (adapter).
 *
 * Depends on the narrow {@link DockerApi} rather than on dockerode itself, so every path — image
 * missing, readiness exhaustion, exec timeout, kill fallback, container vanished mid-turn — is
 * driven deterministically by unit tests, and the real client is constructed in exactly one place
 * (`createDockerWorkspaceRunner`).
 *
 * Secret handling: a credential reaches a workspace as an {@link ExecSpec.files} entry, placed
 * immediately before the process that reads it starts and removed by that process. It is passed to
 * the daemon and never stored on this object, never logged, and never interpolated into an error.
 * All state is held in `#private` fields, so even `JSON.stringify(runner)` cannot reach the Docker
 * client and the create options it remembers.
 */
import type { Clock } from '../../config/clock.ts';
import { WorkspaceImageMissing } from '../../errors.ts';
import type {
  ExecEvent,
  ExecSignal,
  ExecSpec,
  WorkspaceHandle,
  WorkspaceHealth,
  WorkspaceFile,
  WorkspaceRunner,
  WorkspaceSnapshot,
  WorkspaceSpec,
} from '../types.ts';

import { buildContainerFileArchive } from './container-files.ts';
import {
  buildContainerCreateOptions,
  buildNetworkCreateOptions,
  DISABLE_INTER_CONTAINER_TRAFFIC,
  LABEL_INSTANCE,
  LABEL_WORKSPACE,
  toEnvArray,
  WORKSPACE_DIR,
  WORKSPACE_USER,
} from './container-spec.ts';
import type { DockerApi, DockerContainerApi, DockerContainerState } from './docker-api.ts';
import { isDockerConflict, isDockerNotFound, isDockerNotModified } from './docker-api.ts';
import { DockerRunnerError } from './errors.ts';
import {
  createDockerDemuxer,
  execWrapperCommand,
  killCommand,
  pidFileCleanupCommand,
  pumpExecStream,
  writeStdin,
} from './exec-stream.ts';
import type { ExecTermination } from './exec-stream.ts';
import { captureGitSnapshot } from './git-snapshot.ts';
import type { CaptureResult } from './git-snapshot.ts';

/** Runner id persisted on `Workspace.runnerKind`. */
const RUNNER_KIND = 'docker';

/** Command used to prove the container accepts exec. */
const READINESS_COMMAND = ['true'] as const;

/** Readiness budget: 25 attempts, 200 ms apart, i.e. up to five seconds. */
const DEFAULT_READINESS = { attempts: 25, delayMs: 200 } as const;

/** Grace period given to the container's main process before it is killed. */
const STOP_GRACE_SECONDS = 10;

/**
 * Waits before the next readiness attempt.
 *
 * A plain delay rather than a cancellable timer: the back-off has nothing to cancel, and the abort
 * signal is re-checked at the top of every attempt, so at worst a cancelled create waits out one
 * more interval before failing.
 */
export type Sleep = (ms: number) => Promise<void>;

/** The real delay, used when no override is given. */
const systemSleep: Sleep = async (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Construction inputs of {@link DockerWorkspaceRunner}. */
export interface DockerWorkspaceRunnerOptions {
  /** The Docker API to drive; the real dockerode client in production, a fake in unit tests. */
  docker: DockerApi;
  /** Instance name written to and filtered on via the `ah.instance` label. */
  instance: string;
  /** Container name prefix of this instance. */
  namePrefix: string;
  /** Time source for snapshot timestamps and uptime. */
  clock?: Clock | undefined;
  /** Readiness probe budget. */
  readiness?: { attempts: number; delayMs: number } | undefined;
  /** Delay between readiness attempts; injected by tests so retries cost no wall-clock time. */
  sleep?: Sleep | undefined;
  /** Exec reference generator; injected by tests. */
  randomUUID?: (() => string) | undefined;
}

/** Runs each workspace as one hardened, disposable Docker container. */
export class DockerWorkspaceRunner implements WorkspaceRunner {
  /** Runner id persisted on the `Workspace` row. */
  readonly kind = RUNNER_KIND;

  readonly #docker: DockerApi;
  readonly #instance: string;
  readonly #namePrefix: string;
  readonly #clock: Clock;
  readonly #readiness: { attempts: number; delayMs: number };
  readonly #sleep: Sleep;
  readonly #randomUUID: () => string;

  /**
   * Execs this runner has handed a reference out for and not yet started on the daemon.
   *
   * Covers the window the pid file cannot: between the `started` event and the wrapper writing its
   * pid, there is no pid to kill, so a `signal` would find nothing, report success, and let the
   * command start uncancelled anyway. The entry records the request and the exec honours it.
   *
   * It deliberately does NOT gate delivery. `execRef` travels to the caller and back, and the
   * contract does not promise that `signal` reaches the same process that ran `exec`; refusing to
   * signal a reference this instance does not know would turn a cross-process cancellation into a
   * silent no-op. Staleness is handled where it arises instead — the pid file is removed when the
   * exec ends, so a late signal finds no file rather than a recycled pid.
   */
  readonly #liveExecs = new Map<string, { cancelled: ExecSignal | null }>();

  /**
   * @param options - Docker API, instance naming and the injectable clock, timer and id source.
   */
  constructor(options: DockerWorkspaceRunnerOptions) {
    this.#docker = options.docker;
    this.#instance = options.instance;
    this.#namePrefix = options.namePrefix;
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#readiness = options.readiness ?? DEFAULT_READINESS;
    this.#sleep = options.sleep ?? systemSleep;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  }

  /**
   * Asks the daemon whether an image is present, without creating anything.
   *
   * Expressed in terms of the check `create` already performs, so the boot probe and the health
   * card cannot drift from the rule a turn is actually held to: the one that raises
   * `WorkspaceImageMissing` is the one that answers `false` here. Any other inspection failure is
   * the daemon being unreachable or broken, which is not absence and is raised rather than
   * flattened into a `false` that would tell an operator to build an image they already have.
   *
   * @param image - Image reference (tag or digest).
   * @returns `true` when the daemon knows the image.
   * @throws DockerRunnerError when the image could not be inspected at all.
   */
  async imageExists(image: string): Promise<boolean> {
    try {
      await this.#assertImageExists(image);
      return true;
    } catch (error) {
      if (error instanceof WorkspaceImageMissing) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Creates, starts and readiness-probes a workspace container.
   *
   * @param spec - Image, environment, limits and labels of the workspace.
   * @param opts - Optional cancellation signal, checked before every readiness attempt.
   * @returns A handle carrying the workspace id and the container id.
   * @throws WorkspaceImageMissing when the image is not on the host.
   * @throws DockerRunnerError when the daemon refuses, the name is taken, the caller aborted, or
   *   the container never accepted an exec.
   */
  async create(spec: WorkspaceSpec, opts?: { signal?: AbortSignal }): Promise<WorkspaceHandle> {
    await this.#assertImageExists(spec.image);
    await this.#ensureNetwork();
    const container = await this.#createContainer(spec);
    // Once the container exists, every later failure must remove it. A created-but-abandoned
    // container holds the workspace name for good, so the retry the caller is about to make would
    // fail the name-conflict check forever instead of recovering.
    try {
      await this.#placeFiles(container, spec.files ?? []);
      await container.start();
      await this.#awaitReadiness(container, opts?.signal);
    } catch (error) {
      await this.#discard(container);
      throw error;
    }
    return { workspaceId: spec.workspaceId, runnerRef: container.id };
  }

  /**
   * Places files into the container, root-owned.
   *
   * A {@link WorkspaceSpec} places its files before `start`, so the workspace user cannot race one
   * into position that no process of its own has had the chance to touch yet: what the first
   * process sees is what the host asked for, which is the whole reason a policy the workspace must
   * not be able to restate is delivered as a file rather than as an environment variable it could
   * simply set again. An {@link ExecSpec} places its files immediately before its own process, for
   * the values that must not still be there once that process has finished with them.
   *
   * @param container - The container to place them in.
   * @param files - Files to place; usually none or one.
   * @throws DockerRunnerError when a path is unusable; the daemon's own failures propagate.
   */
  async #placeFiles(container: DockerContainerApi, files: readonly WorkspaceFile[]): Promise<void> {
    for (const file of files) {
      const { path, archive } = await buildContainerFileArchive(file);
      await container.putArchive(archive, { path });
    }
  }

  /**
   * Runs a process inside the workspace and streams its output.
   *
   * The `started` event is yielded before any daemon call so a caller can `signal()` this exec even
   * if the exec setup itself is slow. A non-zero exit is reported as data; a workspace that
   * disappeared mid-turn ends the stream with `exit { signal: 'GONE' }` rather than throwing,
   * because the turn processor recovers from that by recreating the workspace.
   *
   * @param handle - Workspace to run in.
   * @param spec - Command, working directory, environment, stdin, timeout and cancellation.
   * @yields `started`, then stdout/stderr events, then exactly one `exit`.
   */
  async *exec(handle: WorkspaceHandle, spec: ExecSpec): AsyncGenerator<ExecEvent> {
    const execRef = this.#randomUUID();
    // Registered before the reference is handed out, so a `signal` arriving while this generator is
    // still suspended at the `started` yield has somewhere to record itself.
    const record = { cancelled: null as ExecSignal | null };
    this.#liveExecs.set(execRef, record);
    yield { type: 'started', execRef };

    try {
      yield* this.#streamExec(handle, spec, execRef, record);
    } catch (error) {
      if (!isDockerNotFound(error)) {
        throw error instanceof DockerRunnerError
          ? error
          : new DockerRunnerError(`exec ${execRef} failed in workspace ${handle.workspaceId}`, {
              cause: error,
            });
      }
      yield { type: 'exit', code: null, signal: 'GONE' };
      // The entry below is replaced by the next exec that takes this reference, so forgetting it
      // changes nothing any caller can observe — only how much the map holds for a runner that is
      // never restarted. Mutation testing therefore cannot kill either the call or the block it
      // sits in; the call carries a directive saying so, and the block cannot take one, because a
      // directive binds to a `finally` only between the keyword and its brace and no such line
      // survives formatting.
    } finally {
      // Stryker disable next-line CallExpression
      this.#liveExecs.delete(execRef);
    }
  }

  /**
   * Delivers a signal to the main process of a previous exec.
   *
   * Resolves silently when the pid file is gone (the process already finished) or when the
   * container itself is gone: both mean there is nothing left to cancel.
   *
   * @param handle - Workspace the exec ran in.
   * @param execRef - Reference yielded by the exec's `started` event.
   * @param sig - Signal to deliver.
   * @returns Resolves once the signal was delivered or found to be unnecessary.
   * @throws DockerRunnerError when the reference is malformed or the daemon fails otherwise.
   */
  async signal(handle: WorkspaceHandle, execRef: string, sig: ExecSignal): Promise<void> {
    // Built first so a malformed reference or an unknown signal is rejected even when the exec is
    // already over — the caller's bug should not depend on timing to be reported.
    const cmd = killCommand(execRef, sig);

    // When this instance owns the exec and it has not reached the daemon yet, record the request:
    // the pid file does not exist, so the kill below would report "already finished" and the
    // command would start anyway. Delivery is still attempted, because the exec may equally be
    // owned by another process.
    const record = this.#liveExecs.get(execRef);
    if (record !== undefined) {
      record.cancelled = sig;
    }

    try {
      await this.#runCapture(this.#docker.getContainer(handle.runnerRef), cmd);
    } catch (error) {
      if (!isDockerNotFound(error)) {
        throw new DockerRunnerError(`cannot signal exec ${execRef}`, { cause: error });
      }
    }
  }

  /**
   * Reads the git state of the workspace so it can be persisted before destroy.
   *
   * @param handle - Workspace to inspect.
   * @returns The snapshot; all-null git state when `/workspace` is not a repository.
   */
  async snapshot(handle: WorkspaceHandle): Promise<WorkspaceSnapshot> {
    const container = this.#docker.getContainer(handle.runnerRef);
    return captureGitSnapshot(async (cmd) => this.#runCapture(container, cmd), this.#clock.now());
  }

  /**
   * Stops and removes the workspace and its storage.
   *
   * Idempotent: a container that is already stopped (304), already gone (404) or already being
   * removed by another caller (409) is a success, so neither a retried destroy after a worker
   * crash nor a second destroyer racing this one fails the job.
   *
   * @param handle - Workspace to destroy.
   * @returns Resolves once the container is gone.
   * @throws DockerRunnerError when the daemon fails for any other reason.
   */
  async destroy(handle: WorkspaceHandle): Promise<void> {
    await this.#destroyContainer(this.#docker.getContainer(handle.runnerRef));
  }

  /**
   * Reports whether the workspace is alive.
   *
   * @param handle - Workspace to check.
   * @returns `healthy` with uptime, `unhealthy` with a reason, or `gone`.
   * @throws DockerRunnerError when the daemon fails for a reason other than "not found".
   */
  async health(handle: WorkspaceHandle): Promise<WorkspaceHealth> {
    let state: DockerContainerState;
    try {
      ({ State: state } = await this.#docker.getContainer(handle.runnerRef).inspect());
    } catch (error) {
      if (isDockerNotFound(error)) {
        return { status: 'gone' };
      }
      throw new DockerRunnerError(`cannot inspect workspace ${handle.workspaceId}`, {
        cause: error,
      });
    }

    if (state.Running) {
      const startedAt = Date.parse(state.StartedAt);
      const uptimeMs = Number.isNaN(startedAt)
        ? 0
        : Math.max(0, this.#clock.now().getTime() - startedAt);
      return { status: 'healthy', uptimeMs };
    }

    return {
      status: 'unhealthy',
      reason:
        state.OOMKilled === true
          ? 'oom-killed'
          : `status=${state.Status} exit=${state.ExitCode ?? 'unknown'}`,
    };
  }

  /**
   * Enumerates this instance's workspaces matching a label selector.
   *
   * The instance label is always part of the filter: a reaper must never touch the containers of
   * another checkout running on the same daemon.
   *
   * @param labels - Extra label equalities to match, e.g. `{ 'ah.chat': '<id>' }`.
   * @returns One handle per matching container that carries a workspace label.
   */
  async list(labels: Readonly<Record<string, string>>): Promise<WorkspaceHandle[]> {
    const label = [
      `${LABEL_INSTANCE}=${this.#instance}`,
      ...Object.entries(labels).map(([key, value]) => `${key}=${value}`),
    ];
    const containers = await this.#docker.listContainers({ all: true, filters: { label } });

    return containers.flatMap((entry) => {
      const workspaceId = entry.Labels[LABEL_WORKSPACE];
      return workspaceId === undefined || workspaceId === ''
        ? []
        : [{ workspaceId, runnerRef: entry.Id }];
    });
  }

  /**
   * Verifies the workspace image is present before anything is created.
   *
   * @param image - Image reference from the spec.
   * @throws WorkspaceImageMissing when the daemon does not know the image.
   * @throws DockerRunnerError for any other inspection failure.
   */
  async #assertImageExists(image: string): Promise<void> {
    try {
      await this.#docker.getImage(image).inspect();
    } catch (error) {
      if (isDockerNotFound(error)) {
        throw new WorkspaceImageMissing(image, { cause: error });
      }
      throw new DockerRunnerError(`cannot inspect image ${image}`, { cause: error });
    }
  }

  /**
   * Makes sure this instance's workspace network exists before a container asks to join it.
   *
   * Checked on every create rather than once per process: the network outlives no particular
   * runner, and `docker network prune` removes it the moment the last workspace is destroyed, so a
   * runner that remembered creating it would hand the next workspace a network that is gone.
   *
   * A concurrent create racing to the same conclusion is expected and is not a failure: the loser
   * gets a 409 from the daemon, which means the network is there, which is all this asked for.
   *
   * @throws DockerRunnerError when the daemon refuses for any other reason.
   */
  async #ensureNetwork(): Promise<void> {
    const options = buildNetworkCreateOptions(this.#instance);
    // The daemon matches a name filter as a substring, so an instance whose name is a prefix of
    // another's would find the wrong network. Compare the names it returns.
    const existing = await this.#docker.listNetworks({ filters: { name: [options.Name] } });
    const found = existing.find((network) => network.Name === options.Name);
    if (found !== undefined) {
      assertNetworkIsolates(found);
      return;
    }
    try {
      await this.#docker.createNetwork(options);
    } catch (error) {
      if (isDockerConflict(error)) {
        return;
      }
      throw new DockerRunnerError(`could not create the workspace network ${options.Name}`, {
        cause: error,
      });
    }
  }

  /**
   * Creates the container from the hardened spec.
   *
   * @param spec - Workspace to create.
   * @returns The created container.
   * @throws DockerRunnerError when the name is taken or the daemon refuses.
   */
  async #createContainer(spec: WorkspaceSpec): Promise<DockerContainerApi> {
    const options = buildContainerCreateOptions(spec, {
      namePrefix: this.#namePrefix,
      instance: this.#instance,
    });
    try {
      return await this.#docker.createContainer(options);
    } catch (error) {
      // Neither branch attaches a `cause`. This daemon call's request body carries the whole
      // workspace environment, and a rejection from it is the one place a daemon or proxy might
      // echo that body back. No credential travels in it any more, but the operator's own
      // configuration does, and the workspace id is enough to locate the failure in the daemon's
      // own logs.
      if (isDockerConflict(error)) {
        throw new DockerRunnerError(
          `container name already exists for workspace ${spec.workspaceId}`,
        );
      }
      throw new DockerRunnerError(`cannot create workspace ${spec.workspaceId}`);
    }
  }

  /**
   * Waits until the container accepts an exec, then returns.
   *
   * @param container - The freshly started container.
   * @param signal - Optional cancellation, checked before every attempt.
   * Cleanup is deliberately not done here: `create` removes the container on any failure of the
   * start-and-readiness sequence, so this method only has to report why it gave up.
   *
   * @throws DockerRunnerError when the caller aborted or the readiness budget ran out.
   */
  async #awaitReadiness(container: DockerContainerApi, signal?: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < this.#readiness.attempts; attempt += 1) {
      if (signal?.aborted === true) {
        throw new DockerRunnerError('create aborted');
      }
      const probe = await this.#runCapture(container, READINESS_COMMAND);
      if (probe.code === 0) {
        return;
      }
      await this.#sleep(this.#readiness.delayMs);
    }
    throw new DockerRunnerError('workspace did not become ready');
  }

  /**
   * Runs the exec once the `started` event has been yielded.
   *
   * @param handle - Workspace to run in.
   * @param spec - The exec specification.
   * @param execRef - Reference already reported to the caller.
   * @param record - Registry entry carrying a `signal` that arrived before the exec started.
   * @yields Output events followed by the terminal `exit` event.
   */
  async *#streamExec(
    handle: WorkspaceHandle,
    spec: ExecSpec,
    execRef: string,
    record: { cancelled: ExecSignal | null },
  ): AsyncGenerator<ExecEvent> {
    // A signal delivered while this generator was suspended at the `started` yield refers to a
    // process that does not exist yet. Honour it by never starting one.
    if (record.cancelled !== null) {
      yield { type: 'exit', code: null, signal: 'ABORTED' };
      return;
    }

    const container = this.#docker.getContainer(handle.runnerRef);
    // Placed as late as possible and never earlier: these carry the credentials of one turn, and
    // the window they are readable in is exactly the distance between this line and the first
    // thing the started process does.
    await this.#placeFiles(container, spec.files ?? []);
    const exec = await container.exec({
      Cmd: execWrapperCommand(execRef, spec.cmd),
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: spec.cwd ?? WORKSPACE_DIR,
      Env: spec.env === undefined ? undefined : toEnvArray(spec.env),
      User: WORKSPACE_USER,
    });
    const stream = await exec.start({ hijack: true, stdin: true });

    // Aborted whenever the exec ends early, so the stdin writer stops too. The caller's own signal
    // is not enough: a wall-clock timeout ends the exec without aborting it, and the writer is
    // awaited below — an async stdin source still waiting inside `next()` would hold that await
    // open for good and no terminal event would ever reach the caller. Every early end runs
    // through `kill`, and the `finally` covers the ordinary one, so no separate abort listener is
    // needed here.
    const stdinDone = new AbortController();

    // Not awaited here: the process may produce output long before it has consumed all of stdin,
    // and awaiting first would deadlock on anything larger than the pipe buffer. The rejection
    // handler is attached immediately rather than at the `await` below, so the promise is never
    // momentarily unhandled. Stdin failures are not exec failures: the stream is destroyed on the
    // termination paths, and a caller-supplied source that throws leaves the process with
    // truncated input — whose consequence the exit code already reports.
    const stdinWritten = writeStdin(stream, spec.stdin, stdinDone.signal).catch(() => undefined);

    try {
      yield* pumpExecStream({
        stream,
        demuxer: createDockerDemuxer(),
        timeoutMs: spec.timeoutMs,
        signal: spec.signal,
        // The writer is not stopped here: the `finally` below stops it on every way out of this
        // method, this one included, and stopping it twice would only mean stopping it sooner by
        // the length of a kill.
        kill: async (reason: ExecTermination) => this.#killExec(container, execRef, reason),
        inspectExitCode: async () => (await exec.inspect()).ExitCode,
      });
    } finally {
      // Wait for the writer to finish so stdin is always closed before the exec is considered over.
      // Bounded by `stdinDone`: the writer abandons an uncooperative source instead of hanging.
      stdinDone.abort();
      await stdinWritten;
      // Best-effort: the pid file must not outlive the process it names, or a late signal lands on
      // a recycled pid. A failure here only leaves a stale file behind on a disposable container.
      await this.#runCapture(container, pidFileCleanupCommand(execRef)).catch(() => undefined);
    }
  }

  /**
   * Terminates a running exec, falling back to the container when the signal cannot be delivered.
   *
   * @param container - Container the exec runs in.
   * @param execRef - Reference naming the exec's pid file.
   * @param reason - Why the exec is being terminated; part of the fallback error message.
   * @throws DockerRunnerError when even the container-level kill fails.
   */
  async #killExec(
    container: DockerContainerApi,
    execRef: string,
    reason: ExecTermination,
  ): Promise<void> {
    let delivered = false;
    try {
      delivered = (await this.#runCapture(container, killCommand(execRef, 'KILL'))).code === 0;
    } catch {
      // Deliberately not surfaced, and nothing to record: `delivered` is already false. The kill
      // exec can fail for the same reasons the exec being killed already has (container gone, exec
      // limit reached), and the caller asked for the process to stop, not for a diagnosis. The
      // container-level fallback below is the answer, and its own failure IS reported.
    }
    if (delivered) {
      return;
    }

    // Last resort: the image's PID 1 is `sleep infinity`, so killing the container stops every
    // process in it. `health` then reports the workspace unhealthy and the caller recreates it.
    try {
      await container.kill();
    } catch (error) {
      throw new DockerRunnerError(`cannot terminate exec ${execRef} (${reason})`, { cause: error });
    }
  }

  /**
   * Runs a command inside the container and collects its output.
   *
   * Used by every internal probe (readiness, kill, signal, snapshot); it attaches no stdin, so the
   * process always sees EOF immediately.
   *
   * @param container - Container to run in.
   * @param cmd - Argument vector.
   * @param cwd - Working directory; defaults to the workspace directory.
   * @returns Exit code and decoded output.
   */
  async #runCapture(
    container: DockerContainerApi,
    cmd: readonly string[],
    cwd: string = WORKSPACE_DIR,
  ): Promise<CaptureResult> {
    const exec = await container.exec({
      Cmd: [...cmd],
      AttachStdin: false,
      AttachStdout: true,
      // Stryker disable next-line BooleanLiteral: what arrives on this stream is collected and
      // never read, for the reason given where it is collected below, so asking the daemon for it
      // or not cannot be told apart from outside.
      AttachStderr: true,
      Tty: false,
      WorkingDir: cwd,
      User: WORKSPACE_USER,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const demuxer = createDockerDemuxer();
    const decoder = new TextDecoder();
    let stdout = '';
    // What this next one collects is never read: it is collected because `CaptureResult` declares
    // it, and it is surfaced nowhere because it is output from a container the model controls. So
    // no observation of this runner can tell one starting value, one branch or one accumulation of
    // it from another, and the three directives below say so where they sit.
    // Stryker disable next-line StringLiteral
    let stderr = '';

    for await (const chunk of stream) {
      for (const event of demuxer.push(chunk)) {
        if (event.type === 'stdout') {
          stdout += decoder.decode(event.data);
        }
        // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral,BlockStatement
        if (event.type === 'stderr') {
          // Stryker disable next-line AssignmentOperator
          stderr += decoder.decode(event.data);
        }
      }
    }

    return { code: (await exec.inspect()).ExitCode, stdout, stderr };
  }

  /**
   * Stops and removes a container, tolerating "already stopped", "already gone" and "already
   * going".
   *
   * The last of the three is what a second remover sees. Destroying a workspace has more than one
   * caller by design — the teardown of the turn that owned it, the collector's orphan pass, and
   * the operator's reaper — and the daemon answers `409` to whichever arrives while another
   * removal is under way. That is the goal of this method being met by somebody else, not a
   * failure of it: the container is on its way out either way. Treating it as an error made the
   * collector report every concurrently reaped workspace as a failed teardown, and would leave a
   * row `FAILED` for a container that is gone. The remove is forced, so the other `409` the daemon
   * has — "the container is running" — cannot be what arrived here.
   *
   * @param container - Container to destroy.
   * @throws DockerRunnerError when the daemon fails for any other reason.
   */
  async #destroyContainer(container: DockerContainerApi): Promise<void> {
    try {
      await container.stop({ t: STOP_GRACE_SECONDS });
    } catch (error) {
      if (!isDockerNotFound(error) && !isDockerNotModified(error) && !isDockerConflict(error)) {
        throw new DockerRunnerError(`cannot stop container ${container.id}`, { cause: error });
      }
    }

    try {
      await container.remove({ v: true, force: true });
    } catch (error) {
      if (!isDockerNotFound(error) && !isDockerConflict(error)) {
        throw new DockerRunnerError(`cannot remove container ${container.id}`, { cause: error });
      }
    }
  }

  /**
   * Best-effort cleanup of a container that never became usable.
   *
   * The caller is already failing with a precise reason; a cleanup failure must not replace it.
   *
   * @param container - Container to discard.
   */
  async #discard(container: DockerContainerApi): Promise<void> {
    await this.#destroyContainer(container).catch(() => undefined);
  }
}

/**
 * Refuses a network that carries the right name without the isolation the runner depends on.
 *
 * Reuse is by name, and a name is not evidence. A network made by hand, or by an earlier version
 * of these options, would otherwise be joined in silence and every workspace on it could address
 * every other — the exact state this network exists to prevent, arrived at without a word. Failing
 * the create is the safe answer: a workspace that cannot be isolated is one that should not start,
 * and the operator is told which network to remove.
 *
 * @param network - The existing network, as the daemon reports it.
 * @throws DockerRunnerError naming the network and the option it lacks.
 */
function assertNetworkIsolates(network: {
  Name: string;
  Options?: Record<string, string> | undefined;
}): void {
  if (network.Options?.[DISABLE_INTER_CONTAINER_TRAFFIC] !== 'false') {
    throw new DockerRunnerError(
      `the workspace network ${network.Name} does not isolate its members ` +
        `(${DISABLE_INTER_CONTAINER_TRAFFIC} is not "false"); ` +
        `remove it with "docker network rm ${network.Name}" and it will be recreated`,
    );
  }
}
