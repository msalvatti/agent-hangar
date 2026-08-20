/** @vitest-environment node */
/**
 * Unit tests for the response builders, the boundary parsers and `withErrorHandling`.
 *
 * Layer: unit.
 * Goal: responses carry the documented shape and headers, invalid input is refused with the right
 * code, and no message leaves the process without passing the redactor.
 * Mocks: none (a pino logger writing into an array, and the real core redactor).
 */
import { apiError, createRedactor } from '@agent-hangar/core';
import { GITHUB_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiHttpError, INTERNAL_ERROR_MESSAGE } from './errors';
import {
  errorResponse,
  json,
  jsonResponse,
  MAX_REPORTED_ISSUES,
  noContent,
  parseJsonBody,
  parseQuery,
  withErrorHandling,
} from './http';
import { createTestContainer } from './testing/test-container';

vi.mock('bullmq', () => import('./testing/fake-queue'));

/**
 * Reads the message of a rejected promise.
 *
 * @param attempt - A promise expected to reject.
 * @returns The rejection's message.
 * @throws Error When the promise resolves instead.
 */
async function rejectionMessage(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a rejection');
}

/**
 * Builds a request carrying a raw body.
 *
 * @param body - Raw body text.
 * @returns A POST request.
 */
function postRequest(body: string): Request {
  return new Request('http://127.0.0.1:3000/api/chats', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  });
}

describe('response builders', () => {
  /**
   * A JSON response declares its charset, so a browser never has to guess an encoding for text a
   * user typed.
   */
  it('builds a JSON response with the documented content type', async () => {
    const response = json({ ok: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ ok: true });
  });

  /**
   * Status and extra headers are merged over the defaults, which is how a handler adds a caching
   * policy without rebuilding the response.
   */
  it('merges a status and extra headers', () => {
    const response = json({}, { status: 201, headers: { 'Cache-Control': 'no-store' } });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /**
   * The deletes answer 204 with no body at all; the shared client rejects a 204 that carries one,
   * so an empty body is part of the contract rather than an omission.
   */
  it('builds a 204 with no body', async () => {
    const response = noContent();
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });

  /**
   * Error bodies parse as the contract's `apiError`, and are never cached: a stale 409 shown after
   * the conflict was resolved would be worse than a second round trip.
   */
  it('builds an error body that satisfies the contract', async () => {
    const response = errorResponse(409, 'TURN_IN_PROGRESS', 'wait');
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(apiError.parse(await response.json())).toEqual({
      error: { code: 'TURN_IN_PROGRESS', message: 'wait' },
    });
  });

  /**
   * A response schema is a boundary too: a value the contract rejects must fail here rather than
   * reach the UI as a shape it cannot render.
   */
  it('validates a value against its response contract', async () => {
    const schema = z.object({ id: z.string() });
    expect(await jsonResponse(schema, { id: 'a', extra: 1 }).json()).toEqual({ id: 'a' });
    expect(() => jsonResponse(schema, { id: 7 })).toThrow();
  });
});

describe('parseJsonBody', () => {
  /**
   * The happy path returns the parsed value, so a handler works with the contract's output type
   * rather than with `unknown`.
   */
  it('returns the parsed body', async () => {
    const schema = z.object({ prompt: z.string() });
    await expect(parseJsonBody(postRequest('{"prompt":"hi"}'), schema)).resolves.toEqual({
      prompt: 'hi',
    });
  });

  /**
   * A body that is not JSON is reported as such, without repeating the offending bytes: they are
   * caller-controlled and would come back out of the parser's own message.
   */
  it('rejects a body that is not JSON', async () => {
    const attempt = parseJsonBody(postRequest('{oops'), z.object({}));
    await expect(attempt).rejects.toMatchObject({ status: 400, code: 'INVALID_JSON' });
    expect(await rejectionMessage(attempt)).not.toContain('oops');
  });

  /**
   * A schema failure lists the offending fields so the UI can point at them, and stops at five so
   * a body with a hundred bad fields cannot produce an unbounded message.
   */
  it('lists the failing fields and caps the list', async () => {
    const schema = z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string(),
      f: z.string(),
      g: z.string(),
    });
    const attempt = parseJsonBody(postRequest('{}'), schema);
    await expect(attempt).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    const message = await rejectionMessage(attempt);
    expect(message.split('; ')).toHaveLength(MAX_REPORTED_ISSUES);
    expect(message).toContain('a: ');
  });

  /**
   * A failure at the root of the body still names something: `(root)` beats an empty label the
   * reader cannot act on.
   */
  it('labels a root-level failure', async () => {
    const attempt = parseJsonBody(postRequest('"text"'), z.object({ a: z.string() }));
    expect(await rejectionMessage(attempt)).toContain('(root): ');
  });
});

describe('parseQuery', () => {
  /**
   * Query parameters are read off the URL and validated like a body, so a handler never touches
   * `URLSearchParams` itself.
   */
  it('returns the parsed query', () => {
    const schema = z.object({ status: z.enum(['ACTIVE', 'ARCHIVED']).optional() });
    expect(parseQuery('http://127.0.0.1/api/chats?status=ARCHIVED', schema)).toEqual({
      status: 'ARCHIVED',
    });
    expect(parseQuery('http://127.0.0.1/api/chats', schema)).toEqual({});
  });

  /**
   * An unknown value is refused rather than silently ignored: a filter the server does not
   * understand would otherwise return the wrong rows and look like a bug in the UI.
   */
  it('rejects a query the contract does not accept', () => {
    const schema = z.object({ status: z.enum(['ACTIVE']) });
    expect(() => parseQuery('http://127.0.0.1/api/chats?status=NOPE', schema)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }) as Error,
    );
  });
});

describe('withErrorHandling', () => {
  /**
   * A handler that succeeds is returned untouched; the wrapper only exists for the failure path.
   */
  it('returns the handler response unchanged', async () => {
    const { container } = createTestContainer();
    const response = await withErrorHandling(container, () => Promise.resolve(json({ ok: true })));
    expect(await response.json()).toEqual({ ok: true });
  });

  /**
   * A recognised failure keeps its status and code, and is not logged: a 409 is a normal answer,
   * not an incident.
   */
  it('converts a recognised failure without logging it', async () => {
    const { container, doubles } = createTestContainer();
    const response = await withErrorHandling(container, () =>
      Promise.reject(new ApiHttpError(409, 'CHAT_ARCHIVED', 'restore it first')),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: 'CHAT_ARCHIVED', message: 'restore it first' },
    });
    expect(doubles.logOutput()).toBe('');
  });

  /**
   * An unexpected failure is logged in full through the redacting logger and answered with the
   * fixed sentence, so the operator keeps the diagnosis and the client learns nothing.
   */
  it('logs an unexpected failure and answers with the fixed message', async () => {
    const { container, doubles } = createTestContainer();
    const response = await withErrorHandling(container, () =>
      Promise.reject(new Error('connect ECONNREFUSED')),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: 'INTERNAL', message: INTERNAL_ERROR_MESSAGE },
    });
    expect(doubles.logOutput()).toContain('request failed');
  });

  /**
   * Canary regression: a domain message that quotes request input — an invalid cron is the real
   * case — is redacted on the way out, so a credential pasted into a form field cannot be
   * reflected back by the error that rejected it.
   */
  it('redacts a message built from request input', async () => {
    const { container } = createTestContainer();
    const redactor = createRedactor();
    const response = await withErrorHandling({ ...container, redactor }, () =>
      Promise.reject(new ApiHttpError(400, 'INVALID_CRON', `bad value ${GITHUB_CANARY}`)),
    );
    const body = await response.text();
    expect(body).not.toContain(GITHUB_CANARY);
    expect(body).toContain('[REDACTED]');
  });
});
