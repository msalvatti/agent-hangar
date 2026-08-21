/**
 * Unit tests for the tool registry and executor.
 *
 * Layer: unit.
 * Goal: the four tools are published in a shape a provider will accept, every call is dispatched
 * to the right implementation, and nothing the model can write — an unknown name, malformed
 * arguments, a path that makes the filesystem throw — escapes as an exception.
 * Mocks: none; a real temporary directory stands in for `/workspace`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { toolNameSchema } from '@agent-hangar/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createChildEnv } from '../child-env.js';
import { makeTempDir, removeTempDir } from '../testing/temp-dir.js';

import { createToolExecutor, TOOL_DEFINITIONS } from './index.js';
import type { ToolExecutor, ToolExecutorContext } from './index.js';

let root: string;
let context: ToolExecutorContext;
let executor: ToolExecutor;

beforeEach(async () => {
  root = await makeTempDir('tool-executor');
  context = {
    workspaceRoot: root,
    childEnv: createChildEnv({ PATH: process.env.PATH }, { tokenFile: null }),
    toolTimeoutMs: 10_000,
    maxToolOutputBytes: 32_768,
  };
  executor = createToolExecutor(context);
});

afterEach(async () => {
  await removeTempDir(root);
});

describe('TOOL_DEFINITIONS', () => {
  /** The worker validates every `tool.call` against the same union of names. */
  it('publishes exactly the tools the protocol contract names', () => {
    expect(TOOL_DEFINITIONS.map((definition) => definition.name)).toStrictEqual([
      ...toolNameSchema.options,
    ]);
  });

  /** A provider asked for strict function calling rejects anything looser. */
  it('gives every tool a description and a strict parameter schema', () => {
    for (const definition of TOOL_DEFINITIONS) {
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.parameters.additionalProperties).toBe(false);
    }
  });
});

describe('createToolExecutor', () => {
  /** The loop needs the command to decide whether a push happened. */
  it('dispatches a run_shell call and reports the command back', async () => {
    const result = await executor.execute('run_shell', {
      command: 'echo hello',
      cwd: null,
      timeoutMs: null,
    });
    expect(result).toMatchObject({ status: 'SUCCEEDED', output: 'hello\n', command: 'echo hello' });
  });

  /** The two halves of the model's normal edit cycle. */
  it('dispatches a write_file call and then a read_file call', async () => {
    await executor.execute('write_file', { path: 'NOTES.md', content: '# Notes\n' });
    await expect(readFile(path.join(root, 'NOTES.md'), 'utf8')).resolves.toBe('# Notes\n');
    const read = await executor.execute('read_file', {
      path: 'NOTES.md',
      startLine: null,
      endLine: null,
    });
    expect(read.output).toContain('1\t# Notes');
  });

  /** The listing is usually the model's first move in a fresh workspace. */
  it('dispatches a list_dir call', async () => {
    await executor.execute('write_file', { path: 'a.txt', content: 'x' });
    const result = await executor.execute('list_dir', { path: null, depth: null });
    expect(result.output).toBe('a.txt');
  });

  /** The name came from a model that had read untrusted repository content. */
  it('fails an unknown tool without echoing the name the model invented', async () => {
    const result = await executor.execute('rm_rf', { path: '/' });
    expect(result).toMatchObject({
      status: 'FAILED',
      output: 'unknown tool; available tools: run_shell, read_file, write_file, list_dir',
    });
  });

  /** The model sees the failure as a tool result and corrects itself on the next step. */
  it('fails a call whose arguments do not match the schema', async () => {
    const result = await executor.execute('read_file', {
      path: 42,
      startLine: null,
      endLine: null,
    });
    expect(result.status).toBe('FAILED');
    expect(result.output).toContain('invalid arguments for read_file: path:');
  });

  /** Nothing guarantees the model sends an object; the problem then has no property to name. */
  it('fails a call whose arguments are not an object at all', async () => {
    const result = await executor.execute('list_dir', 'everything');
    expect(result.status).toBe('FAILED');
    expect(result.output).toBe(
      'invalid arguments for list_dir: Invalid input: expected object, received string',
    );
  });

  /** Zod quotes the offending keys, and the model chose them from repository content. */
  it('reports how many unrecognised arguments there were, never their names', async () => {
    const result = await executor.execute('write_file', {
      path: 'a.txt',
      content: 'x',
      [`sk-${'TESTCANARY'.padEnd(30, '0')}`]: 1,
      extra: 2,
    });
    expect(result.output).toBe('invalid arguments for write_file: 2 unrecognized argument(s)');
  });

  /** The loop passes hooks so the transcript can show output as it arrives. */
  it('streams shell output through the hook when the caller supplies one', async () => {
    const streamed: string[] = [];
    await executor.execute(
      'run_shell',
      { command: 'echo streamed', cwd: null, timeoutMs: null },
      { onOutput: (_stream, text) => streamed.push(text) },
    );
    expect(streamed.join('')).toBe('streamed\n');
  });

  /** A dependency that fails outright must not take a recoverable turn down with it. */
  it('turns an exception from a tool into a failed result', async () => {
    const broken = createToolExecutor({
      ...context,
      git: {
        run: () => Promise.reject(new Error('git runner exploded')),
      },
    });
    const result = await broken.execute('list_dir', { path: null, depth: null });
    expect(result).toMatchObject({ status: 'FAILED', output: 'git runner exploded' });
  });
});
