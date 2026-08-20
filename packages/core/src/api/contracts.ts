/**
 * HTTP API contracts: Zod request/response schemas for every route and the SSE frame shape.
 *
 * Layer: contract.
 *
 * Route handlers validate requests and responses with these schemas; the web client parses
 * responses with the same schemas. Dates travel as ISO-8601 strings.
 */
import { z } from 'zod';

import type { AgentEventType } from '../agent-protocol/types.ts';
import { credentialFreeUrl, repoUrl } from '../repo-url.ts';

// ────────────────────────────── shared ──────────────────────────────

/** ISO-8601 timestamp as serialised in JSON. */
export const isoDateTime = z.iso.datetime();

/** Shape of every error body: `{ error: { code, message } }`. */
export const apiError = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

/** Generic acknowledgement body, for operations that really do answer with `{ ok: true }`. */
export const okResponse = z.object({ ok: z.literal(true) });

/** HTTP status of a successful response that carries no body. */
export const HTTP_NO_CONTENT = 204;

/**
 * Response schema of an operation whose success is `204 No Content`.
 *
 * Deliberately distinct from {@link okResponse}: that one describes a real JSON body, this one
 * marks the absence of any. An operation carrying it must also set `noContent: true`, which is
 * what the client branches on to skip parsing altogether; a contract test keeps the two in step
 * so neither can be set without the other.
 */
export const noContentResponse = z.undefined();

/** Maximum length of a prompt (chat message or scheduled-job prompt). */
export const MAX_PROMPT_LENGTH = 20_000;

/** Maximum length of a chat title, job name or search query. */
export const MAX_TITLE_LENGTH = 200;

/** Maximum length of a git branch name accepted by the API. */
export const MAX_BRANCH_LENGTH = 255;

/** Maximum length of a cron expression. */
export const MAX_CRON_LENGTH = 100;

/** Maximum length of an IANA timezone name. */
export const MAX_TIMEZONE_LENGTH = 64;

export { repoUrl, repoUrlForHosts } from '../repo-url.ts';

// ──────────────────────────────── repos ─────────────────────────────

/** `GET /api/repos?query=` */
export const listReposQuery = z.object({ query: z.string().max(MAX_TITLE_LENGTH).optional() });

/** One repository the PAT can access. */
export const repoSummary = z.object({
  fullName: z.string().min(1),
  // Credential-free rather than GitHub-only: this URL is whatever the configured forge returned,
  // and which forges are allowed is the host's policy (`ALLOWED_REPO_HOSTS`), not this schema's.
  // Pinning it to github.com here would reject the local git server the end-to-end suite serves.
  url: credentialFreeUrl,
  defaultBranch: z.string().min(1),
  private: z.boolean(),
  description: z.string().nullable(),
  /**
   * Whether the token may push here, or absent when the forge did not say.
   *
   * Optional because absence is a real answer, not a gap to be filled in: `permissions` is
   * required on the repository schema GitHub documents for `/user/repos` but optional on the
   * minimal-repository schema other listings return, and the API base URL is configurable, so a
   * forge that reports nothing about permissions has to be describable. A reader treats the
   * absence as "unknown" and never as "may push".
   */
  canPush: z.boolean().optional(),
  /**
   * Whether the forge has archived the repository, or absent when it did not say.
   *
   * An archived repository rejects every write regardless of what the token may do, so this is a
   * fact in its own right and not a detail of {@link repoSummary.canPush}. The two are separate
   * optional fields rather than one optional pair precisely so that a forge reporting only one of
   * them loses neither: bundling them would discard a stated `archived` whenever `permissions`
   * was missing, and invent an unstated one whenever it was present.
   */
  archived: z.boolean().optional(),
});

/** `GET /api/repos` response. */
export const listReposResponse = z.object({
  repos: z.array(repoSummary),
  /**
   * Whether the listing stopped at the client's page limit rather than at the end of the account.
   *
   * A truncated listing is not merely incomplete, it answers searches wrongly: the query is
   * applied to what was read, so a repository past the limit cannot be found however it is spelt.
   * The picker says so instead of blaming the token's scope. Optional so the field is additive.
   */
  truncated: z.boolean().optional(),
});

/** `GET /api/repos/branches?repo=` */
export const listBranchesQuery = z.object({ repo: z.string().min(1) });

/** One branch of a repository. */
export const branchSummary = z.object({
  name: z.string().min(1),
  sha: z.string().min(1),
  protected: z.boolean(),
});

/** `GET /api/repos/branches` response. */
export const listBranchesResponse = z.object({ branches: z.array(branchSummary) });

// ──────────────────────────────── chats ─────────────────────────────

/** Chat lifecycle. */
export const chatStatus = z.enum(['ACTIVE', 'ARCHIVED']);

/** Turn lifecycle. */
export const turnStatus = z.enum([
  'QUEUED',
  'PREPARING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

/** Message author. */
export const messageRole = z.enum(['USER', 'ASSISTANT', 'SYSTEM', 'TOOL_SUMMARY']);

/** Tool-call lifecycle. */
export const toolCallStatus = z.enum(['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT']);

/** Workspace lifecycle. */
export const workspaceStatus = z.enum([
  'CREATING',
  'READY',
  'BUSY',
  'STOPPING',
  'DESTROYED',
  'FAILED',
]);

/**
 * `POST /api/chats` body.
 *
 * `repoUrl` is shape-only here; the route re-validates it against `ALLOWED_REPO_HOSTS` before the
 * chat is created, because which forge may be reached is configuration and not a contract.
 */
export const createChatRequest = z.object({
  repoUrl,
  baseBranch: z.string().min(1).max(MAX_BRANCH_LENGTH),
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
});

/** `POST /api/chats` response. */
export const createChatResponse = z.object({
  chatId: z.string().min(1),
  turnId: z.string().min(1),
});

/** `GET /api/chats?status=` */
export const listChatsQuery = z.object({ status: chatStatus.optional() });

/** Sidebar entry. */
export const chatSummary = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: chatStatus,
  repoUrl,
  baseBranch: z.string().min(1),
  workBranch: z.string().nullable(),
  lastPushedSha: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  archivedAt: isoDateTime.nullable(),
  /** Status of the most recent turn, for the sidebar indicator. */
  lastTurnStatus: turnStatus.nullable(),
});

/** `GET /api/chats` response. */
export const listChatsResponse = z.object({ chats: z.array(chatSummary) });

/** One message of a chat. */
export const messageView = z.object({
  id: z.string().min(1),
  turnId: z.string().nullable(),
  seq: z.number().int().nonnegative(),
  role: messageRole,
  content: z.string(),
  createdAt: isoDateTime,
});

/** Token usage as serialised in responses. */
export const usageView = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  stepCount: z.number().int().nonnegative(),
});

/** One turn of a chat. */
export const turnView = z.object({
  id: z.string().min(1),
  status: turnStatus,
  model: z.string().min(1),
  workspaceId: z.string().nullable(),
  usage: usageView,
  error: z.string().nullable(),
  queuedAt: isoDateTime,
  startedAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
});

/** One logged tool call (arguments and result already redacted). */
export const toolCallView = z.object({
  id: z.string().min(1),
  turnId: z.string().nullable(),
  jobRunId: z.string().nullable(),
  callId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  toolName: z.string().min(1),
  args: z.unknown(),
  resultHead: z.string().nullable(),
  resultBytes: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  status: toolCallStatus,
  startedAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});

/** Live workspace of a chat, when any. */
export const workspaceView = z.object({
  id: z.string().min(1),
  status: workspaceStatus,
  image: z.string().min(1),
  createdAt: isoDateTime,
  lastActiveAt: isoDateTime,
});

/** `GET /api/chats/:id` response. */
export const chatDetail = z.object({
  chat: chatSummary,
  messages: z.array(messageView),
  turns: z.array(turnView),
  toolCalls: z.array(toolCallView),
  workspace: workspaceView.nullable(),
});

/** `PATCH /api/chats/:id` body. */
export const renameChatRequest = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
});

/** `POST /api/chats/:id/messages` body. */
export const postMessageRequest = z.object({ prompt: z.string().min(1).max(MAX_PROMPT_LENGTH) });

/** `POST /api/chats/:id/messages` response. */
export const postMessageResponse = z.object({ turnId: z.string().min(1) });

/** `POST /api/chats/:id/restore?warm=` */
export const restoreChatQuery = z.object({ warm: z.stringbool().optional() });

// ──────────────────────────── scheduled jobs ────────────────────────

/** Run lifecycle. */
export const jobRunStatus = turnStatus;

/** What started a run. */
export const jobRunTrigger = z.enum(['SCHEDULE', 'MANUAL']);

/**
 * `POST /api/jobs` body and `PATCH /api/jobs/:id` body (all fields optional on PATCH).
 *
 * As with a chat, `repoUrl` is shape-only here and the route applies `ALLOWED_REPO_HOSTS`.
 */
export const jobUpsertRequest = z.object({
  name: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
  cron: z.string().trim().min(1).max(MAX_CRON_LENGTH),
  timezone: z.string().trim().min(1).max(MAX_TIMEZONE_LENGTH),
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  repoUrl,
  branch: z.string().min(1).max(MAX_BRANCH_LENGTH),
  enabled: z.boolean(),
});

/** `PATCH /api/jobs/:id` body. */
export const jobPatchRequest = jobUpsertRequest.partial();

/** One scheduled job. */
export const jobSummary = z.object({
  id: z.string().min(1),
  name: z.string(),
  cron: z.string(),
  timezone: z.string(),
  prompt: z.string(),
  repoUrl,
  branch: z.string(),
  enabled: z.boolean(),
  lastRunAt: isoDateTime.nullable(),
  nextRunAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  /** Status of the most recent run, for the table. */
  lastRunStatus: jobRunStatus.nullable(),
});

/** `GET /api/jobs` response. */
export const listJobsResponse = z.object({ jobs: z.array(jobSummary) });

/** One run of a scheduled job. */
export const runSummary = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  status: jobRunStatus,
  trigger: jobRunTrigger,
  model: z.string().min(1),
  usage: usageView,
  error: z.string().nullable(),
  scheduledFor: isoDateTime,
  queuedAt: isoDateTime,
  startedAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
});

/** `GET /api/jobs/:id/runs` response. */
export const listRunsResponse = z.object({ runs: z.array(runSummary) });

/** `GET /api/runs/:id` response. */
export const runDetail = z.object({
  run: runSummary,
  /** Final assistant message, redacted. */
  output: z.string().nullable(),
  toolCalls: z.array(toolCallView),
});

/** `POST /api/jobs/:id/run` response. */
export const triggerRunResponse = z.object({ runId: z.string().min(1) });

// ────────────────────────────── settings ────────────────────────────

/** Secret keys as they appear in the `:key` path segment. */
export const settingsKeyParam = z.enum(['GITHUB_PAT', 'OPENAI_API_KEY']);

/** Masked status of one secret. */
export const secretStatusView = z.object({
  set: z.boolean(),
  last4: z.string().length(4).optional(),
  updatedAt: isoDateTime.optional(),
});

/** `GET /api/settings` response. Never contains plaintext. */
export const settingsStatus = z.object({
  githubPat: secretStatusView,
  openaiKey: secretStatusView,
  model: z.string().min(1),
});

/** `PUT /api/settings/:key` body — the only place a plaintext secret travels. */
export const putSecretRequest = z.object({ value: z.string().min(8).max(4096) });

/** `PUT /api/settings/:key` response. */
export const putSecretResponse = z.object({ set: z.literal(true), last4: z.string().length(4) });

/** Maps a secret key to its field name in {@link settingsStatus}. */
export const SETTINGS_FIELD_BY_KEY = {
  GITHUB_PAT: 'githubPat',
  OPENAI_API_KEY: 'openaiKey',
} as const;

// ─────────────────────────────── health ─────────────────────────────

/** One health probe. */
export const healthCheck = z.object({ ok: z.boolean(), detail: z.string().optional() });

/**
 * Ports the running instance resolved to.
 *
 * Reported so the Environment card can answer "which instance am I looking at" when several
 * checkouts run side by side, which is the everyday case this product is built around. Ports only:
 * the response is unauthenticated, and a connection string or a host name would say more about
 * the machine than a browser on that machine needs to be told.
 *
 * All three ports are required together: a card that showed `undefined` for one of three
 * side-by-side checkouts would be worse than no card. The block as a whole is optional on
 * {@link healthResponse} — see the note there.
 */
export const instancePorts = z.object({
  web: z.number().int().positive(),
  postgres: z.number().int().positive(),
  redis: z.number().int().positive(),
});

/**
 * `GET /api/health` response.
 *
 * `ports` is optional so that a producer written against the earlier shape still parses: the
 * field was added after clients already existed, and a response without it is a valid, if less
 * informative, health report rather than a broken one. The live route always sends it.
 */
export const healthResponse = z.object({
  ok: z.boolean(),
  instance: z.string().min(1),
  ports: instancePorts.optional(),
  checks: z.object({
    db: healthCheck,
    redis: healthCheck,
    docker: healthCheck,
    image: healthCheck,
  }),
});

// ───────────────────────────────── SSE ──────────────────────────────

/** One server-sent event as written to the response. `expired` tells the client to refetch. */
export interface SseFrame {
  /** Redis stream entry id; echoed by the browser as `Last-Event-ID` on reconnect. */
  id: string;
  event: AgentEventType | 'expired';
  /** JSON-encoded payload. */
  data: string;
}

/** Interval of the `: ping` heartbeat comment. */
export const SSE_HEARTBEAT_MS = 15_000;

// ──────────────────────────────── routes ────────────────────────────

/** Path templates of every route; `:name` segments are filled by {@link buildPath}. */
export const routes = {
  repos: '/api/repos',
  repoBranches: '/api/repos/branches',
  chats: '/api/chats',
  chat: '/api/chats/:id',
  chatMessages: '/api/chats/:id/messages',
  chatArchive: '/api/chats/:id/archive',
  chatRestore: '/api/chats/:id/restore',
  chatEvents: '/api/chats/:id/events',
  turnCancel: '/api/turns/:id/cancel',
  jobs: '/api/jobs',
  job: '/api/jobs/:id',
  jobRun: '/api/jobs/:id/run',
  jobRuns: '/api/jobs/:id/runs',
  run: '/api/runs/:id',
  runEvents: '/api/runs/:id/events',
  runCancel: '/api/runs/:id/cancel',
  settings: '/api/settings',
  settingsKey: '/api/settings/:key',
  health: '/api/health',
} as const;

/** Route keys. */
export type RouteKey = keyof typeof routes;

/**
 * Fills the `:name` segments of a path template.
 *
 * @param template - A value of {@link routes}.
 * @param params - Values for every `:name` segment; URL-encoded.
 * @returns The concrete path.
 * @throws Error when a segment has no value.
 */
export function buildPath(template: string, params: Readonly<Record<string, string>> = {}): string {
  return template.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${name}" for ${template}`);
    }
    return encodeURIComponent(value);
  });
}

/** HTTP methods used by the API. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Describes one operation: method, path template and the schemas of its boundary data. */
export interface ApiOperation<
  TQuery extends z.ZodType | undefined = undefined,
  TBody extends z.ZodType | undefined = undefined,
  TResponse extends z.ZodType = z.ZodType,
> {
  method: HttpMethod;
  path: (typeof routes)[RouteKey];
  /** Query-string schema; absent when the operation takes no query parameters. */
  query?: TQuery;
  /** JSON body schema; absent when the operation takes no body. */
  body?: TBody;
  response: TResponse;
  /**
   * `true` when success is `204 No Content`. `response` must then be {@link noContentResponse},
   * and a client neither reads nor parses a response body.
   */
  noContent?: true;
}

function op<
  TQuery extends z.ZodType | undefined = undefined,
  TBody extends z.ZodType | undefined = undefined,
  TResponse extends z.ZodType = z.ZodType,
>(operation: ApiOperation<TQuery, TBody, TResponse>): ApiOperation<TQuery, TBody, TResponse> {
  return operation;
}

/** Every JSON operation of the API, keyed by name; SSE routes are not listed (they are not JSON). */
export const apiOperations = {
  listRepos: op({
    method: 'GET',
    path: routes.repos,
    query: listReposQuery,
    response: listReposResponse,
  }),
  listBranches: op({
    method: 'GET',
    path: routes.repoBranches,
    query: listBranchesQuery,
    response: listBranchesResponse,
  }),
  createChat: op({
    method: 'POST',
    path: routes.chats,
    body: createChatRequest,
    response: createChatResponse,
  }),
  listChats: op({
    method: 'GET',
    path: routes.chats,
    query: listChatsQuery,
    response: listChatsResponse,
  }),
  getChat: op({ method: 'GET', path: routes.chat, response: chatDetail }),
  renameChat: op({
    method: 'PATCH',
    path: routes.chat,
    body: renameChatRequest,
    response: chatSummary,
  }),
  deleteChat: op({
    method: 'DELETE',
    path: routes.chat,
    response: noContentResponse,
    noContent: true,
  }),
  postMessage: op({
    method: 'POST',
    path: routes.chatMessages,
    body: postMessageRequest,
    response: postMessageResponse,
  }),
  archiveChat: op({ method: 'POST', path: routes.chatArchive, response: chatSummary }),
  restoreChat: op({
    method: 'POST',
    path: routes.chatRestore,
    query: restoreChatQuery,
    response: chatSummary,
  }),
  cancelTurn: op({ method: 'POST', path: routes.turnCancel, response: okResponse }),
  listJobs: op({ method: 'GET', path: routes.jobs, response: listJobsResponse }),
  getJob: op({ method: 'GET', path: routes.job, response: jobSummary }),
  createJob: op({
    method: 'POST',
    path: routes.jobs,
    body: jobUpsertRequest,
    response: jobSummary,
  }),
  updateJob: op({ method: 'PATCH', path: routes.job, body: jobPatchRequest, response: jobSummary }),
  deleteJob: op({
    method: 'DELETE',
    path: routes.job,
    response: noContentResponse,
    noContent: true,
  }),
  triggerRun: op({ method: 'POST', path: routes.jobRun, response: triggerRunResponse }),
  listRuns: op({ method: 'GET', path: routes.jobRuns, response: listRunsResponse }),
  getRun: op({ method: 'GET', path: routes.run, response: runDetail }),
  cancelRun: op({ method: 'POST', path: routes.runCancel, response: okResponse }),
  getSettings: op({ method: 'GET', path: routes.settings, response: settingsStatus }),
  putSecret: op({
    method: 'PUT',
    path: routes.settingsKey,
    body: putSecretRequest,
    response: putSecretResponse,
  }),
  deleteSecret: op({
    method: 'DELETE',
    path: routes.settingsKey,
    response: noContentResponse,
    noContent: true,
  }),
  getHealth: op({ method: 'GET', path: routes.health, response: healthResponse }),
} as const;

/** Operation names. */
export type ApiOperationName = keyof typeof apiOperations;

/** Parsed query parameters accepted by an operation (`never` when it has none). */
export type ApiQueryInput<K extends ApiOperationName> = [
  NonNullable<(typeof apiOperations)[K]['query']>,
] extends [z.ZodType]
  ? z.input<NonNullable<(typeof apiOperations)[K]['query']>>
  : never;

/** JSON body accepted by an operation (`never` when it has none). */
export type ApiBodyInput<K extends ApiOperationName> = [
  NonNullable<(typeof apiOperations)[K]['body']>,
] extends [z.ZodType]
  ? z.input<NonNullable<(typeof apiOperations)[K]['body']>>
  : never;

/** Parsed response of an operation. */
export type ApiResponse<K extends ApiOperationName> = z.output<
  (typeof apiOperations)[K]['response']
>;
