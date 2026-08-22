/**
 * Unit tests for workspace provisioning.
 *
 * Layer: unit.
 * Goal: the row precedes the container, no credential is decrypted or injected here at all — a
 * workspace outlives the turn that created it, so the two travel per execution instead — the
 * labels carry the run the workspace serves, and each failure closes the row out with the right
 * reason — with only an unreachable daemon rethrown. Plus the
 * one failure that cannot be closed out by anybody else: a reference the row refused to record,
 * and the forge allow-list, which is applied again here because a stored URL is cloned long after
 * the route that vetted it and because it is what binds the container to one origin.
 * Mocks: `createTestContainer` plus runner subclasses for the failures the fake cannot produce.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceImageMissing } from '@agent-hangar/core';
import type { WorkspaceHandle, WorkspaceSpec } from '@agent-hangar/core';
import { FakeWorkspaceRunner, GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FAKE_SCRIPT_ENV_KEY, fakeProviderScriptEnv } from '../fake-provider-script.js';
import { createTestContainer, FakeSecretsService } from '../testing/index.js';
import type { TestContainer } from '../testing/index.js';

import { ALLOWED_ORIGIN_PATH, SECRETS_MISSING_REASON } from './constants.js';
import {
  provisionWorkspace,
  REPO_URL_NOT_ALLOWED_REASON,
  UNRECORDED_WORKSPACE_REASON,
} from './provision-workspace.js';

/** A supplied script, in the shape a caller writes on disk. */
const SCRIPT = {
  default: [
    {
      events: [
        { type: 'text.done', text: 'Answered from the supplied script.' },
        { type: 'response.done', responseId: 'fake-1', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    },
  ],
};

/** Directory the supplied script is written into, and the file inside it. */
let scriptDirectory: string;
let scriptPath: string;

beforeAll(() => {
  scriptDirectory = mkdtempSync(join(tmpdir(), 'ah-provision-script-'));
  scriptPath = join(scriptDirectory, 'script.json');
  writeFileSync(scriptPath, JSON.stringify(SCRIPT), 'utf8');
});

afterAll(() => {
  rmSync(scriptDirectory, { recursive: true, force: true });
});

/** A runner whose `create` always rejects with the given failure. */
class FailingRunner extends FakeWorkspaceRunner {
  constructor(private readonly failure: unknown) {
    super();
  }

  override async create(): Promise<WorkspaceHandle> {
    await Promise.resolve();
    throw this.failure;
  }
}

/** The workspace spec of the recorded `create`. */
function createSpec(container: TestContainer): WorkspaceSpec {
  return container.runner.calls.find((call) => call.method === 'create')?.args[0] as WorkspaceSpec;
}

describe('provisionWorkspace', () => {
  /**
   * The write that records the container is the last holder of its reference. If it is refused,
   * the row stays `CREATING` — which the collector reads as an in-flight create it must not close
   * out — while the container keeps the same workspace id, so the orphan sweep does not see it as
   * unowned either. Nothing would ever reclaim the pair, and that container's environment holds
   * both credentials, so it is destroyed here and the row is closed out.
   */
  it('destroys the container when its reference cannot be recorded', async () => {
    const container = createTestContainer();
    const setStatus = container.repos.workspaces.setStatus.bind(container.repos.workspaces);
    vi.spyOn(container.repos.workspaces, 'setStatus').mockImplementation(
      async (id, status, update) => {
        if (status === 'READY') {
          throw new Error('database is down');
        }
        return setStatus(id, status, update);
      },
    );

    await expect(
      provisionWorkspace(container, {
        kind: 'CHAT',
        chatId: 'chat-1',
        repoUrl: 'https://github.com/octocat/Hello-World',
        branch: 'main',
      }),
    ).rejects.toThrow('database is down');

    const row = [...container.repos.store.workspaces.values()][0];
    // The reason is written out here as well as read from the export: this text is what an
    // operator finds on a `FAILED` row, and compared only against the constant it came from it
    // could be emptied without a single check noticing.
    expect(row).toMatchObject({
      status: 'FAILED',
      failureReason: 'container reference was never recorded',
    });
    expect(UNRECORDED_WORKSPACE_REASON).toBe('container reference was never recorded');
    const created = container.runner.calls.find((call) => call.method === 'create');
    expect(
      container.runner.calls.some(
        (call) =>
          call.method === 'destroy' && (call.args[0] as WorkspaceHandle).workspaceId === row?.id,
      ),
    ).toBe(true);
    expect(created).toBeDefined();
    vi.restoreAllMocks();
  });

  /**
   * A daemon that refuses to remove the container must not stop the row being closed out: the
   * alternative is a row that still claims to be an in-flight create.
   */
  it('closes the row out even when the container cannot be destroyed', async () => {
    const container = createTestContainer();
    const setStatus = container.repos.workspaces.setStatus.bind(container.repos.workspaces);
    vi.spyOn(container.repos.workspaces, 'setStatus').mockImplementation(
      async (id, status, update) => {
        if (status === 'READY') {
          throw new Error('database is down');
        }
        return setStatus(id, status, update);
      },
    );
    vi.spyOn(container.runner, 'destroy').mockRejectedValue(new Error('daemon busy'));

    await expect(
      provisionWorkspace(container, {
        kind: 'JOB',
        repoUrl: 'https://github.com/octocat/Hello-World',
        branch: 'main',
      }),
    ).rejects.toThrow('database is down');

    expect([...container.repos.store.workspaces.values()][0]).toMatchObject({
      status: 'FAILED',
      failureReason: UNRECORDED_WORKSPACE_REASON,
    });
    // Which row leaked, and what the daemon said about the container it could not remove.
    expect(
      container.logs.map((line) => JSON.parse(line) as Record<string, unknown>),
    ).toContainEqual(
      expect.objectContaining({
        msg: 'destroying a workspace whose reference was never recorded failed',
        workspaceId: [...container.repos.store.workspaces.values()][0]?.id,
        err: expect.objectContaining({ message: 'daemon busy' }) as unknown,
      }),
    );
    vi.restoreAllMocks();
  });

  /**
   * When the repository is down altogether, the compensating write fails the same way the first
   * one did. The container is still destroyed — that is the half that leaks — and the failure is
   * reported by classification, never by a driver message built from a connection string.
   */
  it('destroys the container even when the row cannot be closed out', async () => {
    const container = createTestContainer();
    vi.spyOn(container.repos.workspaces, 'setStatus').mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED postgres://ah:hunter2@db:5432'), {
        code: 'ECONNREFUSED',
      }),
    );

    await expect(
      provisionWorkspace(container, {
        kind: 'JOB',
        repoUrl: 'https://github.com/octocat/Hello-World',
        branch: 'main',
      }),
    ).rejects.toThrow('ECONNREFUSED');

    expect(container.runner.calls.some((call) => call.method === 'destroy')).toBe(true);
    const logged = container.logs.join('');
    // Classified, never quoted, and still naming the row nobody will be able to close out later.
    expect(
      container.logs.map((line) => JSON.parse(line) as Record<string, unknown>),
    ).toContainEqual(
      expect.objectContaining({
        msg: 'could not close out a workspace whose reference was never recorded',
        workspaceId: [...container.repos.store.workspaces.values()][0]?.id,
        failure: 'ECONNREFUSED',
      }),
    );
    expect(logged).not.toContain('hunter2');
    vi.restoreAllMocks();
  });

  /**
   * The happy path: a row, then the container with the askpass helper and the labels the collector
   * selects on, then the row again with the runner's reference.
   */
  it('creates the row, the container and the labels a chat workspace needs', async () => {
    const container = createTestContainer();

    const result = await provisionWorkspace(container, {
      kind: 'CHAT',
      chatId: 'chat-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    expect(result.ok).toBe(true);
    const spec = createSpec(container);
    expect(spec.env).toMatchObject({ GIT_ASKPASS: '/opt/agent-runtime/askpass.sh' });
    expect(spec.env.OPENAI_BASE_URL).toBeUndefined();
    expect(spec.limits).toEqual({ cpus: 2, memoryBytes: 2 * 1024 ** 3, pids: 512 });
    expect(spec.labels).toEqual({
      'ah.instance': 'w2b-unit',
      'ah.workspace': spec.workspaceId,
      'ah.kind': 'CHAT',
      'ah.chat': 'chat-1',
    });
    const row = await container.repos.workspaces.get(spec.workspaceId);
    expect(row).toMatchObject({ status: 'READY', chatId: 'chat-1', runnerKind: 'fake' });
    expect(row?.runnerRef).not.toBeNull();
  });

  /**
   * A scheduled run's workspace is labelled with the run instead, which is how the collector finds
   * one that outlived its run.
   */
  it('labels a job workspace with its run', async () => {
    const container = createTestContainer();

    await provisionWorkspace(container, {
      kind: 'JOB',
      jobRunId: 'run-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    const spec = createSpec(container);
    expect(spec.labels).toMatchObject({ 'ah.kind': 'JOB', 'ah.jobRun': 'run-1' });
    expect(spec.labels['ah.chat']).toBeUndefined();
    expect((await container.repos.workspaces.get(spec.workspaceId))?.chatId).toBeNull();
  });

  /**
   * An alternative OpenAI endpoint is forwarded only when one is configured; passing the key
   * without it would be an omission, passing `undefined` would be a broken environment entry.
   */
  it('forwards an alternative OpenAI endpoint when one is configured', async () => {
    const base = createTestContainer();
    const container: TestContainer = {
      ...base,
      config: { ...base.config, OPENAI_BASE_URL: 'https://proxy.internal/v1' },
    };

    await provisionWorkspace(container, {
      kind: 'CHAT',
      chatId: 'chat-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    expect(createSpec(container).env.OPENAI_BASE_URL).toBe('https://proxy.internal/v1');
  });

  /**
   * The worker side of the scripted-provider join: a script resolved at boot is composed into the
   * environment the container is created with, under the name the provider inside it reads. This
   * is the crossing the two sides never made — the worker built a fixed block that had no room
   * for it — so it is asserted on the spec the runner was actually called with.
   */
  it('composes a supplied script into the container environment', async () => {
    const base = createTestContainer();
    const container: TestContainer = {
      ...base,
      fakeProviderEnv: fakeProviderScriptEnv('fake', scriptPath),
    };

    await provisionWorkspace(container, {
      kind: 'CHAT',
      chatId: 'chat-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    const { env } = createSpec(container);
    expect(JSON.parse(env[FAKE_SCRIPT_ENV_KEY] ?? '')).toEqual(SCRIPT);
    expect(env.AGENT_MODEL_PROVIDER).toBe('fake');
  });

  /**
   * The extra block is spread first, so a script can never shadow the provider selection or the
   * helper git authenticates through.
   */
  it('never lets the extra block shadow what the container is created with', async () => {
    const base = createTestContainer();
    const container: TestContainer = {
      ...base,
      fakeProviderEnv: {
        [FAKE_SCRIPT_ENV_KEY]: '{}',
        GIT_ASKPASS: '/tmp/shadowed.sh',
        AGENT_MODEL_PROVIDER: 'openai',
      },
    };

    await provisionWorkspace(container, {
      kind: 'CHAT',
      chatId: 'chat-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    const { env } = createSpec(container);
    expect(env[FAKE_SCRIPT_ENV_KEY]).toBe('{}');
    expect(env.GIT_ASKPASS).toBe('/opt/agent-runtime/askpass.sh');
    expect(env.AGENT_MODEL_PROVIDER).toBe('fake');
  });

  /**
   * A run that supplied no script adds no variable at all: the container keeps the environment it
   * had, and the runtime keeps the script built into it.
   */
  it('adds no script variable when none was supplied', async () => {
    const container = createTestContainer();

    await provisionWorkspace(container, {
      kind: 'CHAT',
      chatId: 'chat-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    expect(createSpec(container).env[FAKE_SCRIPT_ENV_KEY]).toBeUndefined();
  });

  /**
   * Nothing is decrypted to build a workspace. The container outlives the turn that created it, so
   * a credential revealed here would be one the workspace holds for as long as it stands; the two
   * are revealed per execution instead, by `workspace-credentials.ts`.
   */
  it('reveals no credential and registers nothing with the redactor', async () => {
    const container = createTestContainer();
    const register = vi.spyOn(container.redactor, 'register');
    const reveal = vi.spyOn(container.secrets, 'reveal');

    await provisionWorkspace(container, {
      kind: 'CHAT',
      chatId: 'chat-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    expect(reveal).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  /**
   * The write routes vet a repository URL when the chat or job is written, but the URL is stored
   * and cloned again by every later turn. An operator who removes an origin from
   * `ALLOWED_REPO_HOSTS` must stop the PAT reaching it, so the list is applied again here — before
   * anything is built, so a repository that is no longer allowed never gets a container.
   */
  it('refuses a stored repository that is no longer on the allow-list', async () => {
    const container = createTestContainer();
    const reveal = vi.spyOn(container.secrets, 'reveal');

    const result = await provisionWorkspace(container, {
      kind: 'CHAT',
      chatId: 'chat-1',
      repoUrl: 'https://forge.removed.test/octocat/Hello-World',
      branch: 'main',
    });

    expect(result).toMatchObject({ ok: false, reason: 'repo_url_not_allowed' });
    expect(reveal).not.toHaveBeenCalled();
    expect(container.runner.calls).toHaveLength(0);
    expect([...container.repos.store.workspaces.values()][0]).toMatchObject({
      status: 'FAILED',
      failureReason: 'repository host is not allowed',
    });
    expect(REPO_URL_NOT_ALLOWED_REASON).toBe('repository host is not allowed');
    // And the sentence the user is shown names the variable to change and quotes no URL back: the
    // repository is a value the redactor knows nothing about, and this message is persisted and
    // displayed.
    expect(result).toMatchObject({
      message: 'This repository is not on an origin listed in ALLOWED_REPO_HOSTS.',
    });
    vi.restoreAllMocks();
  });

  /**
   * The refusal is about the origin, not about the product: a repository on the configured forge
   * still provisions, which is what keeps the guard from being a blanket denial.
   */
  it('provisions a stored repository that is still on the allow-list', async () => {
    const container = createTestContainer();

    const result = await provisionWorkspace(container, {
      kind: 'JOB',
      jobRunId: 'run-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    expect(result.ok).toBe(true);
  });

  /**
   * The container is told the one origin it may reach, derived from the repository URL that has
   * just passed the allow-list. Both readers inside it — the askpass helper and the agent runtime
   * — decide from a URL the agent can influence, so what they are given is one origin rather than
   * the operator's list.
   */
  it('tells the container the single origin the workspace was created for', async () => {
    const container = createTestContainer();

    await provisionWorkspace(container, {
      kind: 'CHAT',
      chatId: 'chat-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    expect(createSpec(container).files).toStrictEqual([
      { path: ALLOWED_ORIGIN_PATH, content: 'https://github.com\n' },
    ]);
  });

  /**
   * The origin is the URL's origin and not a fixed forge, so an operator who lists a local forge
   * on a port gets that scheme, that host and that port — which is what a private repository
   * anywhere but github.com needs in order to authenticate at all.
   */
  it('forwards the origin of a forge the operator listed, port and scheme included', async () => {
    const base = createTestContainer();
    const container: TestContainer = {
      ...base,
      config: { ...base.config, ALLOWED_REPO_HOSTS: 'http://host.docker.internal:3907' },
    };

    const result = await provisionWorkspace(container, {
      kind: 'JOB',
      jobRunId: 'run-1',
      repoUrl: 'http://host.docker.internal:3907/acme/sample.git',
      branch: 'main',
    });

    expect(result.ok).toBe(true);
    expect(createSpec(container).files?.[0]?.content).toBe('http://host.docker.internal:3907\n');
  });

  /**
   * The origin travels as a file and NOT as an environment entry, which is the whole of the
   * defence: the shell tool runs a command the model wrote, and a command may set any variable for
   * the process it starts, so a policy in the environment is a policy the workspace picks. The
   * environment of the only `create` in the application is therefore enumerated — an addition to
   * it becomes a deliberate edit here, and naming the keys is also what proves nothing added can
   * stand in for a credential.
   */
  it('places the origin outside the environment, which carries no credential at all', async () => {
    const container = createTestContainer();

    await provisionWorkspace(container, {
      kind: 'CHAT',
      chatId: 'chat-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    const spec = createSpec(container);
    expect(Object.keys(spec.env).toSorted()).toStrictEqual([
      'AGENT_MODEL_PROVIDER',
      'GIT_ASKPASS',
      'OPENAI_MODEL',
    ]);
    expect(spec.env).toMatchObject({ AGENT_MODEL_PROVIDER: 'fake' });
    // Whatever is in that environment is readable through `/proc/1/environ` by every process of
    // the container, for its whole life, so the assertion that matters is what is NOT in it.
    expect(JSON.stringify(spec.env)).not.toContain(GITHUB_CANARY);
    expect(JSON.stringify(spec.env)).not.toContain(OPENAI_CANARY);
    expect(spec.files).toHaveLength(1);
  });

  /**
   * A missing credential stops before the container exists, and the row records why.
   */
  it('fails without starting a container when a credential is missing', async () => {
    const container = createTestContainer({ secrets: new FakeSecretsService() });

    const result = await provisionWorkspace(container, {
      kind: 'CHAT',
      chatId: 'chat-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    expect(result).toMatchObject({ ok: false, reason: 'secrets_missing' });
    expect(container.runner.calls).toHaveLength(0);
    expect([...container.repos.store.workspaces.values()][0]).toMatchObject({
      status: 'FAILED',
      failureReason: SECRETS_MISSING_REASON,
    });
  });

  /**
   * A missing image is reported with the command that builds it, and the row keeps the same text.
   */
  it('reports a missing image with the command that builds it', async () => {
    const container = createTestContainer({
      runner: new FailingRunner(new WorkspaceImageMissing('agent-hangar/workspace:test')),
    });

    const result = await provisionWorkspace(container, {
      kind: 'CHAT',
      chatId: 'chat-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    expect(result).toMatchObject({ ok: false, reason: 'workspace_image_missing' });
    expect(result.ok ? '' : result.message).toContain('pnpm infra:image');
    expect([...container.repos.store.workspaces.values()][0]?.failureReason).toContain(
      'pnpm infra:image',
    );
  });

  /**
   * An unreachable daemon is reported as infrastructure, so it is rethrown after the row is
   * closed out rather than reported as a result.
   */
  it('rethrows an unreachable daemon after closing the row out', async () => {
    const container = createTestContainer({
      runner: new FailingRunner(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      ),
    });

    await expect(
      provisionWorkspace(container, {
        kind: 'CHAT',
        chatId: 'chat-1',
        repoUrl: 'https://github.com/octocat/Hello-World',
        branch: 'main',
      }),
    ).rejects.toThrow(/ECONNREFUSED/);

    expect([...container.repos.store.workspaces.values()][0]).toMatchObject({
      status: 'FAILED',
      failureReason: 'docker unreachable',
    });
  });

  /**
   * Any other create failure is a result, and its message is redacted before it is persisted: the
   * daemon builds messages from what it was configured with.
   */
  it('records another create failure with a redacted message', async () => {
    const container = createTestContainer({
      runner: new FailingRunner(new Error(`invalid env for ${GITHUB_CANARY}`)),
    });
    container.redactor.register([GITHUB_CANARY]);

    const result = await provisionWorkspace(container, {
      kind: 'CHAT',
      chatId: 'chat-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    expect(result).toMatchObject({ ok: false, reason: 'workspace_create_failed' });
    expect(result.ok ? '' : result.message).toBe('invalid env for [REDACTED]');
  });

  /**
   * A rejection that is not an `Error` at all still produces a message rather than `undefined`.
   */
  it('describes a non-error rejection', async () => {
    const container = createTestContainer({ runner: new FailingRunner('daemon said no') });

    const result = await provisionWorkspace(container, {
      kind: 'CHAT',
      chatId: 'chat-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    expect(result.ok ? '' : result.message).toBe('daemon said no');
  });
});
