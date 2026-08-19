/**
 * Argument schemas of the four tools, and their JSON Schema projection for the model.
 *
 * Layer: contract.
 *
 * Providers are asked for strict function calling, which requires every property to be listed in
 * `required` and `additionalProperties` to be `false`. An optional argument is therefore expressed
 * as a nullable one that is always present, and {@link toToolDefinition} refuses to publish a
 * schema that does not hold up — a shape the provider would reject at call time, or silently
 * degrade, is caught here instead.
 */
import type { ToolDefinition, ToolName } from '@agent-hangar/core';
import { z } from 'zod';

/** Arguments of `run_shell`. */
export const runShellArgs = z
  .object({
    command: z.string().min(1),
    cwd: z.string().nullable(),
    timeoutMs: z.number().int().positive().nullable(),
  })
  .strict();

/** Arguments of `read_file`. */
export const readFileArgs = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
  })
  .strict();

/** Arguments of `write_file`. */
export const writeFileArgs = z.object({ path: z.string().min(1), content: z.string() }).strict();

/** Deepest directory tree `list_dir` will walk. */
export const MAX_LIST_DIR_DEPTH = 5;

/** Arguments of `list_dir`. */
export const listDirArgs = z
  .object({
    path: z.string().nullable(),
    depth: z.number().int().min(1).max(MAX_LIST_DIR_DEPTH).nullable(),
  })
  .strict();

/** Argument schema of every tool, keyed by tool name. */
export const TOOL_SCHEMAS = {
  run_shell: runShellArgs,
  read_file: readFileArgs,
  write_file: writeFileArgs,
  list_dir: listDirArgs,
} as const satisfies Record<ToolName, z.ZodType>;

/** Validated arguments of `run_shell`. */
export type RunShellArgs = z.infer<typeof runShellArgs>;

/** Validated arguments of `read_file`. */
export type ReadFileArgs = z.infer<typeof readFileArgs>;

/** Validated arguments of `write_file`. */
export type WriteFileArgs = z.infer<typeof writeFileArgs>;

/** Validated arguments of `list_dir`. */
export type ListDirArgs = z.infer<typeof listDirArgs>;

/** Descriptions the model reads when deciding which tool to call. */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  run_shell:
    'Run a shell command with `bash -lc` inside the workspace. `cwd` is relative to the workspace ' +
    'root and defaults to it; `timeoutMs` overrides the per-command timeout, after which the ' +
    'command and its children are killed. Combined stdout and stderr come back in arrival order, ' +
    'truncated with a notice when they exceed the turn budget, together with the exit code. Use ' +
    'this for git: clone, commit and push all work here.',
  read_file:
    'Read a UTF-8 text file from the workspace and return it as numbered lines. `startLine` and ' +
    '`endLine` are 1-based and inclusive, are clamped to the file, and default to the whole file ' +
    'when null. Long files are truncated with a notice.',
  write_file:
    'Write UTF-8 text to a file in the workspace, replacing it if it exists and creating any ' +
    'missing parent directories. Returns the number of bytes written.',
  list_dir:
    'List the entries of a directory in the workspace. `path` defaults to the workspace root and ' +
    `\`depth\` to 1, at most ${String(MAX_LIST_DIR_DEPTH)}. Inside a git repository the listing ` +
    'follows `.gitignore` and skips ignored files; directories end with a slash and the listing ' +
    'is capped, with a note naming how many entries were left out.',
};

/**
 * Projects a Zod schema to the JSON Schema a provider is given, and verifies it is strict.
 *
 * @param name - Tool name as the model will call it.
 * @param schema - Argument schema.
 * @returns The tool definition.
 * @throws Error when the projection is not usable for strict function calling, which would
 *   otherwise surface as a provider error in the middle of a turn.
 */
export function toToolDefinition(name: ToolName, schema: z.ZodType): ToolDefinition {
  const parameters = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  if (parameters.additionalProperties !== false) {
    throw new Error(`tool ${name}: schema must forbid additional properties`);
  }
  // Spreading and passing straight through cope with a projection that omits either keyword,
  // which is how JSON Schema expresses "no properties" and "nothing required".
  const properties = Object.keys({ ...parameters.properties });
  const required = new Set<string>(parameters.required);
  const missing = properties.filter((property) => !required.has(property));
  if (missing.length > 0) {
    throw new Error(`tool ${name}: every property must be required, missing ${missing.join(', ')}`);
  }
  return { name, description: TOOL_DESCRIPTIONS[name], parameters };
}
