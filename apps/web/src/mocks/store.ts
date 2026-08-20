/**
 * In-memory state backing the MSW mock API: repos/branches, chats with their messages/turns/tool
 * calls, secret status, model and health.
 *
 * Layer: mock (fixture data).
 *
 * Every value here is shaped exactly like the contract types (`z.infer` from `@agent-hangar/core`)
 * so a handler can return a piece of this store directly and still satisfy its response schema.
 * No secret-looking literal ever appears: `secrets` carries only `last4` and a timestamp.
 */
import type {
  BranchSummary,
  ChatSummary,
  HealthResponse,
  MessageView,
  RepoSummary,
  SecretKey,
  ToolCallView,
  TurnView,
  WorkspaceView,
} from '@agent-hangar/core';

/**
 * One chat's full detail, keyed by `chat.id` in {@link MockStore.chats}.
 *
 * A user message carries no `turnId`, as in the real database: the API writes the message and the
 * turn as two rows and only the rows the worker writes afterwards name the turn. A mock that
 * filled it in would let the app rely on a link that never arrives in production.
 */
export interface StoredChat {
  chat: ChatSummary;
  messages: MessageView[];
  turns: TurnView[];
  toolCalls: ToolCallView[];
  workspace: WorkspaceView | null;
}

/** Status of one stored secret, as displayed (never the plaintext). */
export interface StoredSecretStatus {
  last4: string;
  updatedAt: string;
}

/** The full mock state. */
export interface MockStore {
  repos: RepoSummary[];
  branches: Record<string, BranchSummary[]>;
  chats: StoredChat[];
  secrets: Partial<Record<SecretKey, StoredSecretStatus>>;
  model: string;
  health: HealthResponse;
}

/** Seeded repo full names, also used as {@link REPO_BRANCHES}'s keys so indexing needs no `?? []`
 * fallback (unlike `Record<string, T>`, a literal key union tells `noUncheckedIndexedAccess` the
 * lookup can't miss). */
type SeededRepoName = 'acme/api' | 'acme/web' | 'acme/docs' | 'acme/infra';

const REPO_BRANCHES: Record<SeededRepoName, BranchSummary[]> = {
  'acme/api': [
    { name: 'main', sha: 'a1b2c3d4e5f6', protected: true },
    { name: 'develop', sha: 'b2c3d4e5f6a1', protected: false },
    { name: 'agent/k3x9', sha: 'c3d4e5f6a1b2', protected: false },
  ],
  'acme/web': [{ name: 'main', sha: 'd4e5f6a1b2c3', protected: true }],
  'acme/docs': [{ name: 'master', sha: 'e5f6a1b2c3d4', protected: false }],
  'acme/infra': [{ name: 'trunk', sha: 'f6a1b2c3d4e5', protected: true }],
};

function seedRepos(): RepoSummary[] {
  return [
    {
      fullName: 'acme/api',
      url: 'https://github.com/acme/api',
      defaultBranch: 'main',
      private: true,
      description: 'Core API service.',
    },
    {
      fullName: 'acme/web',
      url: 'https://github.com/acme/web',
      defaultBranch: 'main',
      private: true,
      description: 'Customer-facing web app.',
    },
    {
      fullName: 'acme/docs',
      url: 'https://github.com/acme/docs',
      defaultBranch: 'master',
      private: false,
      description: null,
    },
    // Deliberately not on github.com. Which forges are reachable is the operator's
    // `ALLOWED_REPO_HOSTS`, so the listing may legitimately answer with any origin; a fixture set
    // that only ever names one forge cannot catch a client that rebuilds the clone URL against a
    // hard-coded host and quietly discards the URL the API returned.
    {
      fullName: 'acme/infra',
      url: 'https://git.acme.test/acme/infra',
      defaultBranch: 'trunk',
      private: true,
      description: 'Self-hosted infrastructure repository.',
    },
  ];
}

function seedBranches(): Record<SeededRepoName, BranchSummary[]> {
  return {
    'acme/api': REPO_BRANCHES['acme/api'].map((branch) => ({ ...branch })),
    'acme/web': REPO_BRANCHES['acme/web'].map((branch) => ({ ...branch })),
    'acme/docs': REPO_BRANCHES['acme/docs'].map((branch) => ({ ...branch })),
    'acme/infra': REPO_BRANCHES['acme/infra'].map((branch) => ({ ...branch })),
  };
}

/** Epoch millisecond offsets (relative to seed time) used to keep seeded timestamps ordered. */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function seedChats(now: number): StoredChat[] {
  const runningStarted = new Date(now - 2 * MINUTE_MS).toISOString();
  const finishedQueued = new Date(now - 3 * HOUR_MS).toISOString();
  const finishedStarted = new Date(now - 3 * HOUR_MS + 5_000).toISOString();
  const finishedDone = new Date(now - 3 * HOUR_MS + 41_000).toISOString();
  const failedQueued = new Date(now - DAY_MS).toISOString();
  const failedStarted = new Date(now - DAY_MS + 2_000).toISOString();
  const failedDone = new Date(now - DAY_MS + 9_000).toISOString();
  const archivedCreated = new Date(now - 6 * DAY_MS).toISOString();
  const archivedArchived = new Date(now - 5 * DAY_MS).toISOString();

  return [
    {
      chat: {
        id: 'chat-running',
        title: 'Fix flaky auth test',
        status: 'ACTIVE',
        repoUrl: 'https://github.com/acme/api',
        baseBranch: 'main',
        workBranch: 'agent/k3x9',
        lastPushedSha: null,
        createdAt: runningStarted,
        updatedAt: runningStarted,
        archivedAt: null,
        lastTurnStatus: 'QUEUED',
      },
      messages: [
        {
          id: 'msg-running-1',
          turnId: null,
          seq: 1,
          role: 'USER',
          content: 'The login test is flaky on CI. Find out why and fix it.',
          createdAt: runningStarted,
        },
      ],
      turns: [
        {
          id: 'turn-running-1',
          status: 'QUEUED',
          model: 'gpt-5.6-sol',
          workspaceId: null,
          usage: { inputTokens: null, outputTokens: null, stepCount: 0 },
          error: null,
          queuedAt: runningStarted,
          startedAt: null,
          finishedAt: null,
        },
      ],
      toolCalls: [],
      workspace: null,
    },
    {
      chat: {
        id: 'chat-finished',
        title: 'Add tests for the payment webhook',
        status: 'ACTIVE',
        repoUrl: 'https://github.com/acme/api',
        baseBranch: 'main',
        workBranch: 'agent/pw41',
        lastPushedSha: 'f6a1b2c3d4e5',
        createdAt: finishedQueued,
        updatedAt: finishedDone,
        archivedAt: null,
        lastTurnStatus: 'SUCCEEDED',
      },
      messages: [
        {
          id: 'msg-finished-1',
          turnId: null,
          seq: 1,
          role: 'USER',
          content: 'Add tests for the payment webhook handler.',
          createdAt: finishedQueued,
        },
        {
          id: 'msg-finished-2',
          turnId: 'turn-finished-1',
          seq: 2,
          role: 'ASSISTANT',
          content:
            'Added three test cases covering signature validation, replay and timeout. All green.',
          createdAt: finishedDone,
        },
      ],
      turns: [
        {
          id: 'turn-finished-1',
          status: 'SUCCEEDED',
          model: 'gpt-5.6-sol',
          workspaceId: 'workspace-finished-1',
          usage: { inputTokens: 4_120, outputTokens: 980, stepCount: 4 },
          error: null,
          queuedAt: finishedQueued,
          startedAt: finishedStarted,
          finishedAt: finishedDone,
        },
      ],
      toolCalls: [
        {
          id: 'tool-finished-1',
          turnId: 'turn-finished-1',
          jobRunId: null,
          callId: 'call-finished-1',
          seq: 0,
          toolName: 'run_shell',
          args: { command: 'pnpm test tests/webhooks/payment.test.ts' },
          resultHead: '3 passed, 0 failed',
          resultBytes: 42,
          exitCode: 0,
          status: 'SUCCEEDED',
          startedAt: finishedStarted,
          finishedAt: finishedDone,
          durationMs: 36_000,
        },
      ],
      workspace: {
        id: 'workspace-finished-1',
        status: 'READY',
        image: 'agent-hangar/workspace:latest',
        createdAt: finishedStarted,
        lastActiveAt: finishedDone,
      },
    },
    {
      chat: {
        id: 'chat-failed',
        title: 'Explain the caching layer',
        status: 'ACTIVE',
        repoUrl: 'https://github.com/acme/web',
        baseBranch: 'main',
        workBranch: null,
        lastPushedSha: null,
        createdAt: failedQueued,
        updatedAt: failedDone,
        archivedAt: null,
        lastTurnStatus: 'FAILED',
      },
      messages: [
        {
          id: 'msg-failed-1',
          turnId: null,
          seq: 1,
          role: 'USER',
          content: 'Walk me through how the caching layer invalidates stale entries.',
          createdAt: failedQueued,
        },
      ],
      turns: [
        {
          id: 'turn-failed-1',
          status: 'FAILED',
          model: 'gpt-5.6-sol',
          workspaceId: null,
          usage: { inputTokens: null, outputTokens: null, stepCount: 0 },
          error: 'OpenAI rejected the API key (401)',
          queuedAt: failedQueued,
          startedAt: failedStarted,
          finishedAt: failedDone,
        },
      ],
      toolCalls: [],
      workspace: null,
    },
    {
      chat: {
        id: 'chat-archived',
        title: 'Refactor the queue consumer',
        status: 'ARCHIVED',
        repoUrl: 'https://github.com/acme/api',
        baseBranch: 'develop',
        workBranch: 'agent/qc7',
        lastPushedSha: 'a1b2c3d4e5f6',
        createdAt: archivedCreated,
        updatedAt: archivedArchived,
        archivedAt: archivedArchived,
        lastTurnStatus: 'SUCCEEDED',
      },
      messages: [
        {
          id: 'msg-archived-1',
          turnId: null,
          seq: 1,
          role: 'USER',
          content: 'Refactor the queue consumer to use the shared retry helper.',
          createdAt: archivedCreated,
        },
        {
          id: 'msg-archived-2',
          turnId: 'turn-archived-1',
          seq: 2,
          role: 'ASSISTANT',
          content: 'Done — the consumer now shares the retry helper with the scheduler.',
          createdAt: archivedArchived,
        },
      ],
      turns: [
        {
          id: 'turn-archived-1',
          status: 'SUCCEEDED',
          model: 'gpt-5.6-sol',
          workspaceId: null,
          usage: { inputTokens: 2_800, outputTokens: 610, stepCount: 3 },
          error: null,
          queuedAt: archivedCreated,
          startedAt: archivedCreated,
          finishedAt: archivedArchived,
        },
      ],
      toolCalls: [],
      workspace: null,
    },
  ];
}

function seedHealth(): HealthResponse {
  return {
    ok: true,
    instance: 'default',
    checks: {
      db: { ok: true },
      redis: { ok: true },
      docker: { ok: true },
      image: { ok: true },
    },
  };
}

function createInitialState(): MockStore {
  return {
    repos: seedRepos(),
    branches: seedBranches(),
    chats: seedChats(Date.now()),
    secrets: {
      GITHUB_PAT: { last4: 'ab12', updatedAt: new Date(Date.now() - 3 * DAY_MS).toISOString() },
      OPENAI_API_KEY: { last4: 'cd34', updatedAt: new Date(Date.now() - 3 * DAY_MS).toISOString() },
    },
    model: 'gpt-5.6-sol',
    health: seedHealth(),
  };
}

/** The mock state. Mutated in place; hold onto `store`, never destructure its fields once. */
export const store: MockStore = createInitialState();

/** Resets every field of {@link store} back to its seeded value. */
export function resetStore(): void {
  Object.assign(store, createInitialState());
}

/**
 * Adds (or replaces) a chat in the store, for tests that need a specific fixture beyond the seed.
 *
 * @param entry - The chat to add.
 */
export function seedChat(entry: StoredChat): void {
  const index = store.chats.findIndex((existing) => existing.chat.id === entry.chat.id);
  if (index === -1) {
    store.chats.push(entry);
  } else {
    store.chats[index] = entry;
  }
}

/**
 * Generates a fresh id for a new store entity.
 *
 * @returns A random UUID.
 */
export function nextId(): string {
  return crypto.randomUUID();
}

/**
 * The current time as an ISO-8601 string, for new store entries.
 *
 * @returns `new Date().toISOString()`.
 */
export function nowIso(): string {
  return new Date().toISOString();
}
