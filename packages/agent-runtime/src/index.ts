// Public API of @agent-hangar/agent-runtime: the command dispatcher, the turn machinery and the
// protocol adapters. `bin.ts` is the process entry point and is deliberately not re-exported.
export { createNodeIo, EXIT, runCli } from './cli.js';
export type { CliIo, CliOverrides } from './cli.js';
export { builtInFakeScript } from './fake-scripts.js';
export { createGitRunner, GitError, gitOrThrow } from './git.js';
export type { GitArgs, GitCommandResult, GitRunner, GitRunOptions } from './git.js';
export { looksLikeGitPush, resolveGitHead } from './git-events.js';
export { runTurnLoop } from './loop.js';
export type { LoopDeps, LoopOutcome } from './loop.js';
export {
  ALLOWED_ORIGIN_VAR,
  assertBranchName,
  prepare,
  PrepareError,
  repositoryUrlPolicyFromEnv,
  resolveRepoUrl,
} from './prepare.js';
export type { PrepareDeps, PrepareResult, RepositoryUrlPolicy } from './prepare.js';
export { createDiagnostics, createEventWriter, readTurnRequest } from './protocol.js';
export type { EventWriter } from './protocol.js';
export { createProvider, resolveProviderName } from './provider.js';
export type { ProviderFactories } from './provider.js';
export { createRuntimeRedactor, REDACTED } from './redact.js';
export type { RuntimeRedactor, RuntimeRedactorOptions } from './redact.js';
export { createToolExecutor, TOOL_DEFINITIONS } from './tools/index.js';
export type { ToolExecutionResult, ToolExecutor, ToolExecutorContext } from './tools/index.js';
export { runTurnCommand } from './turn.js';
export type { TurnDeps } from './turn.js';
export { RUNTIME_VERSION } from './version.js';
