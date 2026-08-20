/** @vitest-environment node */
/**
 * Unit tests for the HTTP error types and the domain-error mapping.
 *
 * Layer: unit.
 * Goal: every branch of `reportError` produces the documented status and code, and nothing that
 * reaches a client is built from a third-party error's own text.
 * Mocks: none.
 */
import {
  ConfigError,
  IllegalTransitionError,
  InvalidCronError,
  SecretIntegrityError,
} from '@agent-hangar/core';
import { assertNoCanary, GITHUB_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import {
  ApiHttpError,
  ConflictError,
  failureName,
  ForbiddenOriginError,
  GithubApiError,
  INTERNAL_ERROR_MESSAGE,
  reportError,
  ResourceNotFoundError,
  ValidationError,
} from './errors';

describe('error types', () => {
  /**
   * Each subclass fixes the status and code its name promises, so a handler states intent by
   * choosing a type rather than by repeating a number at every call site.
   */
  it('fixes the status and code of every subclass', () => {
    expect(new ResourceNotFoundError()).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(new ResourceNotFoundError('Chat not found').message).toBe('Chat not found');
    expect(new ConflictError('TURN_IN_PROGRESS', 'busy')).toMatchObject({
      status: 409,
      code: 'TURN_IN_PROGRESS',
    });
    expect(new ValidationError('bad')).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(new ValidationError('bad', 'REPO_URL_NOT_ALLOWED').code).toBe('REPO_URL_NOT_ALLOWED');
    expect(new ForbiddenOriginError('no')).toMatchObject({ status: 403, code: 'FORBIDDEN_ORIGIN' });
  });

  /**
   * The name is the class name rather than the base `Error`, so a logged error identifies itself
   * even when its stack is scrubbed.
   */
  it('names each error after its own class', () => {
    expect(new ResourceNotFoundError().name).toBe('ResourceNotFoundError');
    expect(new GithubApiError(500, 'x').name).toBe('GithubApiError');
  });
});

describe('reportError', () => {
  /**
   * An explicitly raised HTTP error passes through untouched: the handler already decided how the
   * failure should read.
   */
  it('passes an ApiHttpError through', () => {
    expect(reportError(new ApiHttpError(409, 'SECRETS_MISSING', 'configure it'))).toEqual({
      status: 409,
      code: 'SECRETS_MISSING',
      message: 'configure it',
    });
  });

  /**
   * GitHub answering 401 or 403 means the stored token is missing a scope or no longer valid, so
   * the UI can point at Settings; every other GitHub failure is an upstream problem (502).
   */
  it('splits GitHub failures into an auth problem and an upstream problem', () => {
    expect(reportError(new GithubApiError(401, 'x'))).toMatchObject({
      status: 401,
      code: 'GITHUB_AUTH',
    });
    expect(reportError(new GithubApiError(403, 'x'))).toMatchObject({
      status: 401,
      code: 'GITHUB_AUTH',
    });
    expect(reportError(new GithubApiError(503, 'x'))).toEqual({
      status: 502,
      code: 'GITHUB_ERROR',
      message: 'GitHub request failed with status 503',
    });
  });

  /**
   * GitHub's own body is never repeated: it is written by a server that was handed the token, so
   * only the status — a number this process read — reaches the client. The body carries the
   * credential canary, so the assertion is not that some wording is absent but that the secret
   * itself never reaches the client.
   */
  it('never echoes the text of a GitHub error', () => {
    const report = reportError(new GithubApiError(500, `Bearer ${GITHUB_CANARY}`));
    expect(report.message).not.toContain('Bearer');
    assertNoCanary(report.message);
  });

  /**
   * The domain errors each map to the status that describes them: a bad cron is the caller's
   * fault, a refused transition is a conflict, a broken envelope is a server fault, and missing
   * configuration means the service is not ready.
   */
  it('maps every domain error to its status', () => {
    expect(reportError(new InvalidCronError('61 * * * *', 'bad minute'))).toMatchObject({
      status: 400,
      code: 'INVALID_CRON',
    });
    expect(reportError(new IllegalTransitionError('Chat', 'ARCHIVED', 'ARCHIVED'))).toMatchObject({
      status: 409,
      code: 'ILLEGAL_TRANSITION',
    });
    expect(reportError(new SecretIntegrityError())).toMatchObject({
      status: 500,
      code: 'SECRET_INTEGRITY',
    });
    expect(reportError(new ConfigError('no DATABASE_URL'))).toMatchObject({
      status: 503,
      code: 'CONFIG_ERROR',
    });
  });

  /**
   * Anything unrecognised collapses to one fixed sentence. A driver error quotes its connection
   * string — password included — in its message, so repeating an unknown error's text would put a
   * credential in an HTTP response.
   */
  it('collapses an unknown failure to a fixed message', () => {
    const driverError = new Error('connect ECONNREFUSED postgres://user:hunter2@127.0.0.1:5432');
    expect(reportError(driverError)).toEqual({
      status: 500,
      code: 'INTERNAL',
      message: INTERNAL_ERROR_MESSAGE,
    });
    expect(reportError('a bare string')).toMatchObject({ code: 'INTERNAL' });
  });
});

describe('failureName', () => {
  /**
   * Where a failure is logged on a path that may have touched a credential, the only thing written
   * is a class name — a value this codebase and its dependencies chose, never text carried in by
   * the value that failed. Anything that is not an `Error` has no name to report.
   */
  it('names an error by its class and reports anything else as unknown', () => {
    expect(failureName(new TypeError('boom'))).toBe('TypeError');
    expect(failureName(new GithubApiError(500, 'x'))).toBe('GithubApiError');
    expect(failureName('a bare string')).toBe('unknown');
    expect(failureName(undefined)).toBe('unknown');
  });
});
