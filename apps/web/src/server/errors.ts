/**
 * HTTP error types raised by route handlers and the table that maps domain errors to responses.
 *
 * Layer: service (server).
 *
 * Every error that reaches a client is described by a status, a stable `code` and a message
 * written in this repository. Nothing derived from a driver, an SDK or a stack trace is ever
 * echoed: `INTERNAL` carries a fixed sentence, and the real failure is logged instead.
 */
import {
  ConfigError,
  InvalidCronError,
  IllegalTransitionError,
  SecretIntegrityError,
} from '@agent-hangar/core';

/** Message returned for any failure the API does not recognise. */
export const INTERNAL_ERROR_MESSAGE = 'Internal error';

/**
 * Names a thrown value by its class, without inspecting anything else about it.
 *
 * Used wherever a failure is logged on a path that may have touched a credential: a class name is
 * chosen by this codebase and its dependencies, never assembled from the value that failed.
 *
 * @param error - The value that was thrown.
 * @returns The class name, or `unknown` for anything that is not an `Error`.
 */
export function failureName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** A failure the handler wants reported with a specific status and code. */
export class ApiHttpError extends Error {
  /** HTTP status of the response. */
  readonly status: number;
  /** Stable machine-readable code, echoed in `{ error: { code } }`. */
  readonly code: string;

  /**
   * @param status - HTTP status.
   * @param code - Stable machine-readable code.
   * @param message - Human-readable description; never contains a secret.
   */
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
  }
}

/** The addressed resource does not exist (404). */
export class ResourceNotFoundError extends ApiHttpError {
  /**
   * @param message - What was not found.
   */
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
  }
}

/** The request is well formed but conflicts with the current state (409). */
export class ConflictError extends ApiHttpError {
  /**
   * @param code - Stable machine-readable code, e.g. `TURN_IN_PROGRESS`.
   * @param message - Why the request conflicts.
   */
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}

/** The request payload failed schema validation (400). */
export class ValidationError extends ApiHttpError {
  /**
   * @param message - Which fields failed and why.
   * @param code - Stable machine-readable code; defaults to `VALIDATION_ERROR`.
   */
  constructor(message: string, code = 'VALIDATION_ERROR') {
    super(400, code, message);
  }
}

/** The request did not prove it came from this origin (403). */
export class ForbiddenOriginError extends ApiHttpError {
  /**
   * @param message - Why the origin was refused.
   */
  constructor(message: string) {
    super(403, 'FORBIDDEN_ORIGIN', message);
  }
}

/** A call to the GitHub REST API failed. */
export class GithubApiError extends Error {
  /** Status GitHub answered with. */
  readonly status: number;

  /**
   * @param status - HTTP status of the GitHub response.
   * @param message - Redacted description of the failure.
   */
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GithubApiError';
    this.status = status;
  }
}

/** How one failure is reported to a client. */
export interface ErrorReport {
  status: number;
  code: string;
  message: string;
}

/** GitHub statuses that mean the stored token is missing, invalid or lacks a scope. */
const GITHUB_AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * Classifies any thrown value into the response the client receives.
 *
 * Domain errors keep their own message because those sentences are written in this repository and
 * carry no input from a driver or an SDK. Everything else collapses to `INTERNAL` with a fixed
 * message, so an unexpected failure can never leak a connection string, a stack frame or the text
 * of a third-party error.
 *
 * @param error - The value a handler threw.
 * @returns Status, code and message for the response.
 */
export function reportError(error: unknown): ErrorReport {
  if (error instanceof ApiHttpError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof GithubApiError) {
    return GITHUB_AUTH_STATUSES.has(error.status)
      ? { status: 401, code: 'GITHUB_AUTH', message: 'GitHub rejected the stored token' }
      : {
          status: 502,
          code: 'GITHUB_ERROR',
          // The status is a number this process read off the response line; GitHub's own body is
          // deliberately not repeated, because it echoes whatever was sent to it.
          message: `GitHub request failed with status ${String(error.status)}`,
        };
  }
  if (error instanceof InvalidCronError) {
    return { status: 400, code: error.code, message: error.message };
  }
  if (error instanceof IllegalTransitionError) {
    return { status: 409, code: error.code, message: error.message };
  }
  if (error instanceof SecretIntegrityError) {
    return { status: 500, code: error.code, message: error.message };
  }
  if (error instanceof ConfigError) {
    return { status: 503, code: error.code, message: error.message };
  }
  return { status: 500, code: 'INTERNAL', message: INTERNAL_ERROR_MESSAGE };
}
