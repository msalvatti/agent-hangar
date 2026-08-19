/**
 * Unit tests for {@link DockerWorkspaceRunner}.
 *
 * Layer: unit.
 * Goal: every branch of the seven contract methods against an in-memory Docker API — the image
 * gate, container hardening, readiness and its two failure exits, the exec event sequence with its
 * timeout/abort/kill-fallback paths, idempotent destroy, health mapping, instance-scoped listing —
 * plus the standing secret invariant that no environment VALUE ever reaches an error message or a
 * serialisation of the runner.
 * Mocks: `FakeDockerApi` (scripted execs, injectable daemon failures), `FakeClock`, a synchronous
 * `setTimeout` stand-in and a deterministic id source.
 */
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceImageMissing } from '../../errors.js';
import { CANARY_MARKER, GITHUB_CANARY } from '../../testing/canaries.js';
import { FakeClock } from '../../testing/fake-clock.js';
import type { ExecEvent, WorkspaceHandle, WorkspaceSpec } from '../types.js';

import { DockerWorkspaceRunner } from './docker-workspace-runner.js';
import { DockerRunnerError } from './errors.js';
import { dockerError, FakeDockerApi } from './testing/fake-docker-api.js';
import type { FakeExecScript } from './testing/fake-docker-api.js';

/** Image every spec refers to. */
const IMAGE = 'agent-hangar/workspace:dev';

/** Deterministic exec reference the injected id source returns. */
const EXEC_REF = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const decoder = new TextDecoder();

/**
 * Builds a workspace spec.
 *
 * @param overrides - Fields to replace on the baseline chat spec.
 * @returns A complete spec whose environment carries the GitHub canary.
 */
function spec(overrides: Partial<WorkspaceSpec> = {}): WorkspaceSpec {
  return {
    workspaceId: 'ws-1',
    kind: 'CHAT',
    image: IMAGE,
    env: { GITHUB_TOKEN: GITHUB_CANARY },
    limits: { cpus: 1, memoryBytes: 536_870_912, pids: 256 },
    labels: { 'ah.chat': 'chat-1' },
    ...overrides,
  };
}

/**
 * Builds a runner over a fake daemon that already knows the workspace image.
 *
 * @param options - Extra exec scripts and a readiness budget override.
 * @returns The runner, the fake daemon and the clock driving uptime.
 */
function makeRunner(
  options: {
    execScripts?: FakeExecScript[];
    readiness?: { attempts: number; delayMs: number };
  } = {},
): { runner: DockerWorkspaceRunner; docker: FakeDockerApi; clock: FakeClock } {
  const docker = new FakeDockerApi({ images: [IMAGE], execScripts: options.execScripts ?? [] });
  const clock = new FakeClock();
  const runner = new DockerWorkspaceRunner({
    docker,
    instance: 'test',
    namePrefix: 'ah-ws-test-',
    clock,
    readiness: options.readiness ?? { attempts: 3, delayMs: 1 },
    // Runs the callback immediately: the readiness delay is not what these tests are about.
    setTimeoutFn: ((callback: () => void) => {
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    randomUUID: () => EXEC_REF,
  });
  return { runner, docker, clock };
}

/**
 * Drains an exec into its parts.
 *
 * @param events - The exec's event stream.
 * @returns Ordered event kinds, decoded stdout and stderr, and the terminal event.
 */
async function drain(events: AsyncIterable<ExecEvent>): Promise<{
  kinds: string[];
  stdout: string;
  stderr: string;
  exit: ExecEvent | undefined;
}> {
  const kinds: string[] = [];
  let stdout = '';
  let stderr = '';
  let exit: ExecEvent | undefined;

  for await (const event of events) {
    kinds.push(event.type);
    if (event.type === 'stdout') {
      stdout += decoder.decode(event.data);
    }
    if (event.type === 'stderr') {
      stderr += decoder.decode(event.data);
    }
    if (event.type === 'exit') {
      exit = event;
    }
  }

  return { kinds, stdout, stderr, exit };
}

/**
 * Creates a ready workspace.
 *
 * @param runner - Runner to create through.
 * @returns The handle of the created workspace.
 */
async function createWorkspace(runner: DockerWorkspaceRunner): Promise<WorkspaceHandle> {
  return runner.create(spec());
}

describe('DockerWorkspaceRunner.create', () => {
  /**
   * The happy path: the container is created with the hardened options, started, probed and
   * returned as a handle pairing the workspace id with the container id.
   */
  it('creates, starts and readiness-probes the container', async () => {
    const { runner, docker } = makeRunner();

    const handle = await createWorkspace(runner);

    expect(handle).toEqual({ workspaceId: 'ws-1', runnerRef: 'c1' });
    const record = docker.containers.get('c1');
    expect(record?.running).toBe(true);
    expect(record?.options.name).toBe('ah-ws-test-ws-1');
    expect(record?.options.HostConfig?.PidsLimit).toBe(256);
    expect(record?.options.Labels?.['ah.instance']).toBe('test');
    expect(record?.execCommands).toEqual([['true']]);
  });

  /**
   * The image is never pulled or built implicitly, so a missing one must be a typed error naming
   * the exact command that fixes it — that message is shown verbatim in the UI.
   */
  it('reports a missing image with the build command', async () => {
    const docker = new FakeDockerApi({ execScripts: [] });
    const runner = new DockerWorkspaceRunner({
      docker,
      instance: 'test',
      namePrefix: 'ah-ws-test-',
    });

    await expect(runner.create(spec())).rejects.toThrow(WorkspaceImageMissing);
    await expect(runner.create(spec())).rejects.toThrow('pnpm infra:image');
  });

  /**
   * A daemon that is unreachable or broken is a different failure from a missing image and must
   * not be reported to the user as "build the image".
   */
  it('wraps a non-404 image inspection failure', async () => {
    const { runner, docker } = makeRunner();
    docker.failures.imageInspect = new Error('daemon unreachable');

    await expect(runner.create(spec())).rejects.toThrow(DockerRunnerError);
  });

  /**
   * One workspace per name: a second create with the same id conflicts, which means a previous
   * container was never cleaned up and the caller must reap before retrying.
   */
  it('reports a container name conflict', async () => {
    const { runner } = makeRunner();
    await createWorkspace(runner);

    await expect(createWorkspace(runner)).rejects.toThrow(/container name already exists/);
  });

  /**
   * Any other create refusal (invalid option, daemon out of resources) surfaces as the runner's
   * typed error rather than a raw daemon object.
   */
  it('wraps a create refusal from the daemon', async () => {
    const { runner, docker } = makeRunner();
    docker.failures.createContainer = new Error('no space left on device');

    await expect(runner.create(spec())).rejects.toThrow(DockerRunnerError);
  });

  /**
   * A container that never accepts an exec is useless; it must be removed rather than left behind
   * as an orphan the reaper has to find later.
   */
  it('destroys the container when readiness never succeeds', async () => {
    const { runner, docker } = makeRunner({
      execScripts: [{ match: (cmd) => cmd[0] === 'true', exitCode: 1 }],
    });

    await expect(runner.create(spec())).rejects.toThrow('workspace did not become ready');
    expect(docker.containers.size).toBe(0);
  });

  /**
   * The cleanup after a failed readiness is best effort: if the removal itself fails, the caller
   * must still learn WHY the workspace was unusable, not why the cleanup was.
   */
  it('reports the readiness failure even when the cleanup fails', async () => {
    const { runner, docker } = makeRunner({
      execScripts: [{ match: (cmd) => cmd[0] === 'true', exitCode: 1 }],
    });
    docker.failures.containerRemove = new Error('device or resource busy');

    await expect(runner.create(spec())).rejects.toThrow('workspace did not become ready');
  });

  /**
   * Cancellation during create (the user closed the chat while it was starting) also has to clean
   * up: an aborted create must not leave a running container.
   */
  it('destroys the container when the caller aborts', async () => {
    const { runner, docker } = makeRunner();
    const controller = new AbortController();
    controller.abort();

    await expect(runner.create(spec(), { signal: controller.signal })).rejects.toThrow(
      'create aborted',
    );
    expect(docker.containers.size).toBe(0);
  });

  /**
   * Security invariant: `spec.env` carries the GitHub PAT. It may reach the daemon and nothing
   * else — not a thrown message on any failure path, and not a serialisation of the runner, which
   * is why the runner keeps all of its state (including the Docker client) in private fields.
   */
  it('never leaks an environment value into an error or a serialisation', async () => {
    const { runner, docker } = makeRunner();
    docker.failures.createContainer = new Error('refused');

    const failure = await runner.create(spec()).catch((error: unknown) => error as Error);

    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(
      CANARY_MARKER,
    );
    expect(JSON.stringify(runner)).not.toContain(CANARY_MARKER);
    expect(JSON.stringify(runner)).toBe('{"kind":"docker"}');
  });

  /**
   * Defaults matter because production passes neither a clock nor a readiness budget; constructing
   * without them must still produce a working runner.
   */
  it('works with the default clock, timer, id source and readiness budget', async () => {
    const docker = new FakeDockerApi({ images: [IMAGE] });
    const runner = new DockerWorkspaceRunner({
      docker,
      instance: 'test',
      namePrefix: 'ah-ws-test-',
    });

    const handle = await runner.create(spec());
    const result = await drain(runner.exec(handle, { cmd: ['echo'] }));

    expect(handle.runnerRef).toBe('c1');
    expect((await runner.health(handle)).status).toBe('healthy');
    // The default id source is `crypto.randomUUID`, which the wrapper command requires.
    expect(result.kinds).toEqual(['started', 'exit']);
  });
});

describe('DockerWorkspaceRunner.exec', () => {
  /**
   * The contract's event sequence: `started` first (before any daemon call, so a caller can cancel
   * an exec whose setup is slow), then output in order, then exactly one `exit`.
   */
  it('yields started, then output, then a single exit', async () => {
    const { runner } = makeRunner({
      execScripts: [{ match: (cmd) => cmd.includes('echo'), stdout: 'hello\n', stderr: 'warn\n' }],
    });
    const handle = await createWorkspace(runner);

    const result = await drain(runner.exec(handle, { cmd: ['echo', 'hello'] }));

    expect(result.kinds).toEqual(['started', 'stdout', 'stderr', 'exit']);
    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('warn\n');
    expect(result.exit).toEqual({ type: 'exit', code: 0 });
  });

  /**
   * A failing command is a normal outcome the agent has to reason about, so the exit code is
   * reported as data and nothing is thrown.
   */
  it('reports a non-zero exit code', async () => {
    const { runner } = makeRunner({
      execScripts: [{ match: (cmd) => cmd.includes('false'), exitCode: 3 }],
    });
    const handle = await createWorkspace(runner);

    const result = await drain(runner.exec(handle, { cmd: ['false'] }));

    expect(result.exit).toEqual({ type: 'exit', code: 3 });
  });

  /**
   * The exec must run as the unprivileged image user, in the requested directory, with the extra
   * process environment applied and the pid-file wrapper in front of the real command.
   */
  it('passes cwd, environment and user through, wrapped for signalling', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);

    await drain(runner.exec(handle, { cmd: ['pwd'], cwd: '/tmp', env: { EXTRA: 'value' } }));

    const options = docker.execOptions.at(-1);
    expect(options?.WorkingDir).toBe('/tmp');
    expect(options?.Env).toEqual(['EXTRA=value']);
    expect(options?.User).toBe('agent');
    expect(options?.Cmd.at(0)).toBe('sh');
    expect(options?.Cmd).toContain(EXEC_REF);
    expect(options?.Cmd.at(-1)).toBe('pwd');
  });

  /**
   * The default working directory is the image's `/workspace`, and an exec without extra
   * environment must send none rather than an empty array.
   */
  it('defaults the working directory and omits an empty environment', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);

    await drain(runner.exec(handle, { cmd: ['pwd'] }));

    const options = docker.execOptions.at(-1);
    expect(options?.WorkingDir).toBe('/workspace');
    expect(options?.Env).toBeUndefined();
  });

  /**
   * Stdin is written and then closed, which is what lets a process that reads to EOF — the agent
   * runtime reading its NDJSON turn request — actually finish.
   */
  it('writes stdin and closes it', async () => {
    const { runner, docker } = makeRunner({
      execScripts: [{ match: (cmd) => cmd.includes('cat'), stdout: 'ping' }],
    });
    const handle = await createWorkspace(runner);

    const result = await drain(runner.exec(handle, { cmd: ['cat'], stdin: 'ping' }));

    expect(docker.stdinWrites).toEqual(['ping']);
    expect(result.stdout).toBe('ping');
    expect(result.exit).toEqual({ type: 'exit', code: 0 });
  });

  /**
   * A stdin source that throws mid-stream (a caller-side encoder failure) leaves the process with
   * truncated input, and the process's own exit code already reports the consequence. Turning it
   * into a thrown error would replace an already-yielded terminal event with an exception.
   */
  it('does not fail the exec when the stdin source throws', async () => {
    const { runner } = makeRunner({
      execScripts: [{ match: (cmd) => cmd.includes('cat'), stdout: 'partial' }],
    });
    const handle = await createWorkspace(runner);

    async function* failing(): AsyncIterable<Uint8Array> {
      yield await Promise.resolve(Buffer.from('a'));
      throw new Error('encoder failed');
    }

    const result = await drain(runner.exec(handle, { cmd: ['cat'], stdin: failing() }));

    expect(result.exit).toEqual({ type: 'exit', code: 0 });
  });

  /**
   * Wall-clock limit: the process is killed through its pid file and the exit reports `TIMEOUT`,
   * so the caller can distinguish "the command failed" from "we stopped it".
   */
  it('kills through the pid file and reports TIMEOUT', async () => {
    const { runner, docker } = makeRunner({
      execScripts: [{ match: (cmd) => cmd.includes('sleep'), hang: true }],
    });
    const handle = await createWorkspace(runner);

    const result = await drain(runner.exec(handle, { cmd: ['sleep', '30'], timeoutMs: 5 }));

    expect(result.exit).toEqual({ type: 'exit', code: null, signal: 'TIMEOUT' });
    // The kill is fire-and-forget by design, so it may land after the stream has already ended.
    await vi.waitFor(() => {
      expect(docker.calls.some((call) => call.includes('kill -KILL'))).toBe(true);
    });
    expect(docker.calls).not.toContain('kill:c1');
  });

  /**
   * When the kill exec itself cannot run, the container is killed instead. PID 1 is the image's
   * `sleep infinity`, so that stops every process inside — a blunt but reliable last resort.
   */
  it('falls back to killing the container when the kill exec fails', async () => {
    const { runner, docker } = makeRunner({
      execScripts: [
        { match: (cmd) => cmd.join(' ').includes('kill -KILL'), failStart: true },
        { match: (cmd) => cmd.includes('sleep'), hang: true },
      ],
    });
    const handle = await createWorkspace(runner);

    const result = await drain(runner.exec(handle, { cmd: ['sleep', '30'], timeoutMs: 5 }));

    expect(result.exit).toEqual({ type: 'exit', code: null, signal: 'TIMEOUT' });
    await vi.waitFor(() => {
      expect(docker.calls).toContain('kill:c1');
    });
  });

  /**
   * A kill exec that runs but reports a non-zero code (pid file already gone) also escalates to
   * the container-level kill; the exec must still end cleanly.
   */
  it('falls back when the kill command exits non-zero', async () => {
    const { runner, docker } = makeRunner({
      execScripts: [
        { match: (cmd) => cmd.join(' ').includes('kill -KILL'), exitCode: 1 },
        { match: (cmd) => cmd.includes('sleep'), hang: true },
      ],
    });
    const handle = await createWorkspace(runner);

    await drain(runner.exec(handle, { cmd: ['sleep', '30'], timeoutMs: 5 }));

    await vi.waitFor(() => {
      expect(docker.calls).toContain('kill:c1');
    });
  });

  /**
   * When even the container-level kill fails there is nothing left to try. The exec still ends as
   * `TIMEOUT` — the pump treats the kill as best-effort — but the failure must be raised from the
   * kill path rather than swallowed inside it.
   */
  it('raises when the container-level kill also fails', async () => {
    const { runner, docker } = makeRunner({
      execScripts: [
        { match: (cmd) => cmd.join(' ').includes('kill -KILL'), failStart: true },
        { match: (cmd) => cmd.includes('sleep'), hang: true },
      ],
    });
    const handle = await createWorkspace(runner);
    docker.failures.containerKill = new Error('daemon unreachable');

    const result = await drain(runner.exec(handle, { cmd: ['sleep', '30'], timeoutMs: 5 }));

    expect(result.exit).toEqual({ type: 'exit', code: null, signal: 'TIMEOUT' });
    await vi.waitFor(() => {
      expect(docker.calls).toContain('kill:c1');
    });
  });

  /**
   * The user pressing stop cancels the exec: the stream ends with `ABORTED` rather than an error,
   * because a cancelled turn is a normal outcome the transcript records.
   */
  it('reports ABORTED when the caller cancels', async () => {
    const { runner } = makeRunner({
      execScripts: [{ match: (cmd) => cmd.includes('sleep'), hang: true }],
    });
    const handle = await createWorkspace(runner);
    const controller = new AbortController();
    controller.abort();

    const result = await drain(
      runner.exec(handle, { cmd: ['sleep', '30'], signal: controller.signal }),
    );

    expect(result.exit).toEqual({ type: 'exit', code: null, signal: 'ABORTED' });
  });

  /**
   * A workspace reaped between two turns (idle GC, a manual `docker rm`) must not throw: the turn
   * processor recovers by recreating it, and it can only do that if `exec` ends the stream with
   * `GONE` instead of raising.
   */
  it('ends with GONE when the container has disappeared', async () => {
    const { runner } = makeRunner();
    await createWorkspace(runner);

    const result = await drain(
      runner.exec({ workspaceId: 'ws-1', runnerRef: 'c-missing' }, { cmd: ['echo'] }),
    );

    expect(result.kinds).toEqual(['started', 'exit']);
    expect(result.exit).toEqual({ type: 'exit', code: null, signal: 'GONE' });
  });

  /**
   * Any other exec setup failure is a real fault and must propagate, so the worker retries or
   * fails the turn instead of silently reporting an empty result.
   */
  it('propagates a non-404 exec failure', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);
    docker.failures.containerExec = new Error('exec limit reached');

    await expect(drain(runner.exec(handle, { cmd: ['echo'] }))).rejects.toThrow(
      'exec limit reached',
    );
  });
});

describe('DockerWorkspaceRunner.signal', () => {
  /**
   * Cancellation delivers the requested signal through the exec's pid file, which is the only way
   * to reach the process: the exec's host-side pid is meaningless inside the container.
   */
  it('delivers the signal through the pid file', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);

    await runner.signal(handle, EXEC_REF, 'INT');

    expect(docker.calls.some((call) => call.includes('kill -INT'))).toBe(true);
  });

  /**
   * A non-zero exit means the pid file is gone, i.e. the process already finished. There is
   * nothing to cancel, so this resolves rather than failing the caller's stop request.
   */
  it('resolves when the process is already gone', async () => {
    const { runner } = makeRunner({
      execScripts: [{ match: (cmd) => cmd.join(' ').includes('kill -'), exitCode: 1 }],
    });
    const handle = await createWorkspace(runner);

    await expect(runner.signal(handle, EXEC_REF, 'TERM')).resolves.toBeUndefined();
  });

  /**
   * A workspace that no longer exists cannot have a running exec either; cancelling it is a no-op
   * rather than an error the UI has to display.
   */
  it('resolves when the container is gone', async () => {
    const { runner } = makeRunner();

    await expect(
      runner.signal({ workspaceId: 'ws-1', runnerRef: 'c-missing' }, EXEC_REF, 'KILL'),
    ).resolves.toBeUndefined();
  });

  /**
   * Any other daemon failure is real and must surface as the runner's typed error.
   */
  it('wraps a daemon failure', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);
    docker.failures.containerExec = new Error('daemon busy');

    await expect(runner.signal(handle, EXEC_REF, 'INT')).rejects.toThrow(DockerRunnerError);
  });
});

describe('DockerWorkspaceRunner.snapshot', () => {
  /**
   * A repository with a branch, a commit, uncommitted changes and a diverged remote produces the
   * full restore hint the next turn is rebuilt from.
   */
  it('captures branch, head, dirtiness and divergence', async () => {
    const { runner, clock } = makeRunner({
      execScripts: [
        { match: (cmd) => cmd.includes('--is-inside-work-tree'), stdout: 'true\n' },
        { match: (cmd) => cmd.includes('--abbrev-ref'), stdout: 'main\n' },
        { match: (cmd) => cmd.join(' ') === 'git rev-parse HEAD', stdout: `${'a'.repeat(40)}\n` },
        { match: (cmd) => cmd.includes('--porcelain'), stdout: ' M f.txt\n' },
        { match: (cmd) => cmd.includes('--left-right'), stdout: '2\t5\n', stderr: 'hint\n' },
        { match: (cmd) => cmd.includes('--stat'), stdout: ' f.txt | 1 +\n' },
      ],
    });
    const handle = await createWorkspace(runner);

    const snapshot = await runner.snapshot(handle);

    expect(snapshot.git).toEqual({
      branch: 'main',
      headSha: 'a'.repeat(40),
      dirty: true,
      ahead: 5,
      behind: 2,
    });
    expect(snapshot.summary).toContain('f.txt');
    expect(snapshot.takenAt).toEqual(clock.now());
  });

  /**
   * A workspace whose `/workspace` was never cloned into is not an error: the snapshot is simply
   * empty, and the restore path treats it as "nothing to carry over".
   */
  it('returns an empty snapshot outside a repository', async () => {
    const { runner } = makeRunner({
      execScripts: [{ match: (cmd) => cmd.includes('--is-inside-work-tree'), exitCode: 128 }],
    });
    const handle = await createWorkspace(runner);

    const snapshot = await runner.snapshot(handle);

    expect(snapshot.git).toEqual({
      branch: null,
      headSha: null,
      dirty: false,
      ahead: 0,
      behind: 0,
    });
    expect(snapshot.summary).toBe('');
  });

  /**
   * Detached HEAD and an unborn branch: `rev-parse --abbrev-ref` answers the literal `HEAD`, and
   * `rev-parse HEAD` fails. Both must degrade to null instead of losing the whole snapshot, and
   * with no branch there is no upstream to compare against.
   */
  it('reports null branch and head on a detached, commitless checkout', async () => {
    const { runner } = makeRunner({
      execScripts: [
        { match: (cmd) => cmd.includes('--is-inside-work-tree'), stdout: 'true\n' },
        { match: (cmd) => cmd.includes('--abbrev-ref'), stdout: 'HEAD\n' },
        { match: (cmd) => cmd.join(' ') === 'git rev-parse HEAD', exitCode: 128 },
      ],
    });
    const handle = await createWorkspace(runner);

    const snapshot = await runner.snapshot(handle);

    expect(snapshot.git.branch).toBeNull();
    expect(snapshot.git.headSha).toBeNull();
    expect(snapshot.git).toMatchObject({ ahead: 0, behind: 0, dirty: false });
  });

  /**
   * A branch with no `origin/` counterpart (never pushed) makes `rev-list` fail; divergence then
   * degrades to zero rather than propagating the failure.
   */
  it('reports zero divergence when the remote branch does not exist', async () => {
    const { runner } = makeRunner({
      execScripts: [
        { match: (cmd) => cmd.includes('--is-inside-work-tree'), stdout: 'true\n' },
        { match: (cmd) => cmd.includes('--abbrev-ref'), stdout: 'feature\n' },
        { match: (cmd) => cmd.includes('--left-right'), exitCode: 128 },
      ],
    });
    const handle = await createWorkspace(runner);

    expect((await runner.snapshot(handle)).git).toMatchObject({ ahead: 0, behind: 0 });
  });

  /**
   * The summary is persisted and streamed, so it is capped. A repository with thousands of changed
   * files must not push a megabyte of text into Postgres.
   */
  it('truncates an oversized summary', async () => {
    const { runner } = makeRunner({
      execScripts: [
        { match: (cmd) => cmd.includes('--is-inside-work-tree'), stdout: 'true\n' },
        { match: (cmd) => cmd.includes('--abbrev-ref'), stdout: 'main\n' },
        { match: (cmd) => cmd.includes('--porcelain'), stdout: 'x'.repeat(20_000) },
      ],
    });
    const handle = await createWorkspace(runner);

    const { summary } = await runner.snapshot(handle);

    expect(Buffer.byteLength(summary, 'utf8')).toBe(16_384);
    expect(summary.endsWith('\n[truncated]')).toBe(true);
  });
});

describe('DockerWorkspaceRunner.destroy', () => {
  /**
   * Destroy stops with a grace period and then removes the container together with its anonymous
   * volumes: nothing the agent wrote may survive the workspace.
   */
  it('stops with a grace period and removes with volumes', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);

    await runner.destroy(handle);

    expect(docker.calls).toContain('stop:c1:t=10');
    expect(docker.calls).toContain('remove:c1:v=true:force=true');
    expect(docker.containers.size).toBe(0);
  });

  /**
   * Idempotence: the worker destroys in a `finally`, and a retried job may destroy a workspace
   * that is already gone. Both the stop and the remove must accept a 404.
   */
  it('resolves when the container is already gone', async () => {
    const { runner } = makeRunner();
    const handle = await createWorkspace(runner);

    await runner.destroy(handle);

    await expect(runner.destroy(handle)).resolves.toBeUndefined();
  });

  /**
   * A container that already exited answers the stop with 304; that is success, and the remove
   * must still run — otherwise the exited container would leak.
   */
  it('continues to remove when the container was already stopped', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);
    docker.failures.containerStop = dockerError(304, 'container already stopped');

    await runner.destroy(handle);

    expect(docker.containers.size).toBe(0);
  });

  /**
   * Any other stop failure is real: reporting success would leave a running container holding the
   * workspace name, and the next create would conflict.
   */
  it('raises a typed error when the stop fails', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);
    docker.failures.containerStop = new Error('daemon busy');

    await expect(runner.destroy(handle)).rejects.toThrow(DockerRunnerError);
  });

  /**
   * Same for the remove: a container that stopped but could not be removed still occupies its name
   * and its disk, so the caller has to learn about it.
   */
  it('raises a typed error when the remove fails', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);
    docker.failures.containerRemove = new Error('device or resource busy');

    await expect(runner.destroy(handle)).rejects.toThrow(DockerRunnerError);
  });
});

describe('DockerWorkspaceRunner.health', () => {
  /**
   * A running container is healthy, and its uptime is measured against the injected clock so the
   * idle-TTL reaper is deterministic.
   */
  it('reports healthy with the uptime measured by the clock', async () => {
    const { runner, clock } = makeRunner();
    const handle = await createWorkspace(runner);
    clock.advance(5_000);

    await expect(runner.health(handle)).resolves.toEqual({ status: 'healthy', uptimeMs: 5_000 });
  });

  /**
   * Clock skew between the host and the daemon can make a container look like it started in the
   * future; a negative uptime would corrupt the idle calculation, so it is clamped at zero.
   */
  it('clamps a negative uptime to zero', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);
    const record = docker.containers.get('c1');
    if (record !== undefined) {
      record.startedAt = '2030-01-01T00:00:00.000Z';
    }

    await expect(runner.health(handle)).resolves.toEqual({ status: 'healthy', uptimeMs: 0 });
  });

  /**
   * A daemon that reports an unparsable start time must still yield a usable health result rather
   * than a `NaN` uptime that would break every comparison downstream.
   */
  it('reports zero uptime when the start time cannot be parsed', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);
    const record = docker.containers.get('c1');
    if (record !== undefined) {
      record.startedAt = 'not-a-date';
    }

    await expect(runner.health(handle)).resolves.toEqual({ status: 'healthy', uptimeMs: 0 });
  });

  /**
   * A container that exited is unhealthy, and the reason carries the status and the exit code so
   * the UI can explain what happened.
   */
  it('reports unhealthy with the status and exit code', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);
    const record = docker.containers.get('c1');
    if (record !== undefined) {
      record.running = false;
      record.exitCode = 137;
    }

    await expect(runner.health(handle)).resolves.toEqual({
      status: 'unhealthy',
      reason: 'status=exited exit=137',
    });
  });

  /**
   * A container the daemon reports without an exit code (killed before it ever ran) must still
   * produce a readable reason instead of an "undefined" leaking into the UI.
   */
  it('reports an unknown exit code explicitly', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);
    const record = docker.containers.get('c1');
    if (record !== undefined) {
      record.running = false;
      record.exitCode = undefined;
    }

    await expect(runner.health(handle)).resolves.toEqual({
      status: 'unhealthy',
      reason: 'status=exited exit=unknown',
    });
  });

  /**
   * An out-of-memory kill is the most common way a workspace dies under a memory ceiling, and it
   * needs its own reason so the user is told to raise the limit rather than to retry.
   */
  it('reports an out-of-memory kill distinctly', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);
    const record = docker.containers.get('c1');
    if (record !== undefined) {
      record.running = false;
      record.oomKilled = true;
    }

    await expect(runner.health(handle)).resolves.toEqual({
      status: 'unhealthy',
      reason: 'oom-killed',
    });
  });

  /**
   * A destroyed or never-created workspace is `gone`, which is what lets the ensure-workspace
   * decision recreate it instead of failing.
   */
  it('reports gone for a container that does not exist', async () => {
    const { runner } = makeRunner();

    await expect(runner.health({ workspaceId: 'ws-1', runnerRef: 'c-missing' })).resolves.toEqual({
      status: 'gone',
    });
  });

  /**
   * A broken daemon is not the same as a missing container and must not be reported as `gone`,
   * which would make the caller destroy state that is still alive.
   */
  it('wraps a non-404 inspection failure', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);
    docker.failures.containerInspect = new Error('daemon unreachable');

    await expect(runner.health(handle)).rejects.toThrow(DockerRunnerError);
  });
});

describe('DockerWorkspaceRunner.list', () => {
  /**
   * The instance label is always part of the filter: several checkouts share one Docker daemon,
   * and a reaper that ignored the instance would destroy another checkout's live workspaces.
   */
  it('always scopes the query to this instance', async () => {
    const { runner, docker } = makeRunner();
    await createWorkspace(runner);

    await runner.list({ 'ah.chat': 'chat-1' });

    expect(docker.calls).toContain('listContainers:ah.instance=test,ah.chat=chat-1');
  });

  /**
   * Selectors narrow the result to one chat's workspace, which is how the chat page finds the
   * container backing it.
   */
  it('returns only the workspaces matching the selector', async () => {
    const { runner } = makeRunner();
    await runner.create(spec());
    await runner.create(spec({ workspaceId: 'ws-2', labels: { 'ah.chat': 'chat-2' } }));

    await expect(runner.list({ 'ah.chat': 'chat-2' })).resolves.toEqual([
      { workspaceId: 'ws-2', runnerRef: 'c2' },
    ]);
    await expect(runner.list({})).resolves.toHaveLength(2);
  });

  /**
   * A container carrying the instance label but no workspace label was not created by this runner
   * (or was created by an older version); it has no handle and must be skipped rather than
   * returned with an empty id that a later destroy would act on.
   */
  it('drops entries without a workspace label', async () => {
    const { runner, docker } = makeRunner();
    docker.containers.set('c9', {
      options: { Labels: { 'ah.instance': 'test' } },
      running: true,
      startedAt: '2026-01-01T00:00:00.000Z',
      oomKilled: false,
      exitCode: 0,
      execCommands: [],
    });

    await expect(runner.list({})).resolves.toEqual([]);
  });

  /**
   * A container with no labels at all belongs to something else entirely (a stray `docker run`);
   * it must neither match the instance filter nor break the listing.
   */
  it('ignores containers carrying no labels', async () => {
    const { runner, docker } = makeRunner();
    docker.containers.set('c8', {
      options: {},
      running: true,
      startedAt: '2026-01-01T00:00:00.000Z',
      oomKilled: false,
      exitCode: 0,
      execCommands: [],
    });

    await expect(runner.list({})).resolves.toEqual([]);
    await expect(runner.health({ workspaceId: 'ws-x', runnerRef: 'c8' })).resolves.toMatchObject({
      status: 'healthy',
    });
  });
});
