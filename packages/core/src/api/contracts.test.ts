/**
 * Unit tests for the HTTP API contracts.
 *
 * Layer: unit.
 * Goal: every request/response schema accepts its documented example and rejects a malformed
 * variant; `buildPath` fills and encodes path parameters; the operation map is consistent with
 * the route templates.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import {
  apiError,
  apiOperations,
  buildPath,
  chatDetail,
  chatSummary,
  createChatRequest,
  healthResponse,
  jobPatchRequest,
  jobSummary,
  jobUpsertRequest,
  putSecretRequest,
  renameChatRequest,
  repoUrl,
  restoreChatQuery,
  routes,
  runDetail,
  SETTINGS_FIELD_BY_KEY,
  settingsKeyParam,
  settingsStatus,
  SSE_HEARTBEAT_MS,
} from './contracts.js';

const now = '2026-08-19T10:00:00.000Z';

const chat = {
  id: 'c1',
  title: 'Fix the tests',
  status: 'ACTIVE',
  repoUrl: 'https://github.com/acme/widgets',
  baseBranch: 'main',
  workBranch: null,
  lastPushedSha: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  lastTurnStatus: 'QUEUED',
};

const toolCall = {
  id: 'tc1',
  turnId: 't1',
  jobRunId: null,
  callId: 'call_1',
  seq: 0,
  toolName: 'run_shell',
  args: { command: 'ls' },
  resultHead: 'README.md',
  resultBytes: 9,
  exitCode: 0,
  status: 'SUCCEEDED',
  startedAt: now,
  finishedAt: now,
  durationMs: 12,
};

describe('repoUrl', () => {
  /**
   * Only credential-free https GitHub URLs are accepted: other hosts, http, and embedded
   * credentials are rejected so a PAT can never leak through a repository URL.
   */
  it('accepts https GitHub URLs and rejects other hosts, schemes and credentials', () => {
    expect(repoUrl.safeParse('https://github.com/acme/widgets').success).toBe(true);
    expect(repoUrl.safeParse('https://github.com/acme/widgets.git').success).toBe(true);
    expect(repoUrl.safeParse('http://github.com/acme/widgets').success).toBe(false);
    expect(repoUrl.safeParse('https://gitlab.com/acme/widgets').success).toBe(false);
    expect(repoUrl.safeParse('https://user:token@github.com/acme/widgets').success).toBe(false);
    expect(repoUrl.safeParse('https://user@github.com/acme/widgets').success).toBe(false);
    expect(repoUrl.safeParse('acme/widgets').success).toBe(false);
  });
});

describe('chat schemas', () => {
  /**
   * `POST /api/chats` body: the documented example parses; an empty prompt is rejected.
   */
  it('validates createChatRequest', () => {
    expect(
      createChatRequest.safeParse({
        repoUrl: 'https://github.com/acme/widgets',
        baseBranch: 'main',
        prompt: 'Fix the tests',
      }).success,
    ).toBe(true);
    expect(
      createChatRequest.safeParse({
        repoUrl: 'https://github.com/acme/widgets',
        baseBranch: 'main',
        prompt: '',
      }).success,
    ).toBe(false);
  });

  /**
   * Summaries and details carry ISO timestamps and nullable fields exactly as serialised by the
   * API; a bad timestamp or status is rejected.
   */
  it('validates chatSummary and chatDetail', () => {
    expect(chatSummary.safeParse(chat).success).toBe(true);
    expect(chatSummary.safeParse({ ...chat, createdAt: 'today' }).success).toBe(false);
    expect(chatSummary.safeParse({ ...chat, status: 'DELETED' }).success).toBe(false);

    const detail = {
      chat,
      messages: [{ id: 'm1', turnId: 't1', seq: 1, role: 'USER', content: 'hi', createdAt: now }],
      turns: [
        {
          id: 't1',
          status: 'SUCCEEDED',
          model: 'gpt-5.6-sol',
          workspaceId: 'w1',
          usage: { inputTokens: 10, outputTokens: 5, stepCount: 1 },
          error: null,
          queuedAt: now,
          startedAt: now,
          finishedAt: now,
        },
      ],
      toolCalls: [toolCall],
      workspace: {
        id: 'w1',
        status: 'READY',
        image: 'agent-hangar/workspace:dev',
        createdAt: now,
        lastActiveAt: now,
      },
    };
    expect(chatDetail.safeParse(detail).success).toBe(true);
    expect(chatDetail.safeParse({ ...detail, workspace: null }).success).toBe(true);
    expect(chatDetail.safeParse({ ...detail, turns: [{ id: 't1' }] }).success).toBe(false);
  });

  /**
   * Rename trims whitespace and rejects blank titles; the restore query coerces `warm`.
   */
  it('validates renameChatRequest and restoreChatQuery', () => {
    expect(renameChatRequest.parse({ title: '  New title  ' })).toEqual({ title: 'New title' });
    expect(renameChatRequest.safeParse({ title: '   ' }).success).toBe(false);
    expect(restoreChatQuery.parse({ warm: '1' })).toEqual({ warm: true });
    expect(restoreChatQuery.parse({})).toEqual({});
  });
});

describe('job schemas', () => {
  const job = {
    name: 'Nightly lint',
    cron: '0 3 * * *',
    timezone: 'UTC',
    prompt: 'Run the linter and fix what you can',
    repoUrl: 'https://github.com/acme/widgets',
    branch: 'main',
    enabled: true,
  };

  /**
   * Upsert requires every field; patch accepts any subset; both reject a non-GitHub URL.
   */
  it('validates jobUpsertRequest and jobPatchRequest', () => {
    expect(jobUpsertRequest.safeParse(job).success).toBe(true);
    expect(jobUpsertRequest.safeParse({ ...job, name: undefined }).success).toBe(false);
    expect(jobPatchRequest.safeParse({ enabled: false }).success).toBe(true);
    expect(jobPatchRequest.safeParse({ repoUrl: 'https://example.com/x' }).success).toBe(false);
  });

  /**
   * Job and run views round-trip their documented shapes.
   */
  it('validates jobSummary and runDetail', () => {
    const summary = {
      id: 'j1',
      ...job,
      lastRunAt: null,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
      lastRunStatus: null,
    };
    expect(jobSummary.safeParse(summary).success).toBe(true);
    const run = {
      id: 'r1',
      jobId: 'j1',
      status: 'FAILED',
      trigger: 'SCHEDULE',
      model: 'gpt-5.6-sol',
      usage: { inputTokens: null, outputTokens: null, stepCount: 0 },
      error: 'previous run still running',
      scheduledFor: now,
      queuedAt: now,
      startedAt: null,
      finishedAt: now,
    };
    expect(runDetail.safeParse({ run, output: null, toolCalls: [toolCall] }).success).toBe(true);
    expect(
      runDetail.safeParse({ run: { ...run, trigger: 'API' }, output: null, toolCalls: [] }).success,
    ).toBe(false);
  });
});

describe('settings and health schemas', () => {
  /**
   * Settings status never carries plaintext: only `set`/`last4`/`updatedAt`; `last4` must be
   * exactly four characters. The `:key` param maps to the response field names.
   */
  it('validates settingsStatus, key param and secret bodies', () => {
    expect(
      settingsStatus.safeParse({
        githubPat: { set: true, last4: 'ab12', updatedAt: now },
        openaiKey: { set: false },
        model: 'gpt-5.6-sol',
      }).success,
    ).toBe(true);
    expect(
      settingsStatus.safeParse({
        githubPat: { set: true, last4: 'abc123' },
        openaiKey: { set: false },
        model: 'x',
      }).success,
    ).toBe(false);
    expect(settingsKeyParam.safeParse('GITHUB_PAT').success).toBe(true);
    expect(settingsKeyParam.safeParse('githubPat').success).toBe(false);
    expect(SETTINGS_FIELD_BY_KEY.GITHUB_PAT).toBe('githubPat');
    expect(SETTINGS_FIELD_BY_KEY.OPENAI_API_KEY).toBe('openaiKey');
    expect(putSecretRequest.safeParse({ value: 'short' }).success).toBe(false);
    expect(putSecretRequest.safeParse({ value: 'long-enough-value' }).success).toBe(true);
  });

  /**
   * Health response lists the four probes; a missing probe is rejected.
   */
  it('validates healthResponse', () => {
    const ok = { ok: true };
    expect(
      healthResponse.safeParse({
        ok: true,
        instance: 'default',
        checks: { db: ok, redis: ok, docker: ok, image: { ok: false, detail: 'missing' } },
      }).success,
    ).toBe(true);
    expect(
      healthResponse.safeParse({ ok: true, instance: 'default', checks: { db: ok, redis: ok } })
        .success,
    ).toBe(false);
  });

  /**
   * Error bodies follow `{ error: { code, message } }`.
   */
  it('validates apiError', () => {
    expect(
      apiError.safeParse({ error: { code: 'NOT_FOUND', message: 'no such chat' } }).success,
    ).toBe(true);
    expect(apiError.safeParse({ message: 'no such chat' }).success).toBe(false);
  });

  /**
   * The SSE heartbeat interval is the documented 15 s.
   */
  it('exports the SSE heartbeat interval', () => {
    expect(SSE_HEARTBEAT_MS).toBe(15_000);
  });
});

describe('routes and buildPath', () => {
  /**
   * Parameters are substituted and URL-encoded; a missing parameter throws so a malformed URL
   * never reaches `fetch`.
   */
  it('fills and encodes path parameters', () => {
    expect(buildPath(routes.chat, { id: 'c 1/x' })).toBe('/api/chats/c%201%2Fx');
    expect(buildPath(routes.settingsKey, { key: 'GITHUB_PAT' })).toBe('/api/settings/GITHUB_PAT');
    expect(buildPath(routes.health)).toBe('/api/health');
    expect(() => buildPath(routes.chat)).toThrow(/Missing path parameter "id"/);
  });

  /**
   * Every operation points at a route template and declares a response schema; SSE routes are
   * intentionally absent from the JSON operation map.
   */
  it('maps every operation to a known route with a response schema', () => {
    const templates = new Set<string>(Object.values(routes));
    for (const operation of Object.values(apiOperations)) {
      expect(templates.has(operation.path)).toBe(true);
      expect(typeof operation.response.safeParse).toBe('function');
    }
    const paths = Object.values(apiOperations).map((operation) => operation.path);
    expect(paths).not.toContain(routes.chatEvents);
    expect(paths).not.toContain(routes.runEvents);
  });
});
