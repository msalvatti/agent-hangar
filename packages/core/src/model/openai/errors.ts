/**
 * Typed failure of the model provider outside a stream.
 *
 * Layer: utility.
 *
 * Inside a stream a failure is a `ModelEvent` of type `error`, because the caller is already
 * consuming events. Outside one — `listModels()` — there is no stream to yield into, so the same
 * classification is thrown instead.
 */
import { AgentHangarError } from '../../errors.ts';
import type { AgentHangarErrorOptions } from '../../errors.ts';
import type { ModelErrorCode } from '../types.ts';

/** A model provider call that is not a stream failed. */
export class ModelProviderError extends AgentHangarError {
  declare readonly code: 'MODEL_PROVIDER_ERROR';
  /** Same categories a streamed `error` event uses, so callers branch on one vocabulary. */
  readonly modelErrorCode: ModelErrorCode;
  /** Whether the caller may retry after a backoff. */
  readonly retryable: boolean;

  /**
   * @param modelErrorCode - Category of the underlying failure.
   * @param message - Description; never a request body, a header or a credential.
   * @param retryable - Whether the caller may retry.
   * @param options - Optional `cause`.
   */
  constructor(
    modelErrorCode: ModelErrorCode,
    message: string,
    retryable: boolean,
    options?: AgentHangarErrorOptions,
  ) {
    super('MODEL_PROVIDER_ERROR', message, options);
    this.modelErrorCode = modelErrorCode;
    this.retryable = retryable;
  }
}
