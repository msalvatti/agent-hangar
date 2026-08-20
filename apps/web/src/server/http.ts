/**
 * Response builders, boundary parsing and the one place a thrown error becomes an HTTP response.
 *
 * Layer: service (server).
 *
 * Two rules hold for everything here. Requests are parsed with the frozen Zod contracts, so a
 * malformed body never reaches a repository; and every message that leaves is passed through the
 * redactor first, so a validation message built from user input — or a domain message quoting a
 * library's reason string — cannot carry a credential out of the process.
 */
import type { Redactor } from '@agent-hangar/core';
import type { Logger } from 'pino';
import type { ZodType } from 'zod';

import { ApiHttpError, reportError, ValidationError } from './errors';

/** Media type of every JSON response. */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Status of a successful response that carries no body. */
export const NO_CONTENT_STATUS = 204;

/** How many Zod issues a validation message lists before it stops. */
export const MAX_REPORTED_ISSUES = 5;

/** What {@link withErrorHandling} needs in order to redact and log a failure. */
export interface ErrorHandlingContext {
  readonly logger: Logger;
  readonly redactor: Pick<Redactor, 'redact'>;
}

/** Options of {@link json}. */
export interface JsonResponseOptions {
  /** HTTP status; defaults to 200. */
  status?: number;
  /** Extra headers merged over the JSON content type. */
  headers?: Readonly<Record<string, string>>;
}

/**
 * Builds a JSON response.
 *
 * @param body - Value to serialise; already validated against its response contract.
 * @param options - Status and extra headers.
 * @returns The response.
 */
export function json(body: unknown, options: JsonResponseOptions = {}): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { 'Content-Type': JSON_CONTENT_TYPE, ...options.headers },
  });
}

/**
 * Builds the empty `204` response the delete operations declare.
 *
 * @returns A response with no body.
 */
export function noContent(): Response {
  return new Response(null, {
    status: NO_CONTENT_STATUS,
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * Builds an error response in the `{ error: { code, message } }` shape of the contract.
 *
 * @param status - HTTP status.
 * @param code - Stable machine-readable code.
 * @param message - Human-readable description; must already be safe to echo.
 * @returns The response, never cached.
 */
export function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Turns Zod issues into one readable line.
 *
 * @param issues - Issues reported by a failed parse.
 * @returns `path: message` pairs, capped at {@link MAX_REPORTED_ISSUES}.
 */
function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Reads and validates a JSON request body.
 *
 * @param request - The incoming request.
 * @param schema - Contract the body must satisfy.
 * @returns The parsed body.
 * @throws ApiHttpError 400 `INVALID_JSON` when the body is not JSON.
 * @throws ValidationError 400 when the body does not satisfy the contract.
 */
export async function parseJsonBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // The parser's own message quotes the offending bytes, which are attacker-controlled; the
    // client only needs to know the body was not JSON.
    throw new ApiHttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(describeIssues(parsed.error.issues));
  }
  return parsed.data;
}

/**
 * Reads and validates the query string of a request URL.
 *
 * @param url - Absolute request URL.
 * @param schema - Contract the query must satisfy.
 * @returns The parsed query.
 * @throws ValidationError 400 when the query does not satisfy the contract.
 */
export function parseQuery<T>(url: string, schema: ZodType<T>): T {
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new ValidationError(describeIssues(parsed.error.issues));
  }
  return parsed.data;
}

/**
 * Validates a value against its response contract before it is serialised.
 *
 * A response schema is as much a trust boundary as a request schema: a row written before a
 * migration, or a field a repository stopped filling, must fail here rather than reach the UI as
 * a shape it cannot render.
 *
 * @param schema - The operation's response contract.
 * @param value - Value the handler assembled.
 * @param options - Status and extra headers.
 * @returns A JSON response carrying the parsed value.
 * @throws ZodError When the value does not satisfy the contract.
 */
export function jsonResponse<T>(
  schema: ZodType<T>,
  value: unknown,
  options: JsonResponseOptions = {},
): Response {
  return json(schema.parse(value), options);
}

/**
 * Runs a handler and converts anything it throws into an HTTP response.
 *
 * The message is redacted on the way out even though every branch of {@link reportError} returns
 * a message written in this repository: two of those branches quote a cron expression and a
 * parser's reason, both of which start life as request input.
 *
 * @param context - Logger and redactor (the server container satisfies it).
 * @param handler - The handler body.
 * @returns The handler's response, or the error response.
 */
export async function withErrorHandling(
  context: ErrorHandlingContext,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    const report = reportError(error);
    if (report.status >= 500) {
      context.logger.error(
        { err: error, code: report.code, status: report.status },
        'request failed',
      );
    }
    return errorResponse(report.status, report.code, context.redactor.redact(report.message));
  }
}
