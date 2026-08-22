/**
 * Integration tests for {@link DockerWorkspaceRunner} against a real Docker daemon.
 *
 * Layer: integration (tag `@docker`).
 * Goal: prove against a real daemon what the unit suite can only prove against a fake — that the
 * container is actually created with the hardening flags and the resource ceilings, that exec
 * really streams, really accepts stdin, really honours a timeout and a signal, that two workspaces
 * really cannot see each other's filesystem, and that a credential placed for one execution lands
 * where the process that needs it can read it and remove it while never entering the environment
 * any process of the container can read back.
 * Mocks: none. Requires `DOCKER_AVAILABLE=1` and the image built by `pnpm infra:image`.
 *
 * Every test destroys the containers it created; `afterAll` reaps anything left behind under the
 * `ah.instance=test` label so a failed run never leaks a container into the next one.
 */
import { randomUUID } from 'node:crypto';

import Dockerode from 'dockerode';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { resolveInstance } from '../../config/instance.ts';
import { WorkspaceImageMissing } from '../../errors.ts';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '../../testing/canaries.ts';
import type { ExecEvent, WorkspaceHandle, WorkspaceSpec } from '../types.ts';

import { resolveDockerSocket } from './docker-socket.ts';
import { createDockerWorkspaceRunner } from './index.ts';
import { dockerGate } from './testing/docker-available.ts';

const gate = dockerGate();

/**
 * The instance this suite addresses, derived once.
 *
 * All three values below come from the same derivation rather than from three literals, because
 * they have to describe one instance: the image is the tag `pnpm infra:image` wrote for it, and the
 * label and prefix are what this suite reaps by afterwards. Spelled separately, a run without
 * `AH_INSTANCE` would look for one instance's image while labelling its containers with another's
 * name, and report it as an image that does not exist. The documented workflow and the continuous
 * integration job both set `AH_INSTANCE=test`, which is why the three literals agreed until now.
 */
const SUITE = resolveInstance();

/** Instance every container of this suite is labelled with. */
const INSTANCE = SUITE.instance;

/** Container name prefix of this suite. */
const NAME_PREFIX = SUITE.workspaceNamePrefix;

/** Image under test; overridable so the suite can run against a differently tagged build. */
const IMAGE = process.env.WORKSPACE_IMAGE ?? SUITE.workspaceImage;

/** Memory ceiling applied to every workspace of this suite (512 MiB). */
const MEMORY_BYTES = 536_870_912;

/** Process ceiling applied to every workspace of this suite. */
const PIDS_LIMIT = 256;

/** Prompt git uses when it asks for the password of the approved host. */
const PASSWORD_PROMPT = "Password for 'https://x-access-token@github.com': ";

/** Origin every workspace of this suite is created for. */
const APPROVED_ORIGIN = 'https://github.com';

/** Where the runner places the approved origin, and where the askpass helper reads it. */
const ALLOWED_ORIGIN_PATH = '/opt/agent-runtime/allowed-origin';

/** Directory an execution's files are placed into, as the image creates it. */
const HANDOFF_DIR = '/opt/agent-runtime/handoff';

/** Where a turn's credentials are placed, as the worker spells it. */
const CREDENTIALS_PATH = `${HANDOFF_DIR}/credentials.json`;

/** The document the worker writes there, with canaries in place of real credentials. */
const CREDENTIALS = { githubToken: GITHUB_CANARY, openaiApiKey: OPENAI_CANARY };

const decoder = new TextDecoder();

/** Everything one exec produced. */
interface ExecResult {
  /** Reference from the `started` event. */
  execRef: string;
  /** Decoded stdout. */
  stdout: string;
  /** Decoded stderr. */
  stderr: string;
  /** The terminal event. */
  exit: ExecEvent | undefined;
}

if (!gate.run) {
  // Written directly to stderr so the instruction survives any reporter that swallows console
  // output: a skip nobody sees is how a suite quietly stops being run.
  process.stderr.write(`${gate.reason}\n`);
}

(gate.run ? describe : describe.skip)('@docker DockerWorkspaceRunner', () => {
  const runner = createDockerWorkspaceRunner({ instance: INSTANCE, namePrefix: NAME_PREFIX });
  const docker = new Dockerode(resolveDockerSocket().options);
  const created: WorkspaceHandle[] = [];

  /**
   * Builds a workspace spec with a unique id so parallel runs never collide on a container name.
   *
   * @param labels - Extra labels merged into the spec.
   * @returns A spec carrying no credential in its environment, as production carries none.
   */
  function spec(labels: Record<string, string> = { 'ah.chat': 'chat-test' }): WorkspaceSpec {
    return {
      workspaceId: randomUUID(),
      kind: 'CHAT',
      image: IMAGE,
      env: { AH_TEST_VAR: 'visible' },
      files: [{ path: ALLOWED_ORIGIN_PATH, content: `${APPROVED_ORIGIN}\n` }],
      limits: { cpus: 1, memoryBytes: MEMORY_BYTES, pids: PIDS_LIMIT },
      labels,
    };
  }

  /**
   * Creates a workspace and registers it for teardown.
   *
   * @param labels - Extra labels for the workspace.
   * @returns The handle of the created workspace.
   */
  async function workspace(labels?: Record<string, string>): Promise<WorkspaceHandle> {
    const handle = await runner.create(spec(labels));
    created.push(handle);
    return handle;
  }

  /**
   * Drains an exec, optionally acting once the process has announced itself on stdout.
   *
   * @param events - The exec's event stream.
   * @param onOutput - Called with the stdout accumulated so far and the exec reference.
   * @returns The exec's reference, decoded output and terminal event.
   */
  async function collect(
    events: AsyncIterable<ExecEvent>,
    onOutput?: (stdout: string, execRef: string) => void,
  ): Promise<ExecResult> {
    let execRef = '';
    let stdout = '';
    let stderr = '';
    let exit: ExecEvent | undefined;

    for await (const event of events) {
      if (event.type === 'started') {
        execRef = event.execRef;
      }
      if (event.type === 'stdout') {
        stdout += decoder.decode(event.data);
        onOutput?.(stdout, execRef);
      }
      if (event.type === 'stderr') {
        stderr += decoder.decode(event.data);
      }
      if (event.type === 'exit') {
        exit = event;
      }
    }

    return { execRef, stdout, stderr, exit };
  }

  /**
   * Runs one command in a workspace and returns everything it produced.
   *
   * @param handle - Workspace to run in.
   * @param cmd - Argument vector.
   * @returns The exec result.
   */
  async function run(handle: WorkspaceHandle, cmd: readonly string[]): Promise<ExecResult> {
    return collect(runner.exec(handle, { cmd }));
  }

  /**
   * Runs one command with a credentials file placed for it, the way a turn runs.
   *
   * @param handle - Workspace to run in.
   * @param cmd - Argument vector.
   * @returns The exec result.
   */
  async function runWithCredentials(
    handle: WorkspaceHandle,
    cmd: readonly string[],
  ): Promise<ExecResult> {
    return collect(
      runner.exec(handle, {
        cmd,
        files: [{ path: CREDENTIALS_PATH, content: JSON.stringify(CREDENTIALS) }],
      }),
    );
  }

  beforeAll(async () => {
    // Fail with a clear instruction rather than with a dozen confusing container errors.
    await docker.getImage(IMAGE).inspect();
  });

  afterEach(async () => {
    const handles = created.splice(0, created.length);
    await Promise.all(handles.map(async (handle) => runner.destroy(handle)));
  });

  afterAll(async () => {
    const leftovers = await runner.list({});
    await Promise.all(leftovers.map(async (handle) => runner.destroy(handle)));
  });

  /**
   * The lifecycle entry point: a created workspace is immediately usable, and its uptime is
   * measured from the container's own start time.
   */
  it('creates a workspace that reports itself healthy', async () => {
    const handle = await workspace();

    const health = await runner.health(handle);

    expect(health.status).toBe('healthy');
    expect(health).toMatchObject({ uptimeMs: expect.any(Number) as number });
  });

  /**
   * The event contract over a real hijacked connection: `started` first, the process's stdout
   * demuxed out of Docker's frame format, then the exit code.
   */
  it('streams stdout and the exit code', async () => {
    const handle = await workspace();

    const result = await run(handle, ['echo', 'hello']);

    expect(result.execRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.stdout).toBe('hello\n');
    expect(result.exit).toEqual({ type: 'exit', code: 0 });
  });

  /**
   * Stdin has to be written AND closed: `cat` only exits when it sees EOF, so this fails by
   * hanging if the runner ever stops half-closing the stream.
   */
  it('writes stdin and closes it so the process can exit', async () => {
    const handle = await workspace();

    const result = await collect(runner.exec(handle, { cmd: ['cat'], stdin: 'ping' }));

    expect(result.stdout).toBe('ping');
    expect(result.exit).toEqual({ type: 'exit', code: 0 });
  });

  /**
   * A failing command reports its code as data, and the working directory the caller asked for is
   * the one the process runs in.
   */
  it('reports a non-zero exit and honours the working directory', async () => {
    const handle = await workspace();

    const failure = await run(handle, ['sh', '-c', 'exit 3']);
    const cwd = await collect(runner.exec(handle, { cmd: ['pwd'], cwd: '/tmp' }));

    expect(failure.exit).toEqual({ type: 'exit', code: 3 });
    expect(cwd.stdout.trim()).toBe('/tmp');
  });

  /**
   * The wall-clock limit must kill the process inside the container and leave the container itself
   * alive — a turn that times out is followed by more turns in the same workspace.
   */
  it('times out a long command and leaves the workspace usable', async () => {
    const handle = await workspace();

    const timedOut = await collect(runner.exec(handle, { cmd: ['sleep', '30'], timeoutMs: 1_000 }));
    const after = await run(handle, ['echo', 'ok']);

    expect(timedOut.exit).toEqual({ type: 'exit', code: null, signal: 'TIMEOUT' });
    expect(after.stdout).toBe('ok\n');
    expect((await runner.health(handle)).status).toBe('healthy');
  });

  /**
   * Cancellation must reach the real process: the pid file recorded by the exec wrapper is the
   * only way to signal it, because the exec's pid is a host pid with no meaning inside the
   * container. The process traps INT and exits 130, proving the signal was delivered.
   */
  it('delivers a signal to the running process', async () => {
    const handle = await workspace();
    let signalled = false;

    const result = await collect(
      runner.exec(handle, {
        cmd: [
          'sh',
          '-c',
          'trap "echo got-int; exit 130" INT; echo ready; while :; do sleep 0.2; done',
        ],
      }),
      (stdout, execRef) => {
        if (!signalled && stdout.includes('ready')) {
          signalled = true;
          void runner.signal(handle, execRef, 'INT');
        }
      },
    );

    expect(result.stdout).toContain('got-int');
    expect(result.exit).toEqual({ type: 'exit', code: 130 });
  });

  /**
   * The snapshot is the only trace of the work that survives a destroyed workspace, so it is taken
   * against a real repository: branch, head sha, dirtiness and the summary naming the changed file.
   */
  it('snapshots a real git repository', async () => {
    const handle = await workspace();
    const setup = await run(handle, [
      'sh',
      '-c',
      'git init -b main -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && echo x > f.txt',
    ]);
    expect(setup.exit).toEqual({ type: 'exit', code: 0 });

    const snapshot = await runner.snapshot(handle);

    expect(snapshot.git.branch).toBe('main');
    expect(snapshot.git.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.git).toMatchObject({ dirty: true, ahead: 0, behind: 0 });
    expect(snapshot.summary).toContain('f.txt');
  });

  /**
   * Destroy removes the container for good, and a second destroy is a no-op — the worker calls it
   * from a `finally`, and a retried job must not fail on an already-destroyed workspace.
   */
  it('destroys the workspace idempotently', async () => {
    const handle = await runner.create(spec());

    await runner.destroy(handle);

    expect(await runner.health(handle)).toEqual({ status: 'gone' });
    await expect(runner.destroy(handle)).resolves.toBeUndefined();
  });

  /**
   * Discovery by label is how the reaper and the chat page find a workspace; the selector must
   * narrow to one chat while an empty selector still returns everything of this instance.
   */
  it('lists workspaces by label', async () => {
    const first = await workspace({ 'ah.chat': 'chat-a' });
    const second = await workspace({ 'ah.chat': 'chat-b' });

    const onlyA = await runner.list({ 'ah.chat': 'chat-a' });
    const all = await runner.list({});

    expect(onlyA).toEqual([{ workspaceId: first.workspaceId, runnerRef: first.runnerRef }]);
    expect(all.map((entry) => entry.workspaceId)).toEqual(
      expect.arrayContaining([first.workspaceId, second.workspaceId]),
    );
  });

  /**
   * Isolation is the whole point of a workspace: two of them share no filesystem, so nothing one
   * agent writes can be read — or tampered with — by another.
   */
  it('gives each workspace its own filesystem', async () => {
    const a = await workspace();
    const b = await workspace();

    await run(a, ['sh', '-c', 'echo secret > /workspace/only-a']);
    const listing = await run(b, ['ls', '/workspace']);

    expect(listing.stdout).not.toContain('only-a');
  });

  /**
   * Two workspaces of the same instance share a network and still cannot address each other.
   *
   * Regression, and the one assertion the unit suite cannot make: the flag has to reach the
   * kernel, not just the create options. Every workspace used to sit on the default `bridge`,
   * where the neighbour answers — a refusal from a closed port is an answer, and it is what this
   * test saw before the change. With traffic between members disabled the packets are dropped
   * instead, so the connection attempt runs out its own timeout with no reply at all.
   *
   * Egress is asserted in the same breath, because a network that isolated the workspaces by
   * cutting them off from everything would pass the first half and break every clone.
   */
  it('keeps two workspaces of one instance from reaching each other, and keeps egress', async () => {
    const a = await workspace();
    const b = await workspace();
    const info = await docker.getContainer(a.runnerRef).inspect();
    const address = Object.values(info.NetworkSettings.Networks)[0]?.IPAddress;

    const probe = (host: string, port: number): readonly string[] => [
      'node',
      '-e',
      `const s = require('net').connect({ host: ${JSON.stringify(host)}, port: ${String(port)}, timeout: 3000 });` +
        `s.on('connect', () => { console.log('ANSWERED:connected'); process.exit(0); });` +
        `s.on('timeout', () => { console.log('SILENT'); process.exit(0); });` +
        `s.on('error', (e) => { console.log('ANSWERED:' + e.code); process.exit(0); });`,
    ];

    expect(address).toBeTruthy();
    const neighbour = await run(b, probe(String(address), 22));
    expect(neighbour.stdout.trim()).toBe('SILENT');

    const outward = await run(b, probe('1.1.1.1', 443));
    expect(outward.stdout.trim()).toBe('ANSWERED:connected');
  });

  /**
   * The hardening the container spec promises, read back from the daemon. This is the assertion
   * that would catch a regression the unit suite cannot see: a flag Docker silently ignores, a
   * mount that slipped in, or a ceiling that never reached the kernel.
   */
  it('applies the resource ceilings and the hardening flags', async () => {
    const handle = await workspace();

    const info = await docker.getContainer(handle.runnerRef).inspect();

    expect(info.HostConfig.Memory).toBe(MEMORY_BYTES);
    expect(info.HostConfig.PidsLimit).toBe(PIDS_LIMIT);
    expect(info.HostConfig.NanoCpus).toBe(1_000_000_000);
    expect(info.HostConfig.CapDrop).toContain('ALL');
    expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(info.HostConfig.Tmpfs?.['/tmp']).toBeDefined();
    expect(info.HostConfig.NetworkMode).toBe(`ah-ws-${INSTANCE}`);
    expect(info.HostConfig.Init).toBe(true);
    expect(info.HostConfig.Binds ?? []).toEqual([]);
    expect(info.Mounts).toEqual([]);
    expect(info.Config.User).toBe('agent');
    expect(info.Config.Labels['ah.instance']).toBe(INSTANCE);
  });

  /**
   * Configuration lives in the container's environment. The process sees it; the image — which is
   * shared, cached and inspectable by anything on the host — must not.
   */
  it('injects the environment into the container but never into the image', async () => {
    const handle = await workspace();

    const value = await run(handle, ['printenv', 'AH_TEST_VAR']);
    const image = await docker.getImage(IMAGE).inspect();

    expect(value.stdout.trim()).toBe('visible');
    for (const entry of image.Config.Env) {
      expect(entry).not.toMatch(/AH_TEST_VAR|TOKEN|KEY|SECRET/i);
    }
    assertNoCanary(JSON.stringify(image));
  });

  /**
   * The finding this arrangement exists for, measured rather than argued. Every process of a
   * workspace runs as the one unprivileged user, so `/proc/1/environ` is an ordinary readable file
   * for the shell tool — and PID 1 lives as long as the container. A credential put there is a
   * credential the agent can read at any point in any turn, so nothing puts one there.
   */
  it('carries no credential in the environment PID 1 exposes for the life of the container', async () => {
    const handle = await workspace();

    const environ = await runWithCredentials(handle, [
      'sh',
      '-c',
      'cat /proc/1/environ | tr "\\0" "\\n"',
    ]);

    expect(environ.exit).toEqual({ type: 'exit', code: 0 });
    // The read succeeded, so the absence below is absence and not a failed command.
    expect(environ.stdout).toContain('AH_TEST_VAR=visible');
    expect(environ.stdout).not.toContain('GITHUB_TOKEN');
    expect(environ.stdout).not.toContain('OPENAI_API_KEY');
    assertNoCanary(environ.stdout);
  });

  /**
   * How the credential gets in instead: a file placed for one execution, in a directory the
   * workspace user owns so the process that reads it can also take it away. Everything here is a
   * property of the running container rather than of the archive the runner built — the ownership
   * that makes it readable, the directory permissions that make it removable, and the fact that
   * the next execution finds nothing.
   */
  it('places an execution credential the workspace can read and remove, and nothing keeps it', async () => {
    const handle = await workspace();

    const placed = await runWithCredentials(handle, [
      'sh',
      '-c',
      `stat -c "%U %a" ${CREDENTIALS_PATH}; stat -c "%U %a" ${HANDOFF_DIR}; cat ${CREDENTIALS_PATH}; rm ${CREDENTIALS_PATH} && echo removed`,
    ]);
    const afterwards = await run(handle, ['ls', '-A', HANDOFF_DIR]);

    expect(placed.stdout).toContain('root 644');
    expect(placed.stdout).toContain('agent 700');
    expect(placed.stdout).toContain(GITHUB_CANARY);
    expect(placed.stdout).toContain('removed');
    expect(afterwards.stdout.trim()).toBe('');
  });

  /**
   * The policy the credential helper enforces must be one the workspace cannot restate. The
   * workspace user runs every command in this container, so the test is the direct one: try to
   * rewrite the file, try to unlink it and put another in its place, then ask the helper for a
   * foreign origin both plainly and with the old environment variable set. Root ownership of the
   * file and of the directory around it is what makes all four fail — and unlink is governed by
   * the directory's write bit, not by the file's owner, which is why the directory matters as much
   * as the file.
   */
  it('places the approved origin where the workspace can read it and cannot author it', async () => {
    const handle = await workspace();

    const content = await run(handle, ['cat', ALLOWED_ORIGIN_PATH]);
    const owners = await run(handle, ['sh', '-c', `stat -c "%U %a" ${ALLOWED_ORIGIN_PATH}`]);
    const overwrite = await run(handle, [
      'sh',
      '-c',
      `printf 'https://evil.test\n' > ${ALLOWED_ORIGIN_PATH}`,
    ]);
    const replace = await run(handle, [
      'sh',
      '-c',
      `rm -f ${ALLOWED_ORIGIN_PATH} 2>/dev/null || true; printf 'https://evil.test\n' > ${ALLOWED_ORIGIN_PATH}`,
    ]);
    const stillApproved = await run(handle, ['cat', ALLOWED_ORIGIN_PATH]);
    const foreign = await run(handle, [
      'sh',
      '-c',
      'AH_GIT_ALLOWED_ORIGIN=https://evil.test ALLOWED_ORIGIN_FILE=/tmp/mine /opt/agent-runtime/askpass.sh "$1"',
      'sh',
      "Password for 'https://evil.test': ",
    ]);

    expect(content.stdout).toBe(`${APPROVED_ORIGIN}\n`);
    expect(owners.stdout.trim()).toBe('root 644');
    expect(overwrite.exit).not.toEqual({ type: 'exit', code: 0 });
    expect(replace.exit).not.toEqual({ type: 'exit', code: 0 });
    expect(stillApproved.stdout).toBe(`${APPROVED_ORIGIN}\n`);
    expect(foreign.stdout).toBe('');
    expect(foreign.exit).not.toEqual({ type: 'exit', code: 0 });
    assertNoCanary(foreign.stdout + foreign.stderr);
  });

  /**
   * The askpass helper is what lets git authenticate without the token ever entering the shell
   * tool's environment: it reads the tmpfs file the runtime writes for the duration of a turn, and
   * answers the username prompt with GitHub's fixed token username. There is no environment
   * fallback — a variable is something the model's own command can set, and nothing puts the PAT
   * in one any more, so a prompt answered from `GITHUB_TOKEN` would be a prompt answered from
   * whatever the workspace chose.
   */
  it('releases the token through askpass, from the file and never from the environment', async () => {
    const handle = await workspace();

    const fromFile = await run(handle, [
      'sh',
      '-c',
      `printf %s '${GITHUB_CANARY}' > /tmp/tok && AH_GIT_TOKEN_FILE=/tmp/tok /opt/agent-runtime/askpass.sh "$1"`,
      'sh',
      PASSWORD_PROMPT,
    ]);
    const fromEnv = await run(handle, [
      'sh',
      '-c',
      `GITHUB_TOKEN='${GITHUB_CANARY}' /opt/agent-runtime/askpass.sh "$1"`,
      'sh',
      PASSWORD_PROMPT,
    ]);
    const username = await run(handle, [
      'sh',
      '-c',
      '/opt/agent-runtime/askpass.sh "$1"',
      'sh',
      "Username for 'https://github.com': ",
    ]);

    expect(fromFile.stdout).toBe(`${GITHUB_CANARY}\n`);
    expect(fromEnv.stdout).toBe('');
    expect(fromEnv.exit).not.toEqual({ type: 'exit', code: 0 });
    expect(username.stdout).toBe('x-access-token\n');
  });

  /**
   * GIT_ASKPASS is the only thing standing between the workspace and the PAT, and the workspace
   * runs commands a model chose while reading untrusted repository content. Ownership of the
   * directory is what enforces that: unlink and create are governed by the directory's write bit,
   * not by the file's owner, so an `agent`-owned `/opt/agent-runtime` would let the workspace
   * delete the helper and drop in one that logs the token on the next git prompt — no bypass of
   * the host check required. Asserted here because a single `chown -R` in the Dockerfile silently
   * reopens it.
   */
  it('keeps the runtime directory unwritable by the workspace user', async () => {
    const handle = await workspace();

    const replace = await run(handle, [
      'sh',
      '-c',
      'rm -f /opt/agent-runtime/askpass.sh 2>/dev/null || true; printf "#!/bin/sh\\necho pwned\\n" > /opt/agent-runtime/askpass.sh',
    ]);
    const stillOriginal = await run(handle, [
      'sh',
      '-c',
      `printf %s '${GITHUB_CANARY}' > /tmp/tok && AH_GIT_TOKEN_FILE=/tmp/tok /opt/agent-runtime/askpass.sh "$1"`,
      'sh',
      PASSWORD_PROMPT,
    ]);
    const owners = await run(handle, ['sh', '-c', 'stat -c "%U %a" /opt/agent-runtime']);

    expect(replace.exit).not.toEqual({ type: 'exit', code: 0 });
    expect(stillOriginal.stdout).toBe(`${GITHUB_CANARY}\n`);
    expect(owners.stdout.trim()).toBe('root 755');
  });

  /**
   * Nothing is pulled or built implicitly, so an absent image must be a typed error carrying the
   * exact command that fixes it.
   */
  it('reports a missing image with the build command', async () => {
    await expect(
      runner.create({ ...spec(), image: 'agent-hangar/does-not-exist:nope' }),
    ).rejects.toThrow(WorkspaceImageMissing);
  });

  /**
   * The same question asked without starting anything, which is what the boot check and the health
   * card need: against a real daemon, a built image is present and an invented tag is not. The
   * fake can only prove the runner's half of that; the 404 the daemon actually returns for an
   * unknown reference is what makes the answer `false` rather than an error.
   */
  it('answers imageExists against the real daemon', async () => {
    expect(await runner.imageExists(IMAGE)).toBe(true);
    expect(await runner.imageExists('agent-hangar/does-not-exist:nope')).toBe(false);
  });

  /**
   * The image's own promises: an unprivileged uid, and the toolchain an agent needs to work in a
   * repository. A missing tool would only surface as a confusing command failure mid-turn.
   */
  it('ships an unprivileged user and the expected toolchain', async () => {
    const handle = await workspace();

    const uid = await run(handle, ['id', '-u']);
    const tools = await run(handle, [
      'sh',
      '-c',
      'git --version && rg --version && jq --version && python3 --version && node --version && command -v pnpm',
    ]);

    expect(uid.stdout.trim()).toBe('1001');
    expect(tools.exit).toEqual({ type: 'exit', code: 0 });
    expect(tools.stdout).toContain('v24.');
  });
});
