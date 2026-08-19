/**
 * Default turn limits, history budget and branch naming.
 *
 * Layer: domain (pure).
 *
 * These are the values the worker sends when a caller does not override them. They live here so
 * the chat path, the scheduled-job path and the tests read the same numbers.
 */
import type { TurnLimits } from '../agent-protocol/types.js';

import type { HistoryBudget } from './history.js';

/** Milliseconds in a minute. */
const MINUTE_MS = 60_000;

/** Bytes in a kibibyte. */
const KIB = 1024;

/** How many characters of a chat or run id go into the generated branch name. */
export const WORK_BRANCH_ID_CHARS = 8;

/** Branch prefix for a chat's agent branch. */
export const CHAT_WORK_BRANCH_PREFIX = 'agent/';

/** Branch prefix for a scheduled run's agent branch. */
export const JOB_WORK_BRANCH_PREFIX = 'agent/job-';

/** Limits applied to an interactive chat turn. */
export const DEFAULT_CHAT_TURN_LIMITS: TurnLimits = {
  maxSteps: 40,
  maxTurnMs: 20 * MINUTE_MS,
  toolTimeoutMs: 5 * MINUTE_MS,
  maxToolOutputBytes: 32 * KIB,
};

/** Limits applied to a scheduled run, which may legitimately take longer than a chat turn. */
export const DEFAULT_JOB_TURN_LIMITS: TurnLimits = {
  ...DEFAULT_CHAT_TURN_LIMITS,
  maxTurnMs: 30 * MINUTE_MS,
};

/**
 * How much history a turn carries by default.
 *
 * The budget counts characters rather than tokens on purpose: a tokenizer would add a dependency
 * and a model-specific table to a package that must stay framework-free, for an estimate the
 * window does not need to be exact about. At roughly four characters per token the default is
 * about twelve thousand tokens of history, well inside every model this app supports.
 */
export const DEFAULT_HISTORY_BUDGET: HistoryBudget = { maxMessages: 60, maxChars: 48_000 };

/**
 * Derives the branch the agent commits to when the chat or job has none yet.
 *
 * @param chatOrRunId - `Chat.id` for a chat turn, `JobRun.id` for a scheduled run.
 * @param prefix - Branch prefix; defaults to the chat prefix.
 * @returns A branch name such as `agent/018f3a2b`.
 * @throws RangeError When the id is empty, which would produce a bare prefix.
 */
export function defaultWorkBranch(
  chatOrRunId: string,
  prefix: string = CHAT_WORK_BRANCH_PREFIX,
): string {
  if (chatOrRunId === '') {
    throw new RangeError('chat or run id must not be empty');
  }
  return `${prefix}${chatOrRunId.slice(0, WORK_BRANCH_ID_CHARS)}`;
}
