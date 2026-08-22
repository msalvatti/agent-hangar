/**
 * Unit tests for the lifecycle methods of {@link DockerWorkspaceRunner}.
 *
 * Layer: unit.
 * Goal: every branch of `create`, `destroy`, `health` and `list` against an in-memory Docker API —
 * the image gate, the hardened create options, readiness and its two failure exits with their
 * cleanup, idempotent teardown, the health state mapping, and the instance scoping that keeps one
 * checkout's reaper away from another's containers. Also pins the standing secret invariant: no
 * environment VALUE reaches an error message or a serialisation of the runner.
 * Mocks: `FakeDockerApi`, `FakeClock`, an immediate timer seam and a fixed exec reference, all
 * from the shared runner fixture.
 */
import { describe, expect, it } from 'vitest';

import { WorkspaceImageMissing } from '../../errors.ts';
import { CANARY_MARKER } from '../../testing/canaries.ts';

import { buildNetworkCreateOptions } from './container-spec.ts';
import { DockerWorkspaceRunner } from './docker-workspace-runner.ts';
import { DockerRunnerError } from './errors.ts';
import { dockerError, FakeDockerApi } from './testing/fake-docker-api.ts';
import {
  createFixtureWorkspace as createWorkspace,
  drainExec as drain,
  FIXTURE_IMAGE as IMAGE,
  fixtureSpec as spec,
  makeRunnerFixture as makeRunner,
} from './testing/runner-fixture.ts';

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
   * The workspace joins this instance's own network, and the runner creates that network on the
   * way in rather than assuming somebody else did.
   *
   * Regression: workspaces joined the default `bridge`, where each one could address every other
   * container on the host by IP. The network is created before the container that needs it,
   * because Docker refuses to create a container for a network that is not there.
   */
  it('creates the instance network before the container joins it', async () => {
    const { runner, docker } = makeRunner();

    await createWorkspace(runner);

    expect(docker.networkOptions).toEqual([
      {
        Name: 'ah-ws-test',
        Driver: 'bridge',
        Options: { 'com.docker.network.bridge.enable_icc': 'false' },
        Labels: { 'ah.instance': 'test' },
      },
    ]);
    expect(docker.containers.get('c1')?.options.HostConfig?.NetworkMode).toBe('ah-ws-test');
    expect(docker.calls.indexOf('createNetwork:ah-ws-test')).toBeLessThan(
      docker.calls.indexOf('createContainer:ah-ws-test-ws-1'),
    );
  });

  /**
   * The network already being there is the ordinary case, and it is not recreated.
   *
   * The name filter the daemon applies is a substring match, so a longer name containing this
   * instance's is not this instance's network: `ah-ws-test-two` must not satisfy `ah-ws-test`.
   */
  it('reuses an existing network and is not fooled by a longer name', async () => {
    const { runner, docker } = makeRunner();
    docker.networks.set('ah-ws-test-two', buildNetworkCreateOptions('test-two'));

    await createWorkspace(runner);

    expect(docker.networkOptions.map((options) => options.Name)).toEqual(['ah-ws-test']);

    docker.networkOptions.length = 0;
    await runner.create(spec({ workspaceId: 'ws-2' }));

    expect(docker.networkOptions).toStrictEqual([]);
  });

  /**
   * A network that carries this name but not the isolation is refused, not adopted.
   *
   * Reuse is by name, and a name is not evidence: a network created by hand, or by an earlier
   * version of these options, would be joined silently and every workspace on it could address
   * every other. The check reads the option back and fails the create naming the network, because
   * running unisolated is the outcome this whole network exists to prevent.
   */
  it('refuses a network of the right name that does not isolate its members', async () => {
    const { runner, docker } = makeRunner();
    docker.networks.set('ah-ws-test', { Name: 'ah-ws-test', Driver: 'bridge' });

    await expect(createWorkspace(runner)).rejects.toThrow(/ah-ws-test/);
    expect(docker.containers.size).toBe(0);
    expect(docker.networkOptions).toStrictEqual([]);
  });

  /**
   * Two workspaces created at the same moment both find the network missing and both try to make
   * it. The daemon gives the loser a 409, which reports the state it was asking for, so the loser
   * carries on rather than failing a workspace over a race it effectively won.
   */
  it('treats a lost race to create the network as success', async () => {
    const { runner, docker } = makeRunner();

    const both = await Promise.all([
      runner.create(spec({ workspaceId: 'ws-1' })),
      runner.create(spec({ workspaceId: 'ws-2' })),
    ]);

    expect(both.map((handle) => handle.workspaceId)).toEqual(['ws-1', 'ws-2']);
    expect(docker.calls.filter((call) => call === 'createNetwork:ah-ws-test')).toHaveLength(2);
    expect(docker.networkOptions).toHaveLength(1);
  });

  /**
   * Any other refusal is a workspace that would have run unisolated, so it fails the create
   * instead: a container is never made for a network the daemon would not provide.
   */
  it('fails the create when the network cannot be made', async () => {
    const { runner, docker } = makeRunner();
    docker.failures.createNetwork = dockerError(500, 'daemon is unhappy');

    await expect(createWorkspace(runner)).rejects.toThrow(DockerRunnerError);
    expect(docker.containers.size).toBe(0);
  });

  /**
   * A file the workspace must not be able to restate has to be in place before the workspace has
   * run anything at all. Placed after `start`, the first process would see whatever was there
   * before — or nothing — and a policy read at that moment would be the wrong one.
   */
  it('places the spec files before the container is started', async () => {
    const { runner, docker } = makeRunner();

    await createWorkspace(runner, {
      files: [{ path: '/opt/agent-runtime/allowed-origin', content: 'https://github.com\n' }],
    });

    const record = docker.containers.get('c1');
    expect(record?.archives).toHaveLength(1);
    expect(record?.archives[0]?.path).toBe('/opt/agent-runtime');
    expect(record?.archivesAfterStart).toStrictEqual([false]);
    expect(docker.calls).toContain('putArchive:c1:/opt/agent-runtime');
  });

  /**
   * Nothing is uploaded for a spec that names no files, so the ordinary create makes exactly the
   * daemon calls it always made.
   */
  it('uploads nothing when the spec names no files', async () => {
    const { runner, docker } = makeRunner();

    await createWorkspace(runner);

    expect(docker.containers.get('c1')?.archives).toStrictEqual([]);
    expect(docker.calls.some((call) => call.startsWith('putArchive:'))).toBe(false);
  });

  /**
   * A file that cannot be placed leaves a container that must not be handed out: the workspace
   * would run without the policy it is supposed to be bound by. It is discarded like any other
   * failure between create and readiness, so the workspace name is free for the retry.
   */
  it('discards the container when a file cannot be placed', async () => {
    const { runner, docker } = makeRunner();
    docker.failures.containerPutArchive = dockerError(500, 'no such directory');

    await expect(
      createWorkspace(runner, {
        files: [{ path: '/opt/agent-runtime/allowed-origin', content: 'https://github.com\n' }],
      }),
    ).rejects.toThrow('no such directory');

    expect(docker.containers.has('c1')).toBe(false);
    expect(docker.calls.some((call) => call.startsWith('start:'))).toBe(false);
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
   * The boot probe and the health card need the same answer without creating anything, and they
   * need it before a first workspace has ever run — which is the whole point of asking the daemon
   * instead of remembering what the last create observed.
   */
  it('reports image presence and absence without creating anything', async () => {
    const { runner, docker } = makeRunner();

    expect(await runner.imageExists(IMAGE)).toBe(true);
    expect(await runner.imageExists('agent-hangar/workspace:nope')).toBe(false);
    expect(docker.calls.some((call) => call.startsWith('createContainer'))).toBe(false);
  });

  /**
   * A daemon that cannot answer is not the same as an image that is absent: reporting it as
   * absence would tell an operator to rebuild an image they already have, and hide the outage that
   * actually needs fixing. It has to travel as the failure it is.
   */
  it('raises rather than reporting absence when the image cannot be inspected', async () => {
    const { runner, docker } = makeRunner();
    docker.failures.imageInspect = new Error('daemon unreachable');

    await expect(runner.imageExists(IMAGE)).rejects.toThrow(DockerRunnerError);
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
   * Security invariant: whatever `spec.env` carries may reach the daemon and nothing else — not a
   * thrown message on any failure path, and not a serialisation of the runner, which is why the
   * runner keeps all of its state (including the Docker client) in private fields. Credentials no
   * longer travel this way, but the operator's configuration does, and the rule is about the
   * channel rather than about one value.
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
   * The real back-off runs when no delay is injected. Exercised with a zero interval and a probe
   * that never succeeds, so the default path is covered without spending wall-clock time.
   */
  it('uses the real delay between readiness attempts by default', async () => {
    const docker = new FakeDockerApi({
      images: [IMAGE],
      execScripts: [{ match: (cmd) => cmd[0] === 'true', exitCode: 1 }],
    });
    const runner = new DockerWorkspaceRunner({
      docker,
      instance: 'test',
      namePrefix: 'ah-ws-test-',
      readiness: { attempts: 2, delayMs: 0 },
    });

    await expect(runner.create(spec())).rejects.toThrow('workspace did not become ready');
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
   * Destroying a workspace has several callers by design — the teardown of the turn that owned it,
   * the collector's orphan pass, the operator's reaper — so two of them can act on the same
   * container. The daemon answers the second one `409 removal already in progress`, which is this
   * method's own goal being met by somebody else. Treated as a failure it made the collector
   * report every concurrently reaped workspace as a failed teardown.
   */
  it('resolves when another remover is already destroying the container', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);
    docker.failures.containerRemove = dockerError(409, 'removal already in progress');

    await expect(runner.destroy(handle)).resolves.toBeUndefined();
  });

  /**
   * The stop is subject to the same race one call earlier: a container the daemon has already
   * begun removing refuses to be stopped, and there is nothing left to stop.
   */
  it('continues past a stop refused because a removal is under way', async () => {
    const { runner, docker } = makeRunner();
    const handle = await createWorkspace(runner);
    docker.failures.containerStop = dockerError(409, 'removal already in progress');

    await runner.destroy(handle);

    expect(docker.containers.size).toBe(0);
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
      archives: [],
      archivesAfterStart: [],
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
      archives: [],
      archivesAfterStart: [],
    });

    await expect(runner.list({})).resolves.toEqual([]);
    await expect(runner.health({ workspaceId: 'ws-x', runnerRef: 'c8' })).resolves.toMatchObject({
      status: 'healthy',
    });
  });
});
