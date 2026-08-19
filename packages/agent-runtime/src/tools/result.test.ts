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
  it('reports the message of a thrown Error', () => {
    // Almost every failure the tools see is an ordinary Node error.
    expect(describeError(new Error('ENOENT: no such file'))).toBe('ENOENT: no such file');
  });

  it('renders a thrown value that is not an Error', () => {
    // A rejected promise can carry anything; the tool still has to report something.
    expect(describeError('plain rejection')).toBe('plain rejection');
  });
});

describe('describeErrorWithStack', () => {
  it('keeps the stack of a thrown Error', () => {
    // The stack is the whole point of a diagnostic about a runtime bug.
    expect(describeErrorWithStack(new Error('boom'))).toContain('result.test.ts');
  });

  it('falls back to the message when the Error carries no stack', () => {
    // A bundled and minified build can strip stacks; something still has to be reported.
    const stackless = new Error('stackless failure');
    delete stackless.stack;
    expect(describeErrorWithStack(stackless)).toBe('stackless failure');
  });

  it('renders a thrown value that is not an Error', () => {
    // `catch` binds anything at all, and a diagnostic is not worth crashing over.
    expect(describeErrorWithStack(42)).toBe('42');
  });
});

describe('failure', () => {
  it('reports the message as a failed result with no exit code', () => {
    // The loop feeds this straight back to the model instead of ending the turn.
    expect(failure('file not found: a.ts')).toStrictEqual({
      output: 'file not found: a.ts',
      exitCode: null,
      bytes: 20,
      status: 'FAILED',
    });
  });
});

describe('truncateOutput', () => {
  it('leaves output that fits the budget untouched', () => {
    // The common case; the reported size is the real one either way.
    expect(truncateOutput('hello\n', 100)).toStrictEqual({
      text: 'hello\n',
      bytes: 6,
      truncated: false,
    });
  });

  it('keeps output that is exactly the budget', () => {
    // The budget is inclusive, so a result of exactly the limit carries no notice.
    expect(truncateOutput('abcde', 5).truncated).toBe(false);
  });

  it('cuts to the budget and appends a notice naming the full size', () => {
    // The model needs to know that what it is reading is only the beginning.
    const result = truncateOutput('a'.repeat(50), 10);
    expect(result).toStrictEqual({
      text: `${'a'.repeat(10)}\n[truncated: 50 bytes total]`,
      bytes: 50,
      truncated: true,
    });
  });

  it('drops a multi-byte character the cut would have split', () => {
    // Half a UTF-8 sequence would reach the model as a replacement character.
    // "aé" is three bytes, so a two-byte cut lands in the middle of the second character.
    const result = truncateOutput('aé'.repeat(10), 2);
    expect(result.text).toBe('a\n[truncated: 30 bytes total]');
    expect(result.bytes).toBe(30);
  });
});
