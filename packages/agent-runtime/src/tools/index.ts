/**
 * Tool registry: the definitions published to the model and the executor that runs a call.
 *
 * Layer: domain.
 *
 * `execute` never throws. A tool call is the model's move, and an unknown name, malformed
 * arguments or a filesystem error are all things the model should see and correct — turning any
 * of them into an exception would end a turn that is still perfectly recoverable.
 */
import { toolNameSchema } from '@agent-hangar/core';
import type { ToolDefinition, ToolName } from '@agent-hangar/core';
import type { z } from 'zod';

import { createGitRunner } from '../git.js';
import type { GitRunner } from '../git.js';

import { listDir } from './list-dir.js';
import { readFile } from './read-file.js';
import { describeError, failure } from './result.js';
import type { ToolResult } from './result.js';
import { runShell } from './run-shell.js';
import type { RunShellHooks } from './run-shell.js';
import {
  listDirArgs,
  readFileArgs,
  runShellArgs,
  toToolDefinition,
  writeFileArgs,
} from './schemas.js';
import { writeFile } from './write-file.js';

/** One validation problem, as Zod reports it. */
type ZodIssue = z.ZodError['issues'][number];

/** Runs one validated tool call. */
type ToolHandler = (rawArgs: unknown, hooks: RunShellHooks) => Promise<ToolResult>;

/** Definitions published to the model, in the order they are offered. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  toToolDefinition('run_shell', runShellArgs),
  toToolDefinition('read_file', readFileArgs),
  toToolDefinition('write_file', writeFileArgs),
  toToolDefinition('list_dir', listDirArgs),
];

/** Everything the tools need from the turn. */
export interface ToolExecutorContext {
  /** Absolute workspace root; every path argument is confined to it. */
  workspaceRoot: string;
  /** Child environment, already scrubbed of the credentials. */
  childEnv: Record<string, string>;
  /** Per-command timeout from the turn's limits. */
  toolTimeoutMs: number;
  /** Byte budget per tool result from the turn's limits. */
  maxToolOutputBytes: number;
  /** Git runner; injectable for tests. */
  git?: GitRunner;
}

/** Result of a tool call; `command` is present for `run_shell`, for push detection. */
export type ToolExecutionResult = ToolResult & { command?: string };

/** Runs the tool calls the model makes. */
export interface ToolExecutor {
  /**
   * Validates and runs one tool call.
   *
   * @param name - Tool name as the model wrote it, not yet known to be valid.
   * @param rawArgs - Arguments as decoded from the model's JSON.
   * @param hooks - Output streaming and cancellation, used by `run_shell`.
   * @returns The result; a failed one rather than an exception for every recoverable problem.
   */
  execute(name: string, rawArgs: unknown, hooks?: RunShellHooks): Promise<ToolExecutionResult>;
}

/**
 * Describes one validation problem without echoing what the model wrote.
 *
 * Zod names the offending keys for an unrecognised property, and the model picked those names
 * after reading untrusted repository content, so only their number is reported.
 *
 * @param issue - The problem Zod found.
 * @returns A short description.
 */
function describeIssue(issue: ZodIssue): string {
  if (issue.code === 'unrecognized_keys') {
    return `${String(issue.keys.length)} unrecognized argument(s)`;
  }
  // Stryker disable next-line StringLiteral: every tool takes a flat object of primitives, so an
  // issue names one property and the path it is joined from is a single segment; the separator
  // between segments is written for the shape, not reached by it.
  const where = issue.path.join('.');
  return where === '' ? issue.message : `${where}: ${issue.message}`;
}

/**
 * Narrows a model-supplied name to a known tool.
 *
 * @param name - Name as the model wrote it.
 * @returns `true` when the protocol contract knows the tool.
 */
function isToolName(name: string): name is ToolName {
  return toolNameSchema.safeParse(name).success;
}

/**
 * Validates the arguments of one call, then runs the tool.
 *
 * @param schema - Argument schema of the tool.
 * @param name - Tool name, for the failure message.
 * @param rawArgs - Arguments as decoded from the model's JSON.
 * @param run - What to do with the validated arguments.
 * @returns The tool's result, or a failed one describing the validation problem.
 */
async function withValidArgs<T>(
  schema: z.ZodType<T>,
  name: ToolName,
  rawArgs: unknown,
  run: (args: T) => Promise<ToolResult>,
): Promise<ToolResult> {
  const parsed = schema.safeParse(rawArgs);
  if (parsed.success) {
    return run(parsed.data);
  }
  const details = parsed.error.issues.map(describeIssue).join('; ');
  return failure(`invalid arguments for ${name}: ${details}`);
}

/**
 * Binds each tool to the turn's context.
 *
 * @param context - Everything the tools need from the turn.
 * @param git - Git runner used by `list_dir`.
 * @returns One handler per tool name.
 */
function createHandlers(
  context: ToolExecutorContext,
  git: GitRunner,
): Record<ToolName, ToolHandler> {
  return {
    run_shell: async (rawArgs, hooks) =>
      withValidArgs(runShellArgs, 'run_shell', rawArgs, async (args) =>
        runShell(
          args,
          {
            workspaceRoot: context.workspaceRoot,
            env: context.childEnv,
            defaultTimeoutMs: context.toolTimeoutMs,
            maxOutputBytes: context.maxToolOutputBytes,
          },
          hooks,
        ),
      ),
    read_file: async (rawArgs) =>
      withValidArgs(readFileArgs, 'read_file', rawArgs, async (args) =>
        readFile(args, {
          workspaceRoot: context.workspaceRoot,
          maxOutputBytes: context.maxToolOutputBytes,
        }),
      ),
    write_file: async (rawArgs) =>
      withValidArgs(writeFileArgs, 'write_file', rawArgs, async (args) =>
        writeFile(args, { workspaceRoot: context.workspaceRoot }),
      ),
    list_dir: async (rawArgs) =>
      withValidArgs(listDirArgs, 'list_dir', rawArgs, async (args) =>
        listDir(args, {
          workspaceRoot: context.workspaceRoot,
          env: context.childEnv,
          maxOutputBytes: context.maxToolOutputBytes,
          git,
        }),
      ),
  };
}

/**
 * Creates the executor for one turn.
 *
 * @param context - Everything the tools need from the turn.
 * @returns The executor.
 */
export function createToolExecutor(context: ToolExecutorContext): ToolExecutor {
  const handlers = createHandlers(context, context.git ?? createGitRunner());
  return {
    async execute(name, rawArgs, hooks = {}) {
      if (!isToolName(name)) {
        // The name is echoed nowhere: the model chose it after reading untrusted repository
        // content, and listing the real tools is what actually helps it recover.
        return failure(`unknown tool; available tools: ${toolNameSchema.options.join(', ')}`);
      }
      try {
        return await handlers[name](rawArgs, hooks);
      } catch (error) {
        return failure(describeError(error));
      }
    },
  };
}
