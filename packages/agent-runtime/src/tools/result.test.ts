/**
 * Unit tests for the shared tool-result helpers.
 *
 * Layer: unit.
 * Goal: a failure is an ordinary result rather than an exception, and truncation reports the full
 * size, appends a notice and never leaves a half-copied multi-byte character behind.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { describeError, describeErrorWithStack, failure, truncateOutput } from './result.js';

describe('describeError', () => {
  /** Almost every failure the tools see is an ordinary Node error. */
  it('reports the message of a thrown Error', () => {
    expect(describeError(new Error('ENOENT: no such file'))).toBe('ENOENT: no such file');
  });

  /** A rejected promise can carry anything; the tool still has to report something. */
  it('renders a thrown value that is not an Error', () => {
    expect(describeError('plain rejection')).toBe('plain rejection');
  });
});

describe('describeErrorWithStack', () => {
  /** The stack is the whole point of a diagnostic about a runtime bug. */
  it('keeps the stack of a thrown Error', () => {
    expect(describeErrorWithStack(new Error('boom'))).toContain('result.test.ts');
  });

  /** A bundled and minified build can strip stacks; something still has to be reported. */
  it('falls back to the message when the Error carries no stack', () => {
    const stackless = new Error('stackless failure');
    delete stackless.stack;
    expect(describeErrorWithStack(stackless)).toBe('stackless failure');
  });

  /** `catch` binds anything at all, and a diagnostic is not worth crashing over. */
  it('renders a thrown value that is not an Error', () => {
    expect(describeErrorWithStack(42)).toBe('42');
  });
});

describe('failure', () => {
  /** The loop feeds this straight back to the model instead of ending the turn. */
  it('reports the message as a failed result with no exit code', () => {
    expect(failure('file not found: a.ts')).toStrictEqual({
      output: 'file not found: a.ts',
      exitCode: null,
      bytes: 20,
      status: 'FAILED',
    });
  });
});

describe('truncateOutput', () => {
  /** The common case; the reported size is the real one either way. */
  it('leaves output that fits the budget untouched', () => {
    expect(truncateOutput('hello\n', 100)).toStrictEqual({
      text: 'hello\n',
      bytes: 6,
      truncated: false,
    });
  });

  /** The budget is inclusive, so a result of exactly the limit carries no notice. */
  it('keeps output that is exactly the budget', () => {
    expect(truncateOutput('abcde', 5).truncated).toBe(false);
  });

  /** The model needs to know that what it is reading is only the beginning. */
  it('cuts to the budget and appends a notice naming the full size', () => {
    const result = truncateOutput('a'.repeat(50), 10);
    expect(result).toStrictEqual({
      text: `${'a'.repeat(10)}\n[truncated: 50 bytes total]`,
      bytes: 50,
      truncated: true,
    });
  });

  /**
   * `run_shell` throws away output past the budget, so the size it kept is not the size the command
   * produced, and the model needs to be told the real one.
   */
  it('reports the real size when the caller stopped collecting early', () => {
    const result = truncateOutput('kept', 100, 5_000_000);
    expect(result).toStrictEqual({
      text: 'kept\n[truncated: 5000000 bytes total]',
      bytes: 5_000_000,
      truncated: true,
    });
  });

  /**
   * Half a UTF-8 sequence would reach the model as a replacement character. "aé" is three bytes, so
   * a two-byte cut lands in the middle of the second character.
   */
  it('drops a multi-byte character the cut would have split', () => {
    const result = truncateOutput('aé'.repeat(10), 2);
    expect(result.text).toBe('a\n[truncated: 30 bytes total]');
    expect(result.bytes).toBe(30);
  });

  /**
   * The case above cannot tell dropping the broken character apart from keeping only the first
   * one: with a single character before the cut the two are the same string. Here three whole
   * characters precede it, so everything except the split one has to survive.
   */
  it('keeps everything before the character the cut would have split', () => {
    const result = truncateOutput('abcé'.repeat(6), 4);
    expect(result.text).toBe('abc\n[truncated: 30 bytes total]');
    expect(result.bytes).toBe(30);
  });
});
