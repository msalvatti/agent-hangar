/**
 * The `turn` command: read one request from stdin, run it, stream the events back.
 *
 * Layer: composition root of the runtime.
 *
 * Exit codes carry only what the event stream cannot. A turn that failed on its own terms — bad
 * configuration, a repository that would not clone, a model error — still exits 0, because the
 * `turn.failed` event already says so and the worker reads it. A non-zero exit means the runtime
 * itself could not do its job, which is the one thing no event can report.
 */
import { ConfigError } from '@agent-hangar/core';
import type { AgentEvent, TurnRequest } from '@agent-hangar/core';

import { createChildEnv, materializeGitToken, removeGitToken } from './child-env.js';
import { EXIT } from './cli.js';
import type { CliIo } from './cli.js';
import { createGitRunner, GitError } from './git.js';
import type { GitRunner } from './git.js';
import { runTurnLoop } from './loop.js';
import { prepare, PrepareError, repositoryUrlPolicyFromEnv } from './prepare.js';
import type { RepositoryUrlPolicy } from './prepare.js';
import { createDiagnostics, createEventWriter, readTurnRequest } from './protocol.js';
import type { EventWriter } from './protocol.js';
import { createProvider, resolveProviderName } from './provider.js';
import type { ProviderFactories } from './provider.js';
import { createRuntimeRedactor } from './redact.js';
import type { RuntimeRedactor } from './redact.js';
import { createToolExecutor, TOOL_DEFINITIONS } from './tools/index.js';
import { describeError, describeErrorWithStack } from './tools/result.js';

/** Where the repository is checked out inside the workspace container. */
export const DEFAULT_WORKSPACE_ROOT = '/workspace';

/** Private directory the git token file lives in; tmpfs in the container. */
export const DEFAULT_RUNTIME_DIR = '/tmp/ah-runtime';

/** Everything the turn command needs. */
export interface TurnDeps {
  /** Process resources. */
  io: CliIo;
  /** Factories for providers this build cannot construct on its own. */
  providerFactories?: ProviderFactories;
  /** Overrides the workspace root; tests point it at a temporary directory. */
  workspaceRoot?: string;
  /** Overrides the private runtime directory. */
  runtimeDir?: string;
  /** Overrides the git runner. */
  git?: GitRunner;
  /**
   * Overrides the repository URL policy, which is otherwise read from the container environment;
   * tests use `{ allow: 'any' }` for a local `file://` remote.
   */
  urlPolicy?: RepositoryUrlPolicy;
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
 */
async function prepareAndRun(
  request: TurnRequest,
  deps: TurnDeps,
  sink: FailureSink,
  context: TurnContext,
): Promise<void> {
  const { emit } = sink.writer;
  await emit({ type: 'turn.started', turnId: request.turnId, at: new Date().toISOString() });
  const provider = createProvider(
    resolveProviderName(deps.io.env),
    deps.io.env,
    deps.providerFactories,
  );
  await prepare(request.repo, request.prepare, {
    workspaceRoot: context.workspaceRoot,
    git: context.git,
    env: context.childEnv,
    emit,
    urlPolicy: deps.urlPolicy ?? repositoryUrlPolicyFromEnv(deps.io.env),
  });
  await runTurnLoop({
    ...context,
    request,
    provider,
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
 * Runs a validated request, owning the credential file and the cancellation subscription.
 *
 * @param request - The validated request.
 * @param deps - Turn dependencies.
 * @param sink - Where a failure is reported.
 * @param redactor - Redactor bound to this container's credentials.
 * @returns The process exit code.
 */
async function runRequest(
  request: TurnRequest,
  deps: TurnDeps,
  sink: FailureSink,
  redactor: RuntimeRedactor,
): Promise<number> {
  const { io } = deps;
  const controller = new AbortController();
  const unsubscribe = io.signals.onSigint(() => {
    controller.abort();
  });
  let tokenFile: string | null = null;
  try {
    tokenFile = await materializeGitToken(io.env, deps.runtimeDir ?? DEFAULT_RUNTIME_DIR);
    await prepareAndRun(request, deps, sink, {
      workspaceRoot: deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
      childEnv: createChildEnv(io.env, { tokenFile }),
      git: deps.git ?? createGitRunner(),
      signal: controller.signal,
      redactText: redactor.redactText,
    });
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
 * Runs the `turn` command.
 *
 * @param deps - Process resources and overrides.
 * @returns The process exit code.
 */
export async function runTurnCommand(deps: TurnDeps): Promise<number> {
  const { io } = deps;
  const redactor = createRuntimeRedactor({ values: [io.env.GITHUB_TOKEN, io.env.OPENAI_API_KEY] });
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
  return runRequest(request, deps, sink, redactor);
}
