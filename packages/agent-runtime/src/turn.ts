/**
 * The `turn` command: read one request from stdin, run it, stream the events back.
 *
 * Layer: composition root of the runtime.
 *
 * The first thing it does is take this turn's credentials off the filesystem, before a single byte
 * is read or written. Two reasons, and both are the reason the order is not negotiable: the
 * redactor that guards everything this process emits is built from those values, and the file they
 * arrive in is unlinked as it is read — the sooner that happens, the shorter the window in which a
 * shell command the agent runs could read the same file.
 *
 * Exit codes carry only what the event stream cannot. A turn that failed on its own terms — bad
 * configuration, a repository that would not clone, a model error — still exits 0, because the
 * `turn.failed` event already says so and the worker reads it. A non-zero exit means the runtime
 * itself could not do its job, which is the one thing no event can report — and a runtime with no
 * credentials is exactly that, so it says so on both channels rather than starting a turn it
 * cannot finish.
 */
import { ConfigError } from '@agent-hangar/core';
import type { AgentEvent, TurnRequest } from '@agent-hangar/core';

import { createChildEnv, materializeGitToken, removeGitToken } from './child-env.js';
import { EXIT } from './cli.js';
import type { CliDeps, CliIo } from './cli.js';
import { CREDENTIALS_FILE_VAR, takeWorkspaceCredentials } from './credentials.js';
import type { WorkspaceCredentials } from './credentials.js';
import { createGitRunner, GitError } from './git.js';
import type { GitRunner } from './git.js';
import { runTurnLoop } from './loop.js';
import { prepare, PrepareError, repositoryUrlPolicyFromFile } from './prepare.js';
import { createDiagnostics, createEventWriter, readTurnRequest } from './protocol.js';
import type { EventWriter } from './protocol.js';
import { createProvider, resolveProviderName } from './provider.js';
import { createRuntimeRedactor } from './redact.js';
import type { RuntimeRedactor } from './redact.js';
import { createToolExecutor, TOOL_DEFINITIONS } from './tools/index.js';
import { describeError, describeErrorWithStack } from './tools/result.js';

/** Where the repository is checked out inside the workspace container. */
export const DEFAULT_WORKSPACE_ROOT = '/workspace';

/** Private directory the git token file lives in; tmpfs in the container. */
export const DEFAULT_RUNTIME_DIR = '/tmp/ah-runtime';

/** `turn.failed` code reported when this turn's credentials could not be taken off the disk. */
export const CREDENTIALS_FAILURE_CODE = 'credentials';

/**
 * Everything the turn command needs.
 *
 * It extends what the dispatcher was handed rather than restating it, so the provider wiring
 * cannot end up required in one of the two types and optional in the other: a seam that is
 * skippable through the laxer of the two is a seam that is not closed at all.
 */
export interface TurnDeps extends CliDeps {
  /** Process resources. */
  io: CliIo;
}

/** What the turn command needs to report a failure. */
interface FailureSink {
  writer: EventWriter;
  diag: (message: string) => void;
}

/**
 * Emits a `turn.failed` carrying a stable code.
 *
 * @param writer - Event writer.
 * @param code - Machine-readable cause.
 * @param message - Human-readable description; redacted on the way out.
 */
async function emitFailure(writer: EventWriter, code: string, message: string): Promise<void> {
  const event: AgentEvent = { type: 'turn.failed', error: { code, message } };
  await writer.emit(event);
}

/**
 * Maps an error that escaped the turn to an event and an exit code.
 *
 * @param error - Whatever was thrown.
 * @param sink - Where to report it.
 * @returns The process exit code.
 */
async function reportFailure(error: unknown, sink: FailureSink): Promise<number> {
  if (error instanceof ConfigError) {
    await emitFailure(sink.writer, 'config', error.message);
    return EXIT.ok;
  }
  if (error instanceof PrepareError || error instanceof GitError) {
    await emitFailure(sink.writer, 'prepare', error.message);
    return EXIT.ok;
  }
  sink.diag(describeErrorWithStack(error));
  await emitFailure(sink.writer, 'runtime', describeError(error));
  return EXIT.runtimeFailure;
}

/** Everything one turn is run against, once the credentials and the paths are settled. */
interface TurnContext {
  /** Absolute workspace root. */
  workspaceRoot: string;
  /** Child environment, already scrubbed of the credentials. */
  childEnv: Record<string, string>;
  /** Git runner shared by preparation, the tools and push detection. */
  git: GitRunner;
  /** Cancellation for the whole turn. */
  signal: AbortSignal;
  /**
   * Removes secrets from text on its way out of this process.
   *
   * @param text - Text as it was produced.
   * @returns The redacted text.
   */
  redactText: (text: string) => string;
}

/**
 * Announces the turn, prepares the workspace and runs the loop.
 *
 * @param request - The validated request.
 * @param deps - Turn dependencies.
 * @param sink - Where events are written.
 * @param context - Paths, environment and collaborators for this turn.
 * @param credentials - What the model provider and the git token file are built from.
 */
async function prepareAndRun(
  request: TurnRequest,
  deps: TurnDeps,
  sink: FailureSink,
  context: TurnContext,
  credentials: WorkspaceCredentials,
): Promise<void> {
  const { emit } = sink.writer;
  await emit({ type: 'turn.started', turnId: request.turnId, at: new Date().toISOString() });
  const provider = createProvider(
    resolveProviderName(deps.io.env),
    deps.io.env,
    deps.providerFactories,
    credentials,
  );
  const prepared = await prepare(request.repo, request.prepare, {
    workspaceRoot: context.workspaceRoot,
    git: context.git,
    env: context.childEnv,
    emit,
    urlPolicy: deps.urlPolicy ?? (await repositoryUrlPolicyFromFile(deps.originFile)),
  });
  await runTurnLoop({
    ...context,
    request,
    provider,
    // What preparation found travels on two roads on purpose. It was published as an event, which
    // is what the operator sees; this is the other consumer, and it is the one that can act on it.
    prepareNotes: prepared.notes,
    tools: createToolExecutor({
      workspaceRoot: context.workspaceRoot,
      childEnv: context.childEnv,
      toolTimeoutMs: request.limits.toolTimeoutMs,
      maxToolOutputBytes: request.limits.maxToolOutputBytes,
      git: context.git,
    }),
    toolDefinitions: TOOL_DEFINITIONS,
    emit,
    redactText: context.redactText,
    lastEmittedAt: sink.writer.lastEmittedAt,
  });
}

/**
 * Runs a validated request, owning the git token file and the cancellation subscription.
 *
 * @param request - The validated request.
 * @param deps - Turn dependencies.
 * @param sink - Where a failure is reported.
 * @param redactor - Redactor bound to this turn's credentials.
 * @param credentials - This turn's credentials.
 * @returns The process exit code.
 */
async function runRequest(
  request: TurnRequest,
  deps: TurnDeps,
  sink: FailureSink,
  redactor: RuntimeRedactor,
  credentials: WorkspaceCredentials,
): Promise<number> {
  const { io } = deps;
  const controller = new AbortController();
  const unsubscribe = io.signals.onSigint(() => {
    controller.abort();
  });
  let tokenFile: string | null = null;
  try {
    tokenFile = await materializeGitToken(
      credentials.githubToken,
      deps.runtimeDir ?? DEFAULT_RUNTIME_DIR,
    );
    await prepareAndRun(
      request,
      deps,
      sink,
      {
        workspaceRoot: deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        childEnv: createChildEnv(io.env, { tokenFile }),
        git: deps.git ?? createGitRunner(),
        signal: controller.signal,
        redactText: redactor.redactText,
      },
      credentials,
    );
    return EXIT.ok;
  } catch (error) {
    return await reportFailure(error, sink);
  } finally {
    unsubscribe();
    // The token file lives on tmpfs, but the container can outlive the turn; leaving a readable
    // credential behind for the next exec would undo the point of scrubbing the environment.
    await removeGitToken(tokenFile);
  }
}

/**
 * Reports a turn that never started because its credentials were not there to be taken.
 *
 * Both channels are used and the exit code is non-zero. The event is what the operator reads in
 * the transcript; the exit code is what distinguishes "the runtime could not do its job" from a
 * turn that ran and failed. Proceeding instead — with an empty token, or with none — would turn a
 * missing credential into an authentication failure against the real forge, which says nothing
 * about what is actually wrong.
 *
 * The redactor here holds no exact values, for the obvious reason; its shape patterns still run,
 * and the message names a path and a cause, never a content.
 *
 * @param io - Process resources.
 * @param error - Why the credentials could not be taken.
 * @returns The process exit code.
 */
async function reportMissingCredentials(io: CliIo, error: unknown): Promise<number> {
  const redactor = createRuntimeRedactor();
  const writer = createEventWriter(io.stdout, redactor);
  createDiagnostics(io.stderr, redactor)(describeErrorWithStack(error));
  await emitFailure(writer, CREDENTIALS_FAILURE_CODE, describeError(error));
  return EXIT.runtimeFailure;
}

/**
 * Runs the `turn` command.
 *
 * @param deps - Process resources and overrides.
 * @returns The process exit code.
 */
export async function runTurnCommand(deps: TurnDeps): Promise<number> {
  const { io } = deps;
  let credentials: WorkspaceCredentials;
  try {
    credentials = await takeWorkspaceCredentials(io.env[CREDENTIALS_FILE_VAR]);
  } catch (error) {
    return reportMissingCredentials(io, error);
  }
  const redactor = createRuntimeRedactor({
    values: [credentials.githubToken, credentials.openaiApiKey],
  });
  const sink: FailureSink = {
    writer: createEventWriter(io.stdout, redactor),
    diag: createDiagnostics(io.stderr, redactor),
  };
  let request: TurnRequest;
  try {
    request = await readTurnRequest(io.stdin);
  } catch (error) {
    // No turn id has been read, so there is no event that could carry this: stderr is the only
    // channel left, and the exit code is what tells the worker to look at it.
    sink.diag(describeError(error));
    return EXIT.protocolError;
  }
  return runRequest(request, deps, sink, redactor, credentials);
}
