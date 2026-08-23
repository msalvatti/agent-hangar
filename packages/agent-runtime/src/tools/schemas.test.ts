/**
 * Unit tests for the tool argument schemas and their JSON Schema projection.
 *
 * Layer: unit.
 * Goal: each schema accepts the documented call and rejects extra or wrong-typed arguments, and
 * the projection satisfies what strict function calling demands — no additional properties, every
 * property required, optional arguments expressed as nullable ones.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  listDirArgs,
  MAX_LIST_DIR_DEPTH,
  readFileArgs,
  runShellArgs,
  TOOL_DESCRIPTIONS,
  TOOL_SCHEMAS,
  toToolDefinition,
  writeFileArgs,
} from './schemas.js';

describe('tool argument schemas', () => {
  /** These are exactly the shapes the tool descriptions promise the model. */
  it.each([
    ['run_shell', runShellArgs, { command: 'ls', cwd: null, timeoutMs: null }],
    ['read_file', readFileArgs, { path: 'a.ts', startLine: 1, endLine: 10 }],
    ['write_file', writeFileArgs, { path: 'NOTES.md', content: '# Notes\n' }],
    ['list_dir', listDirArgs, { path: '.', depth: 2 }],
  ])('accepts the documented %s call', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(true);
  });

  /** Invalid arguments become a failed tool result, so the model can correct itself. */
  it.each([
    [
      'an unknown property',
      runShellArgs,
      { command: 'ls', cwd: null, timeoutMs: null, shell: 'zsh' },
    ],
    ['a wrong type', runShellArgs, { command: 42, cwd: null, timeoutMs: null }],
    ['an empty command', runShellArgs, { command: '', cwd: null, timeoutMs: null }],
    ['a zero line number', readFileArgs, { path: 'a.ts', startLine: 0, endLine: null }],
    ['a fractional line number', readFileArgs, { path: 'a.ts', startLine: 1.5, endLine: null }],
    ['a missing property', writeFileArgs, { path: 'a.ts' }],
    ['a depth past the maximum', listDirArgs, { path: null, depth: MAX_LIST_DIR_DEPTH + 1 }],
    ['a depth below one', listDirArgs, { path: null, depth: 0 }],
  ])('rejects %s', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  /** A tool published without a schema would reach the executor unvalidated. */
  it('covers every tool the protocol contract names', () => {
    expect(Object.keys(TOOL_SCHEMAS).toSorted()).toStrictEqual([
      'list_dir',
      'read_file',
      'run_shell',
      'write_file',
    ]);
  });
});

describe('toToolDefinition', () => {
  /** Strict function calling rejects a schema that allows either. */
  it('projects a schema with no additional properties and every property required', () => {
    const definition = toToolDefinition('run_shell', runShellArgs);
    expect(definition.name).toBe('run_shell');
    expect(definition.parameters.additionalProperties).toBe(false);
    expect(definition.parameters.required).toStrictEqual(['command', 'cwd', 'timeoutMs']);
  });

  /**
   * The dialect the provider is handed. It is not named at the call site, so this is what would
   * notice a Zod release changing its default out from under the projection.
   */
  it('projects into the JSON Schema dialect strict function calling is defined against', () => {
    expect(toToolDefinition('run_shell', runShellArgs).parameters.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
  });

  /** Strict mode has no notion of an omitted property, so optionality travels as null. */
  it('encodes an optional argument as a nullable one that is always present', () => {
    const properties = toToolDefinition('run_shell', runShellArgs).parameters.properties;
    expect(properties).toMatchObject({ cwd: { anyOf: [{ type: 'string' }, { type: 'null' }] } });
  });

  /** The check runs at module initialisation, so this can never ship unnoticed. */
  it('refuses a schema that would let the model pass unknown arguments', () => {
    expect(() => toToolDefinition('run_shell', z.looseObject({ command: z.string() }))).toThrow(
      'must forbid additional properties',
    );
  });

  /** A provider asked for strict mode rejects the call rather than defaulting the property. */
  it('refuses a schema with a property the model may omit', () => {
    expect(() =>
      toToolDefinition(
        'read_file',
        z.strictObject({ path: z.string(), startLine: z.number().optional() }),
      ),
    ).toThrow('every property must be required, missing startLine');
  });

  /**
   * With one omitted property the separator between names never appears, so the message reads the
   * same whether or not there is one. Two of them is where a missing separator runs the names
   * together into a word that matches no property the author has to go and fix.
   */
  it('names every omitted property, separated, when more than one may be left out', () => {
    expect(() =>
      toToolDefinition(
        'read_file',
        z.strictObject({
          path: z.string(),
          startLine: z.number().optional(),
          endLine: z.number().optional(),
        }),
      ),
    ).toThrow('tool read_file: every property must be required, missing startLine, endLine');
  });
});

describe('TOOL_DESCRIPTIONS', () => {
  /**
   * These are the instructions the model reads before it decides which tool to call, and they are
   * the only place several of the runtime's rules are stated to it: that `cwd` is relative to the
   * workspace root, that output is truncated with a notice, that `depth` has a ceiling, that git
   * work goes through the shell. A sentence quietly lost from one of them degrades every turn and
   * fails nothing, which is exactly what happened here — the projection test asked only that the
   * description was not empty, and thirteen separate fragments could be emptied under it.
   */
  it.each([
    [
      'run_shell',
      'Run a shell command with `bash -lc` inside the workspace. `cwd` is relative to the ' +
        'workspace root and defaults to it; `timeoutMs` overrides the per-command timeout, after ' +
        'which the command and its children are killed. Combined stdout and stderr come back in ' +
        'arrival order, truncated with a notice when they exceed the turn budget, together with ' +
        'the exit code. Use this for git: clone, commit and push all work here.',
    ],
    [
      'read_file',
      'Read a UTF-8 text file from the workspace and return it as numbered lines. `startLine` ' +
        'and `endLine` are 1-based and inclusive, are clamped to the file, and default to the ' +
        'whole file when null. Long files are truncated with a notice.',
    ],
    [
      'write_file',
      'Write UTF-8 text to a file in the workspace, replacing it if it exists and creating any ' +
        'missing parent directories. Returns the number of bytes written.',
    ],
    [
      'list_dir',
      'List the entries of a directory in the workspace. `path` defaults to the workspace root ' +
        'and `depth` to 1, at most 5. Inside a git repository the listing follows `.gitignore` ' +
        'and skips ignored files; directories end with a slash and the listing is capped, with a ' +
        'note naming how many entries were left out.',
    ],
  ])('tells the model what %s does, in full', (tool, description) => {
    expect(TOOL_DESCRIPTIONS[tool as keyof typeof TOOL_DESCRIPTIONS]).toBe(description);
  });

  /** The ceiling the prose quotes is the one the schema enforces, not a number typed twice. */
  it('quotes the depth ceiling the schema actually enforces', () => {
    expect(TOOL_DESCRIPTIONS.list_dir).toContain(`at most ${String(MAX_LIST_DIR_DEPTH)}.`);
  });
});
