/**
 * Unit tests of `ModelProviderError`.
 *
 * Layer: test.
 */
import { describe, expect, it } from 'vitest';

import { AgentHangarError, isAgentHangarError } from '../../errors.ts';

import { ModelProviderError } from './errors.ts';

describe('ModelProviderError', () => {
  it('carries the stable code, the category and the retry hint', () => {
    // Callers branch on `code` and `modelErrorCode`, never on the message text.
    const error = new ModelProviderError('rate_limit', 'Rate limit reached', true);
    expect(error.code).toBe('MODEL_PROVIDER_ERROR');
    expect(error.modelErrorCode).toBe('rate_limit');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('Rate limit reached');
    expect(error.name).toBe('ModelProviderError');
  });

  it('is a domain error', () => {
    // The API layer maps every domain error to `{ error: { code, message } }`.
    const error = new ModelProviderError('auth', 'Bad key', false);
    expect(error).toBeInstanceOf(AgentHangarError);
    expect(isAgentHangarError(error)).toBe(true);
  });

  it('keeps the underlying failure as its cause', () => {
    // The cause carries the SDK detail for the logs without shaping the reported message.
    const cause = new Error('socket hang up');
    const error = new ModelProviderError('network', 'Connection error.', true, { cause });
    expect(error.cause).toBe(cause);
  });
});
