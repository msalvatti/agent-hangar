/**
 * Named timeouts, ports and prompts shared by the end-to-end harness and every spec.
 *
 * Layer: test support (pure).
 *
 * Specs never sleep for a fixed duration: they poll a condition with one of the timeouts below,
 * so a slow machine waits longer while a broken one still fails, and a reader can tell from the
 * name which budget an assertion is spending.
 */

/** Budget for a whole chat turn to reach a terminal status (clone, model loop, tools). */
export const TURN_TIMEOUT_MS = 90_000;

/** Budget for a cancelled turn to report `CANCELLED`; the product promises this is prompt. */
export const CANCEL_TIMEOUT_MS = 5_000;

/** Interval between health polls. */
export const HEALTH_POLL_MS = 500;

/** Budget for the worker to report a heartbeat the web server can see. */
export const WORKER_READY_TIMEOUT_MS = 60_000;

/** Budget for a cancelled turn to reach a terminal state during the per-test reset. */
export const TURN_SETTLE_TIMEOUT_MS = 30_000;

/** Budget for a workspace to disappear after its chat is archived. */
export const WORKSPACE_GONE_TIMEOUT_MS = 60_000;

/** Budget for a manually triggered scheduled run to finish. */
export const JOB_RUN_TIMEOUT_MS = 90_000;

/** Budget for an API-visible state change that follows a UI action already observed. */
export const API_SETTLE_TIMEOUT_MS = 10_000;

/** Offsets of the instance's ten-port block, extending the three core ports with the fixtures. */
export const PORT_OFFSETS = {
  web: 0,
  postgres: 1,
  redis: 2,
  gitserver: 7,
  githubStub: 8,
} as const;

/** Address every harness-side client dials; nothing here is reachable off the machine. */
export const LOOPBACK = '127.0.0.1';

/** Port base of the end-to-end instance when `E2E_PORT_BASE` is unset. */
export const DEFAULT_PORT_BASE = 3900;

/** Instance name the suite runs against; nothing here may touch a developer's `default`. */
export const TEST_INSTANCE = 'test';

/** Bare repository the local git server seeds, as the GitHub stub names it. */
export const SAMPLE_REPO = 'e2e/sample';

/** Default branch of the seed repository. */
export const SAMPLE_BRANCH = 'main';

/**
 * Prompts the fake model provider is scripted for. A spec must use these exact strings: the
 * provider selects its script by the text of the last user message.
 */
export const PROMPTS = {
  createNotes: 'list files and create NOTES.md',
  printDate: 'print date',
  showNotes: 'show NOTES.md',
  sleepLong: 'sleep for sixty seconds',
  writeToken: 'write the token to a file',
} as const;
