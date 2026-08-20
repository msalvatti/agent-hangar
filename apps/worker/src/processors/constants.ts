/**
 * Every number, path and fixed text the processors use.
 *
 * Layer: contract.
 *
 * Collected here so no magic number is spelled twice and so the operational envelope of a
 * workspace — how much CPU and memory it gets, how long a cancellation is given to land, how much
 * of a tool's output is kept — is readable in one place. The turn limits themselves are not
 * restated: they are `DEFAULT_CHAT_TURN_LIMITS` and `DEFAULT_JOB_TURN_LIMITS` in the restore
 * module, which is also what the request builders default to.
 */
import type { WorkspaceLimits } from '@agent-hangar/core';
import {
  LABEL_CHAT,
  LABEL_INSTANCE,
  LABEL_JOB_RUN,
  LABEL_KIND,
  LABEL_WORKSPACE,
} from '@agent-hangar/core/runner/docker';

/** Bytes in a kibibyte. */
const KIB = 1024;

/** Milliseconds in a second. */
const SECOND_MS = 1000;

/**
 * Resource ceilings of every workspace container.
 *
 * Sized for a developer laptop running two turns at a time: two cores and 2 GiB each leaves a
 * quad-core machine room to keep serving the UI, and the process cap stops a runaway build from
 * exhausting the host's PID space rather than only the container's memory.
 */
export const WORKSPACE_LIMITS: WorkspaceLimits = {
  cpus: 2,
  memoryBytes: 2 * KIB * KIB * KIB,
  pids: 512,
};

/** The command that runs one turn inside the workspace. */
export const RUNTIME_CMD: readonly string[] = ['node', '/opt/agent-runtime/cli.js', 'turn'];

/**
 * Git credential helper inside the workspace.
 *
 * The PAT reaches git only through this helper. It is never put in the clone URL, which would
 * place it in the container's process arguments and in `.git/config`.
 */
export const ASKPASS_PATH = '/opt/agent-runtime/askpass.sh';

/**
 * Slack added to the exec's wall-clock limit on top of the turn's own.
 *
 * The runtime enforces `maxTurnMs` itself and then needs time to write its terminal event; the
 * runner's timeout is the backstop for a runtime that cannot, so it must fire later than the
 * runtime's own deadline or every long turn would be reported as a transport timeout.
 */
export const EXEC_GRACE_MS = 60 * SECOND_MS;

/** How long a cancelled turn is given to answer `SIGINT` before it is killed. */
export const CANCEL_GRACE_MS = 10 * SECOND_MS;

/** How much of a tool's output is kept on its log row for the transcript. */
export const TOOL_OUTPUT_HEAD_BYTES = 8 * KIB;

/** Longest a shutdown waits for in-flight jobs before workers are closed the hard way. */
export const SHUTDOWN_GRACE_MS = 30 * SECOND_MS;

/** `Workspace.failureReason` written when a turn's predecessor was found still holding it. */
export const STALLED_RECOVERY_REASON = 'stalled turn recovery';

/** SYSTEM message telling the model its previous filesystem is gone. */
export const STALLED_RECOVERY_NOTE =
  'Previous workspace was lost while a turn was running; a fresh workspace was created.';

/** `Turn.error` written when the processor itself failed and left the turn non-terminal. */
export const WORKER_ERROR_PREFIX = 'worker error';

/** Zero usage, recorded when a turn ends before the runtime reported any. */
export const NO_USAGE = { inputTokens: 0, outputTokens: 0, stepCount: 0 } as const;

/**
 * Container labels, as the Docker runner names them.
 *
 * Re-exported from the runner rather than respelled: the garbage collector selects containers by
 * `ah.instance`, and a label the worker wrote under one spelling and queried under another would
 * make it reap nothing while reporting success.
 */
export const LABELS = {
  instance: LABEL_INSTANCE,
  workspace: LABEL_WORKSPACE,
  kind: LABEL_KIND,
  chat: LABEL_CHAT,
  jobRun: LABEL_JOB_RUN,
} as const;
