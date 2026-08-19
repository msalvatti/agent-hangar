/**
 * Typed HTTP client over the API contracts: one `apiFetch(operation, …)` call per route, with
 * request and response validated by the shared Zod schemas, plus an `EventSource` factory.
 *
 * Layer: service (client).
 *
 * Same-origin only. Errors are surfaced as `ApiClientError` carrying the HTTP status and the
 * `{ error: { code, message } }` body when the server produced one.
 *
 * Operations that declare `noContent` (the deletes, which answer 204) skip JSON parsing entirely
 * and resolve to `undefined`; a mismatch in either direction between the declared shape and what
 * the server actually sent is reported rather than ignored.
 */
import { apiError, apiOperations, buildPath, HTTP_NO_CONTENT } from '@agent-hangar/core';
import type {
  ApiBodyInput,
  ApiOperationName,
  ApiQueryInput,
  ApiResponse,
} from '@agent-hangar/core';

/** Minimal `fetch` signature, injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Options of {@link apiFetch}. */
export interface ApiFetchOptions<K extends ApiOperationName> {
  /** Values for `:name` segments of the route path. */
  params?: Readonly<Record<string, string>>;
  /** Query parameters (validated by the operation's query schema). */
  query?: ApiQueryInput<K>;
  /** JSON body (validated by the operation's body schema). */
  body?: ApiBodyInput<K>;
  /** Aborts the request. */
  signal?: AbortSignal;
  /** `fetch` implementation (defaults to the global one). */
  fetch?: FetchLike;
}

/** Non-2xx response or invalid payload. */
export class ApiClientError extends Error {
  /** HTTP status of the response (0 when the response could not be parsed at all). */
  readonly status: number;
  /** `error.code` from the body, or a client-side code. */
  readonly code: string;

  /**
   * @param status - HTTP status.
   * @param code - Machine-readable code.
   * @param message - Human-readable description.
   */
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

function toQueryString(query: Record<string, unknown> | undefined): string {
  if (query === undefined) {
    return '';
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded.length === 0 ? '' : `?${encoded}`;
}

async function readErrorBody(response: Response): Promise<{ code: string; message: string }> {
  const fallback = {
    code: `HTTP_${String(response.status)}`,
    message: response.statusText || 'Request failed',
  };
  try {
    const parsed = apiError.safeParse(await response.json());
    return parsed.success ? parsed.data.error : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Calls an API operation and returns its validated response.
 *
 * @param operation - Key of `apiOperations`.
 * @param options - Path params, query, body, signal, fetch.
 * @returns The parsed response body.
 * @throws ApiClientError on non-2xx responses, invalid responses, or invalid inputs.
 */
export async function apiFetch<K extends ApiOperationName>(
  operation: K,
  options: ApiFetchOptions<K> = {},
): Promise<ApiResponse<K>> {
  const spec = apiOperations[operation];
  const fetchImpl = options.fetch ?? fetch;

  const query = spec.query === undefined ? undefined : spec.query.safeParse(options.query ?? {});
  if (query !== undefined && !query.success) {
    throw new ApiClientError(0, 'INVALID_QUERY', query.error.message);
  }
  const body = spec.body === undefined ? undefined : spec.body.safeParse(options.body);
  if (body !== undefined && !body.success) {
    throw new ApiClientError(0, 'INVALID_BODY', body.error.message);
  }

  const url = `${buildPath(spec.path, options.params)}${toQueryString(query?.data)}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = { method: spec.method, headers, credentials: 'same-origin' };
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body.data);
  }

  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const error = await readErrorBody(response);
    throw new ApiClientError(response.status, error.code, error.message);
  }
  if (spec.noContent === true) {
    // The operation promises an empty body. A body here means the server disagrees with the
    // contract, which is worth failing on rather than silently ignoring.
    const text = await response.text();
    if (text.trim().length > 0) {
      throw new ApiClientError(
        response.status,
        'INVALID_RESPONSE',
        'Response carries a body but the operation declares none',
      );
    }
    return undefined as ApiResponse<K>;
  }
  if (response.status === HTTP_NO_CONTENT) {
    // The mirror case: the operation declares a body schema, so an empty response cannot satisfy
    // it. Reported precisely instead of surfacing as "not JSON".
    throw new ApiClientError(
      response.status,
      'INVALID_RESPONSE',
      'Response carries no body but the operation declares one',
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiClientError(response.status, 'INVALID_RESPONSE', 'Response body is not JSON');
  }
  const parsed = spec.response.safeParse(json);
  if (!parsed.success) {
    throw new ApiClientError(response.status, 'INVALID_RESPONSE', parsed.error.message);
  }
  return parsed.data as ApiResponse<K>;
}

/** Options of {@link createEventSource}. */
export interface EventSourceOptions {
  /**
   * Resume point for a manual reconnect. The browser resends `Last-Event-ID` automatically on
   * its own reconnects; this option covers resuming after a full page load by appending `?from=`.
   */
  lastEventId?: string;
}

/**
 * Opens a same-origin `EventSource` for an SSE route.
 *
 * @param path - Route path, e.g. `buildPath(routes.chatEvents, { id })`.
 * @param options - Optional resume point.
 * @returns The native `EventSource`.
 */
export function createEventSource(path: string, options: EventSourceOptions = {}): EventSource {
  const separator = path.includes('?') ? '&' : '?';
  const url =
    options.lastEventId === undefined
      ? path
      : `${path}${separator}from=${encodeURIComponent(options.lastEventId)}`;
  return new EventSource(url);
}
