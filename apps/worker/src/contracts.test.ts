/**
 * Unit tests for how the worker consumes the shared queue contracts.
 *
 * Layer: unit.
 * Goal: three rules about the relationship between `apps/worker/src` and
 * `@agent-hangar/core`, each of which a value assertion is structurally unable to check. A
 * mirrored constant agrees with its original on the day it is written — that is what makes the
 * drift silent — so what has to be asserted is that there is only one of it. A payload schema
 * reshaped by its consumer is a fork of the contract even while the two accept the same
 * messages. And a delivery field that never moves reads as a live refinement to whoever edits
 * the code next, so the guarantee worth keeping is that no processor can consult it at all.
 * Mocks: none; the sources are read from disk and the contract's own export list is the oracle.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as contracts from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

/** Root of the worker's sources. */
const SOURCE_ROOT = import.meta.dirname;

/** Suffix of a test file, which these rules are about the sources of rather than the tests of. */
const TEST_SUFFIX = '.test.ts';

/** Suffix of a TypeScript source file. */
const SOURCE_SUFFIX = '.ts';

/** BullMQ's attempt count, as a whole identifier. */
const ATTEMPT_COUNT = /\battemptsMade\b/u;

/** Methods that produce a new schema from an existing one. */
const RESHAPERS: readonly string[] = ['extend', 'merge', 'omit', 'pick', 'partial', 'required'];

/** One source file, as a path relative to the worker's `src` and its text. */
interface SourceFile {
  path: string;
  text: string;
}

/**
 * Reads every non-test TypeScript source under the worker's `src`.
 *
 * @param directory - Directory to walk, absolute.
 * @param prefix - Path of `directory` relative to `src`, for reporting.
 * @returns The files, in directory order.
 */
function readSources(directory: string, prefix = ''): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...readSources(join(directory, entry.name), relative));
      continue;
    }
    if (!entry.name.endsWith(SOURCE_SUFFIX) || entry.name.endsWith(TEST_SUFFIX)) {
      continue;
    }
    files.push({ path: relative, text: readFileSync(join(directory, entry.name), 'utf8') });
  }
  return files;
}

/** Every non-test source of the worker. */
const sources = readSources(SOURCE_ROOT);

/** Every exported entry of the shared contract package, name and value. */
const contractEntries = Object.entries(contracts as Record<string, unknown>);

/**
 * Names the contract exports as a plain constant — a string, a number or a boolean.
 *
 * The oracle is deliberately the values rather than every export: a function of the same name is
 * a different function, whereas a constant of the same name is the same constant written twice.
 */
const constantNames = contractEntries
  .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
  .map(([name]) => name);

/**
 * Names the contract exports as a schema.
 *
 * Recognised by `safeParse`, which is what every schema in the package offers and nothing else
 * does, so the list needs no maintenance when a contract is added.
 */
const schemaNames = contractEntries
  .filter(([, value]) => typeof (value as { safeParse?: unknown } | null)?.safeParse === 'function')
  .map(([name]) => name);

/** Openers of a line that carries prose rather than code. */
const COMMENT_STARTS: readonly string[] = ['*', '//', '/*'];

/** Keyword that introduces a declaration these rules are about. */
const DECLARATION = 'const ';

/** Prefix an exported declaration adds in front of {@link DECLARATION}. */
const EXPORTED = 'export ';

/** Characters that may appear in a JavaScript identifier of the kind these rules match. */
const IDENTIFIER_CHARS = /^[A-Za-z0-9_$]$/u;

/** One line of one source file, already trimmed. */
interface SourceLine {
  path: string;
  number: number;
  text: string;
}

/**
 * Every code line of the worker's sources, comments dropped.
 *
 * Every rule here is about what the code does, and a comment naming the thing the code must not do
 * is how the rule is explained to the next reader — including the explanation of this very rule,
 * which would otherwise be the first thing it failed on.
 */
const codeLines: SourceLine[] = sources.flatMap((file) =>
  file.text
    .split('\n')
    .map((line, index) => ({ path: file.path, number: index + 1, text: line.trim() }))
    .filter((line) => !COMMENT_STARTS.some((start) => line.text.startsWith(start))),
);

/**
 * Renders a line for a failure message.
 *
 * @param line - The offending line.
 * @returns `path:line text`.
 */
function locate(line: SourceLine): string {
  return `${line.path}:${String(line.number)} ${line.text}`;
}

/**
 * The name a line declares as a `const`, if it declares one.
 *
 * @param text - Trimmed line.
 * @returns The declared identifier, or `undefined` when the line declares no constant.
 */
function declaredConstant(text: string): string | undefined {
  const body = text.startsWith(EXPORTED) ? text.slice(EXPORTED.length) : text;
  if (!body.startsWith(DECLARATION)) {
    return undefined;
  }
  const rest = body.slice(DECLARATION.length);
  let end = 0;
  while (end < rest.length && IDENTIFIER_CHARS.test(rest[end] ?? '')) {
    end += 1;
  }
  return end === 0 ? undefined : rest.slice(0, end);
}

describe('the worker against the shared queue contracts', () => {
  /**
   * A constant the contract already exports must be imported, never restated. Both copies are
   * byte-identical the day the second is written, so no assertion on the value can tell them
   * apart; what distinguishes them is that one of them is a declaration.
   */
  it('declares no name the shared contract already exports', () => {
    const names = new Set(constantNames);
    const restated = codeLines
      .filter((line) => {
        const declared = declaredConstant(line.text);
        return declared !== undefined && names.has(declared);
      })
      .map(locate);

    expect(restated).toEqual([]);
  });

  /**
   * A payload schema is the process boundary itself, so a consumer reshaping it has forked the
   * boundary: the two schemas accept the same messages until the shared one changes, and then
   * only one side moves.
   */
  it('reshapes no schema the shared contract exports', () => {
    const forks = schemaNames.flatMap((name) => RESHAPERS.map((method) => `${name}.${method}(`));
    const reshaped = codeLines
      .filter((line) => forks.some((fork) => line.text.includes(fork)))
      .map(locate);

    expect(reshaped).toEqual([]);
  });

  /**
   * BullMQ's attempt count is the wrong field to recognise a redelivery by: it counts failed
   * attempts, nothing configures `attempts`, and the stalled-recovery script increments a
   * counter of its own instead. A processor that reads it is refining on a number that never
   * moves, which reads as a live condition to whoever edits it next.
   */
  it('never reads the delivery attempt count', () => {
    const readers = codeLines.filter((line) => ATTEMPT_COUNT.test(line.text)).map(locate);

    expect(readers).toEqual([]);
  });
});
