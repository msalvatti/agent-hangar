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
  assertNoCanary,
  CANARY_MARKER,
  GITHUB_CANARY,
  OPENAI_CANARY,
} from '../testing/canaries.ts';

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
  noContentResponse,
  putSecretRequest,
  putSecretRequestFor,
  renameChatRequest,
  repoUrl,
  repoUrlForHosts,
  restoreChatQuery,
  routes,
  runDetail,
  SETTINGS_FIELD_BY_KEY,
  settingsKeyParam,
  settingsStatus,
  SSE_HEARTBEAT_MS,
  workerCheck,
} from './contracts.ts';

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
   * The shapes a clone actually needs are accepted: owner and repository, with or without the
   * `.git` suffix git allows, and the punctuation GitHub permits in a repository name. The origin
   * is not judged here — a self-hosted forge and the local git server of the end-to-end suite
   * appear in the same rows the API echoes back.
   */
  it.each([
    'https://github.com/acme/widgets',
    'https://github.com/acme/widgets.git',
    'https://github.com/acme/my.repo_name-2',
    'https://github.com:443/acme/widgets',
    'https://ghe.example.test/acme/widgets',
    'http://127.0.0.1:3907/acme/sample.git',
  ])('accepts %s', (value) => {
    expect(repoUrl.safeParse(value).success).toBe(true);
  });

  /**
   * Everything else is refused, one rejection per case. The schema is an allow-list because the
   * value is persisted under a contract that promises a credential-free URL: a query string, a
   * fragment and userinfo each hide a token, and an extra path segment means the URL is not a
   * repository at all. A canary stands in for a real PAT in the query-string and fragment cases,
   * which are the ones a bot review found reachable.
   */
  it.each([
    ['userinfo with password', `https://user:${GITHUB_CANARY}@github.com/acme/widgets`],
    ['userinfo without password', 'https://user@github.com/acme/widgets'],
    ['query string carrying a token', `https://github.com/acme/widgets?token=${GITHUB_CANARY}`],
    ['bare question mark', 'https://github.com/acme/widgets?'],
    ['bare hash', 'https://github.com/acme/widgets#'],
    ['fragment carrying a token', `https://github.com/acme/widgets#${OPENAI_CANARY}`],
    ['third path segment', 'https://github.com/acme/widgets/tree/main'],
    ['trailing slash', 'https://github.com/acme/widgets/'],
    ['only an owner', 'https://github.com/acme'],
    ['no path', 'https://github.com'],
    ['percent-encoded separator', 'https://github.com/acme/wid%2Fgets'],
    ['bare .git path', 'https://github.com/.git'],
    ['not a URL', 'acme/widgets'],
  ])('rejects %s', (_label, value) => {
    expect(repoUrl.safeParse(value).success).toBe(false);
  });

  /**
   * A rejected URL must not have its credential copied into the validation message, which is
   * returned to the client and logged.
   */
  it('never echoes a rejected URL in its error message', () => {
    const result = repoUrl.safeParse(`https://github.com/acme/widgets?token=${GITHUB_CANARY}`);
    expect(result.success).toBe(false);
    const message = JSON.stringify(result.error?.issues);
    expect(() => {
      assertNoCanary(message);
    }).not.toThrow();
  });

  /**
   * Which origin a repository may live on is configuration, so the contract exposes it as a
   * factory the write routes build from `ALLOWED_REPO_HOSTS`. Scheme, host and port together are
   * the destination the PAT is delivered to, so each is compared, and the comparison is whole:
   * a host that merely ends with an allowed name is a different machine.
   */
  it.each([
    ['http scheme on a host allowed over https', 'http://github.com/acme/widgets'],
    ['another host', 'https://gitlab.com/acme/widgets'],
    ['host suffix attack', 'https://github.com.evil.test/acme/widgets'],
    ['non-default port', 'https://github.com:8080/acme/widgets'],
  ])('the configured factory rejects %s', (_label, value) => {
    expect(repoUrl.safeParse(value).success).toBe(true);
    expect(repoUrlForHosts(['github.com']).safeParse(value).success).toBe(false);
  });
});

describe('no-content operations', () => {
  /**
   * The three deletes answer 204, so the client must not try to parse a body for them. They are
   * named explicitly rather than derived, so adding a fourth no-content operation is a decision
   * someone has to make here on purpose.
   */
  it('marks exactly the three deletes as no-content', () => {
    const noContent = Object.entries(apiOperations)
      .filter(([, operation]) => operation.noContent === true)
      .map(([name]) => name)
      .sort();
    expect(noContent).toEqual(['deleteChat', 'deleteJob', 'deleteSecret']);
  });

  /**
   * The flag and the schema are two halves of one statement: either both say "no body" or
   * neither does. Without this, an operation could claim `noContent` while declaring a real
   * response schema, and the client would silently return `undefined` for a body that existed.
   */
  it('keeps the no-content flag and the no-content schema in step', () => {
    for (const [name, operation] of Object.entries(apiOperations)) {
      expect(
        { name, flagged: operation.noContent === true },
        `${name} must set noContent exactly when its response is noContentResponse`,
      ).toEqual({ name, flagged: operation.response === noContentResponse });
    }
  });

  /**
   * Operations that genuinely answer with `{ ok: true }` keep `okResponse`; only the deletes
   * changed, so a cancel still parses a real body.
   */
  it('leaves acknowledgement operations with a real body schema', () => {
    expect(apiOperations.cancelTurn.noContent).toBeUndefined();
    expect(apiOperations.cancelTurn.response.safeParse({ ok: true }).success).toBe(true);
  });

  /**
   * Stopping a scheduled run is its own operation on its own path. The two cancels are separate
   * because their ids come from separate tables: the handler behind each resolves its parameter
   * through one repository, so an operation that sent a `JobRun.id` to the turn path could only
   * ever be answered with a 404.
   */
  it('gives the run cancel its own route, distinct from the turn cancel', () => {
    expect(apiOperations.cancelRun.method).toBe('POST');
    expect(apiOperations.cancelRun.path).toBe(routes.runCancel);
    expect(apiOperations.cancelRun.path).not.toBe(apiOperations.cancelTurn.path);
    expect(apiOperations.cancelRun.response.safeParse({ ok: true }).success).toBe(true);
  });

  /**
   * Reading one scheduled job is its own operation: the edit form loads a single row, and
   * without it a client would have to list every job to render one.
   */
  it('exposes a single-job read on the job route', () => {
    expect(apiOperations.getJob.method).toBe('GET');
    expect(apiOperations.getJob.path).toBe(routes.job);
    expect(apiOperations.getJob.response).toBe(jobSummary);
  });

  /**
   * Retrying is a second action on the turn resource, and it declares no body. That absence is
   * the contract-level statement of what a retry is: the prompt is the one already attached to
   * the turn, so re-running it can never send a different one. It also sits on its own path, so
   * a client cannot reach it by varying the method on the cancel route.
   */
  it('gives the turn retry its own bodiless route, distinct from the turn cancel', () => {
    expect(apiOperations.retryTurn.method).toBe('POST');
    expect(apiOperations.retryTurn.path).toBe(routes.turnRetry);
    expect(apiOperations.retryTurn.path).not.toBe(apiOperations.cancelTurn.path);
    expect(apiOperations.retryTurn.body).toBeUndefined();
    expect(apiOperations.retryTurn.response.safeParse({ ok: true }).success).toBe(true);
  });

  /**
   * The retry path is built from the turn id like every other `:id` template, and nothing else in
   * the route table answers to it — a duplicate template would make two operations indistinguishable
   * to any consumer that dispatches on the path alone.
   */
  it('builds the retry path from the turn id and keeps the template unique', () => {
    expect(buildPath(routes.turnRetry, { id: 'turn-7' })).toBe('/api/turns/turn-7/retry');
    const templates = Object.values(routes);
    expect(templates.filter((template) => template === routes.turnRetry)).toHaveLength(1);
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
          preparedBranch: null,
          preparedSha: null,
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
    expect(
      runDetail.safeParse({ run, output: null, push: null, toolCalls: [toolCall] }).success,
    ).toBe(true);
    expect(
      runDetail.safeParse({
        run,
        output: null,
        push: { branch: 'agent/job-2f7c11a0', sha: 'c0ffee1234567890' },
        toolCalls: [],
      }).success,
    ).toBe(true);
    // A push is both halves or neither: a branch with no commit describes nothing, and rendering
    // it would put a branch at an empty revision in front of the operator.
    expect(
      runDetail.safeParse({
        run,
        output: null,
        push: { branch: 'agent/job-2f7c11a0' },
        toolCalls: [],
      }).success,
    ).toBe(false);
    expect(
      runDetail.safeParse({
        run: { ...run, trigger: 'API' },
        output: null,
        push: null,
        toolCalls: [],
      }).success,
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
   * Each credential is measured against the shape its issuer gives it.
   *
   * Regression for `PUT /api/settings/GITHUB_PAT` storing `not-a-token`: any eight characters were
   * accepted, so a value pasted from the wrong clipboard replaced a working token and the mistake
   * surfaced later and elsewhere, as a rejected listing in the repository picker. A canary of the
   * right shape is still accepted, and neither key accepts the other's value.
   */
  it('narrows the settings body to the shape of the addressed credential', () => {
    const github = putSecretRequestFor('GITHUB_PAT');
    const openai = putSecretRequestFor('OPENAI_API_KEY');

    // The fine-grained and project-scoped forms are assembled from the canary marker rather than
    // written out: a credential-shaped literal without it is a string the secret scanners have no
    // reason to forgive, and the repository allows exactly one shape of fake credential.
    const fineGrained = `github_pat_${CANARY_MARKER}0123456789`;
    const projectKey = `sk-proj-${CANARY_MARKER}0123456789`;

    expect(github.safeParse({ value: GITHUB_CANARY }).success).toBe(true);
    expect(github.safeParse({ value: fineGrained }).success).toBe(true);
    expect(github.safeParse({ value: 'not-a-token' }).success).toBe(false);
    expect(github.safeParse({ value: OPENAI_CANARY }).success).toBe(false);

    expect(openai.safeParse({ value: OPENAI_CANARY }).success).toBe(true);
    expect(openai.safeParse({ value: projectKey }).success).toBe(true);
    expect(openai.safeParse({ value: 'not-a-token' }).success).toBe(false);
    expect(openai.safeParse({ value: GITHUB_CANARY }).success).toBe(false);
  });

  /**
   * A branch name the workspace would refuse is refused by the contract instead.
   *
   * Regression for a chat created with `baseBranch: 'main; rm -rf /'`: the API accepted it, the
   * worker provisioned a container, and only `prepare` inside that container refused the name — so
   * a malformed ref cost a whole workspace to discover. Both bodies that carry a ref now state the
   * one rule, and the names a repository really carries still pass.
   */
  it('rejects a branch name the workspace would refuse', () => {
    const chatBody = { repoUrl: 'https://github.com/acme/widgets', prompt: 'Fix the tests' };
    const jobBody = {
      name: 'Nightly',
      cron: '0 2 * * *',
      timezone: 'UTC',
      prompt: 'Update the changelog',
      repoUrl: 'https://github.com/acme/widgets',
      enabled: true,
    };

    for (const branch of ['main', 'release/2.1', 'feature/add_widget', 'v1.0.0-rc.1']) {
      expect(createChatRequest.safeParse({ ...chatBody, baseBranch: branch }).success).toBe(true);
      expect(jobUpsertRequest.safeParse({ ...jobBody, branch }).success).toBe(true);
    }

    for (const branch of ['main; rm -rf /', '-delete', '.hidden', 'has space', 'quote"d', '']) {
      expect(createChatRequest.safeParse({ ...chatBody, baseBranch: branch }).success).toBe(false);
      expect(jobUpsertRequest.safeParse({ ...jobBody, branch }).success).toBe(false);
    }
  });

  /**
   * Health response lists the five probes; a missing probe is rejected.
   */
  it('validates healthResponse', () => {
    const ok = { ok: true };
    const ports = { web: 3000, postgres: 3001, redis: 3002 };
    expect(
      healthResponse.safeParse({
        ok: true,
        instance: 'default',
        ports,
        checks: {
          db: ok,
          redis: ok,
          docker: ok,
          image: { ok: false, detail: 'missing' },
          worker: ok,
        },
      }).success,
    ).toBe(true);
    expect(
      healthResponse.safeParse({
        ok: true,
        instance: 'default',
        ports,
        checks: { db: ok, redis: ok },
      }).success,
    ).toBe(false);
    expect(
      healthResponse.safeParse({
        ok: true,
        instance: 'default',
        ports,
        checks: { db: ok, redis: ok, docker: ok, image: ok },
      }).success,
    ).toBe(false);
  });

  /**
   * The worker probe carries when the worker last spoke, which is what separates a worker that
   * never started from one that died a moment ago. The timestamp is optional — a worker that has
   * not reported has no sighting to give — but it has to be a real instant when it is there, so a
   * card cannot render whatever text a producer felt like sending.
   */
  it('accepts a worker probe with or without a last sighting', () => {
    expect(workerCheck.safeParse({ ok: false, detail: 'worker has not reported' }).success).toBe(
      true,
    );
    expect(
      workerCheck.safeParse({ ok: true, lastSeenAt: '2026-08-20T10:00:00.000Z' }).success,
    ).toBe(true);
    expect(workerCheck.safeParse({ ok: true, lastSeenAt: 'a moment ago' }).success).toBe(false);
  });

  /**
   * `ports` was added after clients already parsed this response, so it is optional and a report
   * without it still validates. What is not optional is a half-filled block: the Environment card
   * names the instance by the ports it resolved to, and one `undefined` of three side-by-side
   * checkouts would be worse than no card, so the three ports stand or fall together and each has
   * to be a real port number.
   */
  it('accepts a report without ports and rejects an incomplete or invalid block', () => {
    const ok = { ok: true };
    const checks = { db: ok, redis: ok, docker: ok, image: ok, worker: ok };
    expect(healthResponse.safeParse({ ok: true, instance: 'default', checks }).success).toBe(true);
    expect(
      healthResponse.safeParse({
        ok: true,
        instance: 'default',
        ports: { web: 3000, postgres: 3001 },
        checks,
      }).success,
    ).toBe(false);
    expect(
      healthResponse.safeParse({
        ok: true,
        instance: 'default',
        ports: { web: 3000, postgres: 3001, redis: 0 },
        checks,
      }).success,
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
