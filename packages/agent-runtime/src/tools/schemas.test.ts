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
  TOOL_SCHEMAS,
  toToolDefinition,
  writeFileArgs,
} from './schemas.js';

describe('tool argument schemas', () => {
  it.each([
    ['run_shell', runShellArgs, { command: 'ls', cwd: null, timeoutMs: null }],
    ['read_file', readFileArgs, { path: 'a.ts', startLine: 1, endLine: 10 }],
    ['write_file', writeFileArgs, { path: 'NOTES.md', content: '# Notes\n' }],
    ['list_dir', listDirArgs, { path: '.', depth: 2 }],
  ])('accepts the documented %s call', (_name, schema, value) => {
    // These are exactly the shapes the tool descriptions promise the model.
    expect(schema.safeParse(value).success).toBe(true);
  });

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
    // Invalid arguments become a failed tool result, so the model can correct itself.
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('covers every tool the protocol contract names', () => {
    // A tool published without a schema would reach the executor unvalidated.
    expect(Object.keys(TOOL_SCHEMAS).toSorted()).toStrictEqual([
      'list_dir',
      'read_file',
      'run_shell',
      'write_file',
    ]);
  });
});

describe('toToolDefinition', () => {
  it('projects a schema with no additional properties and every property required', () => {
    // Strict function calling rejects a schema that allows either.
    const definition = toToolDefinition('run_shell', runShellArgs);
    expect(definition.name).toBe('run_shell');
    expect(definition.description.length).toBeGreaterThan(0);
    expect(definition.parameters.additionalProperties).toBe(false);
    expect(definition.parameters.required).toStrictEqual(['command', 'cwd', 'timeoutMs']);
  });

  it('encodes an optional argument as a nullable one that is always present', () => {
    // Strict mode has no notion of an omitted property, so optionality travels as null.
    const properties = toToolDefinition('run_shell', runShellArgs).parameters.properties;
    expect(properties).toMatchObject({ cwd: { anyOf: [{ type: 'string' }, { type: 'null' }] } });
  });

  it('refuses a schema that would let the model pass unknown arguments', () => {
    // The check runs at module initialisation, so this can never ship unnoticed.
    expect(() => toToolDefinition('run_shell', z.looseObject({ command: z.string() }))).toThrow(
      'must forbid additional properties',
    );
  });

  it('refuses a schema with a property the model may omit', () => {
    // A provider asked for strict mode rejects the call rather than defaulting the property.
    expect(() =>
      toToolDefinition(
        'read_file',
        z.strictObject({ path: z.string(), startLine: z.number().optional() }),
      ),
    ).toThrow('every property must be required, missing startLine');
  });
});
