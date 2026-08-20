/**
 * Unit tests for workspace provisioning.
 *
 * Layer: unit.
 * Goal: the row precedes the container, the credentials reach the container environment and the
 * redactor and nothing else, the labels carry the run the workspace serves, and each failure
 * closes the row out with the right reason — with only an unreachable daemon rethrown. Plus the
 * one failure that cannot be closed out by anybody else: a reference the row refused to record.
 * Mocks: `createTestContainer` plus runner subclasses for the failures the fake cannot produce.
 */
import { WorkspaceImageMissing } from '@agent-hangar/core';
import type { WorkspaceHandle, WorkspaceSpec } from '@agent-hangar/core';
import { FakeWorkspaceRunner, GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { createTestContainer, FakeSecretsService } from '../testing/index.js';
import type { TestContainer } from '../testing/index.js';

import {
  provisionWorkspace,
  SECRETS_MISSING_REASON,
  UNRECORDED_WORKSPACE_REASON,
} from './provision-workspace.js';

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
    expect(row).toMatchObject({
      status: 'FAILED',
      failureReason: UNRECORDED_WORKSPACE_REASON,
    });
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
    expect(container.logs.join('')).toContain('whose reference was never recorded failed');
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
    expect(logged).toContain('could not close out a workspace whose reference was never recorded');
    expect(logged).not.toContain('hunter2');
    vi.restoreAllMocks();
  });

  /**
   * The happy path: a row, then the container with both credentials, the askpass helper and the
   * labels the collector selects on, then the row again with the runner's reference.
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
    expect(spec.env).toMatchObject({
      GITHUB_TOKEN: GITHUB_CANARY,
      OPENAI_API_KEY: OPENAI_CANARY,
      GIT_ASKPASS: '/opt/agent-runtime/askpass.sh',
    });
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
   * Both credentials are revealed and registered with the redactor before the container starts, so
   * anything the agent echoes back is scrubbed on the way out.
   */
  it('registers both credentials with the redactor', async () => {
    const container = createTestContainer();
    const register = vi.spyOn(container.redactor, 'register');

    await provisionWorkspace(container, {
      kind: 'CHAT',
      chatId: 'chat-1',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'main',
    });

    expect(register).toHaveBeenCalledExactlyOnceWith([GITHUB_CANARY, OPENAI_CANARY]);
    expect(container.redactor.redact(`x ${OPENAI_CANARY}`)).toBe('x [REDACTED]');
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
   * An unreachable daemon is the one failure worth retrying, so it is rethrown after the row is
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
