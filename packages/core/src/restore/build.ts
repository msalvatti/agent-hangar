/**
 * Builders for the restore context and the turn request.
 *
 * Layer: domain (pure).
 *
 * Everything the worker sends into a workspace is assembled here: the context a recreated
 * workspace is rebuilt from, the request for a chat turn (fresh, continued or restored) and the
 * request for a scheduled run. Building in one place is what makes "restore is not a special
 * path" true in code rather than only in the diagram.
 *
 * Security: the request carries conversation history, which is agent and tool output that was
 * redacted on write but must still be treated as capable of holding a credential. It is copied
 * into the request and nowhere else — in particular, a request that fails schema validation is
 * reported by field path and issue code only, never by echoing the value that failed.
 */
import { turnRequestSchema } from '../agent-protocol/schemas.js';
import type { TurnLimits, TurnRequest } from '../agent-protocol/types.js';
import { ProtocolError } from '../errors.js';
import type { EnsureWorkspaceDecision, RestoreContext } from '../workspace/types.js';

import { buildHistoryWindow } from './history.js';
import type { HistoryBudget, HistoryMessage } from './history.js';
import {
  DEFAULT_CHAT_TURN_LIMITS,
  DEFAULT_JOB_TURN_LIMITS,
  defaultWorkBranch,
  JOB_WORK_BRANCH_PREFIX,
} from './limits.js';
import { RESTORATION_NOTICE_PREFIX, restorationNotice } from './notice.js';

/** The chat fields the builders read; a structural subset of the persisted `Chat`. */
export interface ChatRestoreSource {
  id: string;
  /** Credential-free repository URL. */
  repoUrl: string;
  baseBranch: string;
  /** Branch the agent pushes to, or `null` before the first push. */
  workBranch: string | null;
  /** Last commit the agent pushed, or `null`. */
  lastPushedSha: string | null;
}

/** Everything {@link buildTurnRequest} needs for a chat turn. */
export interface BuildTurnRequestInput {
  /** `Turn.id`. */
  turnId: string;
  model: string;
  /** System prompt, built host-side. */
  instructions: string;
  chat: ChatRestoreSource;
  /** Every stored message of the chat. */
  messages: readonly HistoryMessage[];
  decision: EnsureWorkspaceDecision;
  limits?: Partial<TurnLimits>;
  budget?: HistoryBudget;
}

/** Everything {@link buildJobTurnRequest} needs for a scheduled run. */
export interface BuildJobTurnRequestInput {
  /** `JobRun.id`, used as the turn id and as the branch suffix. */
  runId: string;
  model: string;
  instructions: string;
  job: { repoUrl: string; branch: string; prompt: string };
  limits?: Partial<TurnLimits>;
}

/**
 * Validates an assembled request against the frozen protocol schema.
 *
 * Drift between this builder and the schema must fail here, on the host, rather than inside the
 * container where the only symptom is a runtime that exits non-zero. The failure names the
 * offending paths and issue codes; the values are deliberately left out, because the request
 * carries conversation history.
 *
 * @param request - The assembled request.
 * @returns The parsed request.
 * @throws ProtocolError When the request does not satisfy the schema.
 */
function parseTurnRequest(request: unknown): TurnRequest {
  const result = turnRequestSchema.safeParse(request);
  if (result.success) {
    return result.data;
  }
  const paths = result.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.code}`)
    .join('; ');
  throw new ProtocolError(`turn request does not satisfy the protocol schema (${paths})`);
}

/**
 * Builds the context a recreated workspace is rebuilt from.
 *
 * `lastPushedSha` is carried only alongside a work branch: without a branch to check out there is
 * no HEAD to verify it against, and passing it on would make the runtime compare against a commit
 * it never fetched.
 *
 * @param input - Chat, its stored messages, the current instant and an optional budget.
 * @returns The restore context.
 */
export function buildRestoreContext(input: {
  chat: ChatRestoreSource;
  messages: readonly HistoryMessage[];
  now: Date;
  budget?: HistoryBudget;
}): RestoreContext {
  const window = buildHistoryWindow(input.messages, input.budget);
  return {
    repoUrl: input.chat.repoUrl,
    baseBranch: input.chat.baseBranch,
    workBranch: input.chat.workBranch,
    lastPushedSha: input.chat.workBranch === null ? null : input.chat.lastPushedSha,
    messages: window.retained,
    restoredAt: input.now,
  };
}

/**
 * Reports whether the model already sees a restoration notice.
 *
 * The check looks at the windowed history rather than the whole chat: a notice the budget dropped
 * is a notice the model will not read, so a fresh one is appended in its place.
 *
 * @param retained - The messages the window kept.
 * @returns `true` when the last system message is a restoration notice.
 */
function hasRestorationNotice(retained: readonly HistoryMessage[]): boolean {
  const lastSystem = retained.filter((message) => message.role === 'SYSTEM').at(-1);
  return lastSystem?.content.startsWith(RESTORATION_NOTICE_PREFIX) === true;
}

/**
 * Builds the request for a chat turn.
 *
 * A `create` decision clones and appends the restoration notice; the archive-then-restore flow
 * already inserted one as a stored message, so it is not repeated, while a workspace recreated by
 * the idle collector has none and gets one here.
 *
 * @param input - Turn identity, chat, history, workspace decision and optional overrides.
 * @returns The validated turn request.
 * @throws ProtocolError When the assembled request does not satisfy the protocol schema.
 */
export function buildTurnRequest(input: BuildTurnRequestInput): TurnRequest {
  const window = buildHistoryWindow(input.messages, input.budget);
  const items = [...window.items];
  const decision = input.decision;
  const restoreContext = decision.action === 'create' ? decision.restore : null;
  if (restoreContext !== null && !hasRestorationNotice(window.retained)) {
    items.push({
      role: 'system',
      content: restorationNotice({
        at: restoreContext.restoredAt,
        workBranch: restoreContext.workBranch,
      }),
    });
  }
  const expectedHeadSha = restoreContext === null ? null : restoreContext.lastPushedSha;
  return parseTurnRequest({
    protocolVersion: 1,
    turnId: input.turnId,
    model: input.model,
    instructions: input.instructions,
    items,
    repo: {
      url: input.chat.repoUrl,
      baseBranch: input.chat.baseBranch,
      workBranch: input.chat.workBranch ?? defaultWorkBranch(input.chat.id),
      ...(expectedHeadSha === null ? {} : { expectedHeadSha }),
    },
    limits: { ...DEFAULT_CHAT_TURN_LIMITS, ...input.limits },
    prepare: { clone: restoreContext !== null },
  });
}

/**
 * Builds the request for a scheduled run.
 *
 * A run has no history: it always starts in a fresh workspace with the job's prompt as its single
 * user message, which is what makes a scheduled job reproducible.
 *
 * @param input - Run identity, the job definition and optional limit overrides.
 * @returns The validated turn request.
 * @throws ProtocolError When the assembled request does not satisfy the protocol schema.
 */
export function buildJobTurnRequest(input: BuildJobTurnRequestInput): TurnRequest {
  return parseTurnRequest({
    protocolVersion: 1,
    turnId: input.runId,
    model: input.model,
    instructions: input.instructions,
    items: [{ role: 'user', content: input.job.prompt }],
    repo: {
      url: input.job.repoUrl,
      baseBranch: input.job.branch,
      workBranch: defaultWorkBranch(input.runId, JOB_WORK_BRANCH_PREFIX),
    },
    limits: { ...DEFAULT_JOB_TURN_LIMITS, ...input.limits },
    prepare: { clone: true },
  });
}
