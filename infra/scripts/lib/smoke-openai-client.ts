/**
 * The HTTP steps of the real-model smoke check: preconditions, the chat it creates, and the
 * cleanup that releases the workspace afterwards.
 *
 * Layer: service (client of the running instance's public HTTP API).
 *
 * The check drives the same routes a browser drives, which is the whole point: the credential path
 * it exercises has to be the product's own. No credential passes through this module — the GitHub
 * PAT and the OpenAI key are decrypted by the worker, and `GET /api/settings` reports only whether
 * each one is set.
 *
 * Two rules shape the error handling. A transport failure before anything exists aborts, naming
 * the route rather than the URL, because an operator may have spelt credentials into `--base-url`
 * and a library's own message is not something this module can bound. A failure during cleanup
 * does not abort: a result is already in hand by then and must not be replaced by the failure of
 * the step that tidies up after it.
 */
import {
  buildPath,
  createChatResponse,
  healthResponse,
  routes,
  settingsStatus,
} from '../../../packages/core/src/api/contracts.js';

import {
  EXIT_FAILED,
  EXIT_PRECONDITION,
  SETTINGS_MISSING_MESSAGE,
  SMOKE_PROMPT,
} from './smoke-openai-options.js';
import type { SmokeOptions } from './smoke-openai-options.js';

/**
 * Header proving to the API's same-origin guard that a write did not come from another site.
 *
 * The guard accepts either a matching `Origin` or this header. This check sends the header rather
 * than an origin on purpose: an `Origin` has to equal the scheme and `Host` the *server* resolved,
 * which a proxy or a host alias can change, whereas `Sec-Fetch-Site` says what a browser would say
 * for a same-site request and depends on nothing the operator's URL spelling can shift.
 */
const SAME_SITE_HEADERS: Readonly<Record<string, string>> = { 'sec-fetch-site': 'same-origin' };

/**
 * Attempts of the cleanup delete before the workspace is reported as possibly left behind.
 *
 * The delete is refused with `409 TURN_IN_PROGRESS` while a turn of the chat is still live, and
 * the transcript reaches `turn.completed` a moment before the worker writes that turn's terminal
 * status, so a delete issued the instant the stream closes can lose a race it will win a moment
 * later. Retrying is what turns that ordering into a wait instead of a false report.
 */
const CLEANUP_ATTEMPTS = 20;

/** Pause between cleanup attempts, in milliseconds. */
const CLEANUP_RETRY_MS = 500;

/** Status the API answers while the chat's state does not admit the request. */
const HTTP_CONFLICT = 409;

/** Headers of every JSON request. */
const JSON_HEADERS: Readonly<Record<string, string>> = { accept: 'application/json' };

/** Collaborators of {@link runSmoke}, injectable for tests. */
export interface SmokeDeps {
  /** `fetch` implementation. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Monotonic-enough clock used only for the reported duration. */
  now: () => number;
  /** Writes one line of the report. */
  log: (line: string) => void;
}

/** A step that ended the check early, carrying the exit code to report. */
export class SmokeAbort extends Error {
  /** Exit code this abort maps to. */
  readonly exitCode: number;

  /**
   * @param exitCode - Code to exit with.
   * @param message - Message to print; composed here, never taken from a library.
   */
  constructor(exitCode: number, message: string) {
    super(message);
    this.name = 'SmokeAbort';
    this.exitCode = exitCode;
  }
}

/**
 * Names an unexpected error by its class alone.
 *
 * The message of an error this module did not construct is outside its control, and this output is
 * written to be pasted; a constructor name is machine-generated and cannot carry a credential,
 * while still telling an operator whether they are looking at a `TypeError` or a `SyntaxError`.
 *
 * @param error - Whatever was thrown.
 * @returns The error's class name, or `unknown`.
 */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Issues one request, mapping a transport failure to an abort that names the route.
 *
 * The URL never appears in the message: an operator may have spelt credentials into `--base-url`,
 * and a library's own error text is not something this module can bound.
 *
 * @param deps - Injected collaborators.
 * @param options - Resolved command line.
 * @param path - Route path, including any query string.
 * @param init - Request init.
 * @param exitCode - Code to abort with when the request cannot be made.
 * @returns The response, whatever its status.
 * @throws SmokeAbort when the request could not be issued at all.
 */
async function send(
  deps: SmokeDeps,
  options: SmokeOptions,
  path: string,
  init: RequestInit,
  exitCode: number,
): Promise<Response> {
  try {
    return await deps.fetch(`${options.baseUrl}${path}`, init);
  } catch (error) {
    throw new SmokeAbort(
      exitCode,
      `cannot reach ${path} (${errorName(error)}) — start the instance with: pnpm dev`,
    );
  }
}

/**
 * Reads a response body as JSON.
 *
 * @param response - A response that should carry JSON.
 * @param path - Route path, for the message.
 * @param exitCode - Code to abort with.
 * @returns The decoded value.
 * @throws SmokeAbort when the status is not 2xx or the body is not JSON.
 */
async function readJson(response: Response, path: string, exitCode: number): Promise<unknown> {
  if (!response.ok) {
    throw new SmokeAbort(exitCode, `${path} answered HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new SmokeAbort(exitCode, `${path} did not answer JSON (${errorName(error)})`);
  }
}

/**
 * Reports the health rows that are not ready.
 *
 * @param checks - The `checks` block of the health response.
 * @returns Names of the failing rows.
 */
function failingChecks(checks: Record<string, { ok: boolean }>): string[] {
  return Object.entries(checks)
    .filter(([, check]) => !check.ok)
    .map(([name]) => name);
}

/**
 * Asserts the instance can run a turn at all, and reports the model it will use.
 *
 * The health route covers the database, Redis, Docker and the workspace image. It says nothing
 * about the worker, which has no row: a stopped worker shows up later as a turn that never leaves
 * the queue, and the timeout message names that possibility rather than pretending it was checked.
 *
 * @param options - Resolved command line.
 * @param deps - Injected collaborators.
 * @returns The model id the instance reports.
 * @throws SmokeAbort with {@link EXIT_PRECONDITION} when the instance is not ready.
 */
export async function preflight(options: SmokeOptions, deps: SmokeDeps): Promise<string> {
  const healthPath = routes.health;
  const health = healthResponse.safeParse(
    await readJson(
      await send(deps, options, healthPath, { headers: JSON_HEADERS }, EXIT_PRECONDITION),
      healthPath,
      EXIT_PRECONDITION,
    ),
  );
  if (!health.success) {
    throw new SmokeAbort(EXIT_PRECONDITION, `${healthPath} answered an unrecognised body`);
  }
  const failing = failingChecks(health.data.checks);
  if (failing.length > 0) {
    throw new SmokeAbort(EXIT_PRECONDITION, `instance not ready: ${failing.join(', ')}`);
  }
  deps.log(`health ok instance=${health.data.instance}`);

  const settingsPath = routes.settings;
  const settings = settingsStatus.safeParse(
    await readJson(
      await send(deps, options, settingsPath, { headers: JSON_HEADERS }, EXIT_PRECONDITION),
      settingsPath,
      EXIT_PRECONDITION,
    ),
  );
  if (!settings.success) {
    throw new SmokeAbort(EXIT_PRECONDITION, `${settingsPath} answered an unrecognised body`);
  }
  if (!settings.data.githubPat.set || !settings.data.openaiKey.set) {
    throw new SmokeAbort(EXIT_PRECONDITION, SETTINGS_MISSING_MESSAGE);
  }
  deps.log(`settings ok model=${settings.data.model}`);
  return settings.data.model;
}

/**
 * Creates the chat, which also queues its first turn.
 *
 * @param options - Resolved command line.
 * @param deps - Injected collaborators.
 * @returns The chat and turn identifiers.
 * @throws SmokeAbort with {@link EXIT_FAILED} when the chat cannot be created.
 */
export async function createChat(
  options: SmokeOptions,
  deps: SmokeDeps,
): Promise<{ chatId: string; turnId: string }> {
  const path = routes.chats;
  const response = await send(
    deps,
    options,
    path,
    {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...SAME_SITE_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({
        repoUrl: options.repoUrl,
        baseBranch: options.branch,
        prompt: SMOKE_PROMPT,
      }),
    },
    EXIT_FAILED,
  );
  const parsed = createChatResponse.safeParse(await readJson(response, path, EXIT_FAILED));
  if (!parsed.success) {
    throw new SmokeAbort(EXIT_FAILED, `${path} answered an unrecognised body`);
  }
  return parsed.data;
}

/**
 * Waits, so a refused cleanup can be retried rather than reported.
 *
 * @param ms - How long to wait.
 * @returns A promise that settles after `ms`.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Issues one request on the cleanup path, where a transport failure is an outcome rather than an
 * abort: this runs after a result is already in hand and must not replace it.
 *
 * @param deps - Injected collaborators.
 * @param options - Resolved command line.
 * @param path - Route path.
 * @param init - Request init.
 * @returns The response, or `null` when the request could not be issued.
 */
async function tryFetch(
  deps: SmokeDeps,
  options: SmokeOptions,
  path: string,
  init: RequestInit,
): Promise<Response | null> {
  try {
    return await deps.fetch(`${options.baseUrl}${path}`, init);
  } catch {
    // Deliberately not inspected: the caller reports "unreachable", and the message of an error
    // this module did not compose is not something it can promise is free of credentials.
    return null;
  }
}

/**
 * Deletes the chat, which is what asks the worker to tear its workspace down.
 *
 * Never throws: it runs on the failure path too, where the failure being reported must not be
 * replaced by this one. A chat left behind is still reported, because a check that creates a
 * container and cannot say whether it released it has not finished.
 *
 * @param options - Resolved command line.
 * @param deps - Injected collaborators.
 * @param chat - The chat to delete and the turn it queued.
 * @param turnUnfinished - Whether the turn never reported an outcome, so it may still hold the
 * container and has to be cancelled first.
 * @returns The line to print, and whether the chat ended in the state the operator asked for —
 * deleted, or deliberately kept.
 */
export async function cleanupChat(
  options: SmokeOptions,
  deps: SmokeDeps,
  chat: { chatId: string; turnId: string },
  turnUnfinished: boolean,
): Promise<{ line: string; settled: boolean }> {
  if (options.keep) {
    return { line: `cleanup skipped (--keep) chat=${chat.chatId}`, settled: true };
  }
  if (turnUnfinished) {
    // The turn never reported an outcome, so it may still hold the container. Cancelling is what
    // ends it; its own refusal (the turn finished after all) is an answer, not a problem.
    const cancelPath = buildPath(routes.turnCancel, { id: chat.turnId });
    const cancelled = await tryFetch(deps, options, cancelPath, {
      method: 'POST',
      headers: SAME_SITE_HEADERS,
    });
    deps.log(
      `cancel turn=${chat.turnId} ${cancelled === null ? 'unreachable' : `HTTP ${cancelled.status}`}`,
    );
  }
  const path = buildPath(routes.chat, { id: chat.chatId });
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    const response = await tryFetch(deps, options, path, {
      method: 'DELETE',
      headers: SAME_SITE_HEADERS,
    });
    if (response === null) {
      return { line: `cleanup failed chat=${chat.chatId} unreachable`, settled: false };
    }
    if (response.ok) {
      return { line: `cleanup ok chat=${chat.chatId} workspace teardown queued`, settled: true };
    }
    if (response.status !== HTTP_CONFLICT) {
      return {
        line: `cleanup failed chat=${chat.chatId} HTTP ${response.status}`,
        settled: false,
      };
    }
    if (attempt < CLEANUP_ATTEMPTS) {
      await sleep(CLEANUP_RETRY_MS);
    }
  }
  return {
    line: `cleanup failed chat=${chat.chatId} still HTTP ${HTTP_CONFLICT} after ${CLEANUP_ATTEMPTS} attempts`,
    settled: false,
  };
}
