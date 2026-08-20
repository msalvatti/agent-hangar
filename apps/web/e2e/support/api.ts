/**
 * Typed HTTP client the specs assert the API with, independent of Playwright.
 *
 * Layer: test support (pure).
 *
 * Specs read persisted state through the API rather than the database: what the product promises
 * is the response, and a spec that queried Postgres directly would keep passing after the API
 * stopped exposing the row. Every response is parsed with the contract schema, so a shape change
 * fails the spec that depends on it instead of yielding `undefined` three assertions later. The
 * transport is a plain function so this module can be unit-tested without a browser.
 */
import { apiError } from '@agent-hangar/core';

/** Methods the suite calls. */
export type E2eHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** One request, as handed to the transport. */
export interface E2eRequestInit {
  method: E2eHttpMethod;
  /** JSON body, or absent for a request that carries none. */
  body?: unknown;
}

/** One response, as returned by the transport. */
export interface E2eRawResponse {
  status: number;
  text: string;
}

/** Transport: performs one request against an absolute URL. */
export type E2eFetcher = (url: string, init: E2eRequestInit) => Promise<E2eRawResponse>;

/** The part of a Zod schema this client uses. */
export interface SchemaLike<T> {
  parse(data: unknown): T;
}

/** Lowest status treated as a failure. */
const FIRST_ERROR_STATUS = 400;

/** Code reported when an error response does not follow the `apiError` shape. */
export const UNPARSEABLE_ERROR_CODE = 'NON_CONTRACT_ERROR';

/** A non-2xx response, carrying the contract's error code so specs can assert on it. */
export class E2eApiError extends Error {
  /** HTTP status of the response. */
  readonly status: number;
  /** `error.code` of the body, or {@link UNPARSEABLE_ERROR_CODE} when the body is not one. */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(`${String(status)} ${code}: ${message}`);
    this.name = 'E2eApiError';
    this.status = status;
    this.code = code;
  }
}

/** Parses `text` as JSON, or returns `undefined` when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function failureFrom(response: E2eRawResponse): E2eApiError {
  const parsed = apiError.safeParse(parseJson(response.text));
  if (parsed.success) {
    return new E2eApiError(response.status, parsed.data.error.code, parsed.data.error.message);
  }
  return new E2eApiError(response.status, UNPARSEABLE_ERROR_CODE, response.text);
}

/** The client specs use. */
export interface E2eApi {
  /** GETs `path` and parses the body with `schema`. */
  get<T>(path: string, schema: SchemaLike<T>): Promise<T>;
  /** POSTs `body` to `path` and parses the response with `schema`. */
  post<T>(path: string, body: unknown, schema: SchemaLike<T>): Promise<T>;
  /** PUTs `body` to `path` and parses the response with `schema`. */
  put<T>(path: string, body: unknown, schema: SchemaLike<T>): Promise<T>;
  /** DELETEs `path`, expecting no body. */
  del(path: string): Promise<void>;
  /** Performs a request and returns the untouched status and text. */
  raw(path: string, init: E2eRequestInit): Promise<E2eRawResponse>;
}

/**
 * Builds the API client.
 *
 * @param fetcher - Transport performing one request.
 * @param baseURL - Origin every path is resolved against.
 * @returns The client.
 */
export function createApi(fetcher: E2eFetcher, baseURL: string): E2eApi {
  const raw = async (path: string, init: E2eRequestInit): Promise<E2eRawResponse> =>
    fetcher(`${baseURL}${path}`, init);

  const send = async <T>(path: string, init: E2eRequestInit, schema: SchemaLike<T>): Promise<T> => {
    const response = await raw(path, init);
    if (response.status >= FIRST_ERROR_STATUS) {
      throw failureFrom(response);
    }
    return schema.parse(parseJson(response.text));
  };

  return {
    get: async <T>(path: string, schema: SchemaLike<T>): Promise<T> =>
      send(path, { method: 'GET' }, schema),
    post: async <T>(path: string, body: unknown, schema: SchemaLike<T>): Promise<T> =>
      send(path, { method: 'POST', body }, schema),
    put: async <T>(path: string, body: unknown, schema: SchemaLike<T>): Promise<T> =>
      send(path, { method: 'PUT', body }, schema),
    del: async (path: string): Promise<void> => {
      const response = await raw(path, { method: 'DELETE' });
      if (response.status >= FIRST_ERROR_STATUS) {
        throw failureFrom(response);
      }
    },
    raw,
  };
}
