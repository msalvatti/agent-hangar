/**
 * Errors raised by the secrets service that are not part of the shared error module.
 *
 * Layer: utility.
 *
 * Messages describe the shape of the problem only; a rejected value is never echoed back, because
 * the value in hand at that moment is a credential.
 */
import type { AgentHangarErrorOptions } from '../errors.ts';
import { AgentHangarError } from '../errors.ts';

/** A credential was rejected before it could be encrypted. */
export class InvalidSecretError extends AgentHangarError {
  declare readonly code: 'SECRET_INVALID';

  /**
   * @param message - What was wrong with the value; never the value itself.
   * @param options - Optional `cause`.
   */
  constructor(
    message = 'Secret value must be a non-empty string.',
    options?: AgentHangarErrorOptions,
  ) {
    super('SECRET_INVALID', message, options);
  }
}
