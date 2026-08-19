/**
 * Unit tests for the process-facing methods of {@link DockerWorkspaceRunner}.
 *
 * Layer: unit.
 * Goal: the exec event contract over a faked hijacked stream — `started` first, output in order,
 * exactly one terminal event — together with the paths that are hard to observe against a real
 * daemon: the wall-clock timeout, the caller abort, the kill fallback when the pid file cannot be
 * used, a container that vanished mid-turn, signal delivery, and the git snapshot degrading to
 * nulls and zeros for every ordinary-but-awkward repository state.
 * Mocks: `FakeDockerApi`, `FakeClock`, an immediate timer seam and a fixed exec reference, all
 * from the shared runner fixture.
 */
import { describe, expect, it, vi } from 'vitest';

import { CANARY_MARKER, GITHUB_CANARY } from '../../testing/canaries.js';

import { DockerRunnerError } from './errors.js';
import {
  createFixtureWorkspace as createWorkspace,
  drainExec as drain,
  FIXTURE_EXEC_REF as EXEC_REF,
  makeRunnerFixture as makeRunner,
} from './testing/runner-fixture.js';

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
   * Any other exec setup failure is a real fault and must propagate — the worker retries or fails
   * the turn instead of silently reporting an empty result — and it propagates as the runner's
   * typed error, so the API layer maps it to a code rather than to an unknown internal failure.
   */
  it('propagates a non-404 exec failure', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);
    docker.failures.containerExec = new Error('exec limit reached');

    const failure = drain(runner.exec(handle, { cmd: ['echo'] }));

    await expect(failure).rejects.toThrow(DockerRunnerError);
    await expect(failure).rejects.toThrow(/exec .* failed in workspace/);
  });
  /**
   * A failure the runner raised itself — here an invalid per-exec environment key — is passed
   * through untouched. Re-wrapping it would bury the precise reason under a generic one, and the
   * message must stay free of the value, which is where a credential would sit.
   */
  it('passes its own typed failures through unchanged', async () => {
    const { runner } = makeRunner();
    const handle = await createWorkspace(runner);

    let raised: Error | undefined;
    try {
      await drain(runner.exec(handle, { cmd: ['echo'], env: { 'BAD-KEY': GITHUB_CANARY } }));
    } catch (error) {
      raised = error as Error;
    }

    expect(raised).toBeInstanceOf(DockerRunnerError);
    expect(raised?.message).toContain('invalid environment variable name "BAD-KEY"');
    expect(raised?.message).not.toContain(CANARY_MARKER);
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
