/**
 * Unit tests for the typed API client.
 *
 * Layer: unit.
 * Goal: `apiFetch` builds the right request (method, path params, query, JSON body), parses a
 * valid response, rejects invalid inputs/responses, maps non-2xx bodies to `ApiClientError`, and
 * propagates aborts; `createEventSource` opens a same-origin stream with an optional resume point.
 * Mocks: an injected `fetch`; a stubbed global `EventSource`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiFetch, ApiClientError, createEventSource, toQueryString } from './client';

const now = '2026-08-19T10:00:00.000Z';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function fetchReturning(response: () => Response) {
  return vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(response()),
  );
}

describe('apiFetch', () => {
  /**
   * GET with path params and query: the URL is built from the route template, the query is
   * validated and encoded, the method/headers are set, and the parsed response is returned.
   */
  it('builds GET requests with params and query and parses the response', async () => {
    const fetchMock = fetchReturning(() => jsonResponse({ chats: [] }));
    const result = await apiFetch('listChats', { query: { status: 'ACTIVE' }, fetch: fetchMock });
    expect(result).toEqual({ chats: [] });
    expect(fetchMock).toHaveBeenCalledWith('/api/chats?status=ACTIVE', {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });

    const detail = fetchReturning(() =>
      jsonResponse({
        chat: {
          id: 'c 1',
          title: 't',
          status: 'ACTIVE',
          repoUrl: 'https://github.com/acme/w',
          baseBranch: 'main',
          workBranch: null,
          lastPushedSha: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          lastTurnStatus: null,
        },
        messages: [],
        turns: [],
        toolCalls: [],
        workspace: null,
      }),
    );
    const chat = await apiFetch('getChat', { params: { id: 'c 1' }, fetch: detail });
    expect(chat.chat.id).toBe('c 1');
    expect(detail.mock.calls[0]?.[0]).toBe('/api/chats/c%201');
  });

  /**
   * POST with a JSON body: the body is validated by the request schema and serialised with the
   * JSON content type; the response is parsed.
   */
  it('sends validated JSON bodies', async () => {
    const fetchMock = fetchReturning(() => jsonResponse({ chatId: 'c1', turnId: 't1' }));
    const result = await apiFetch('createChat', {
      body: { repoUrl: 'https://github.com/acme/w', baseBranch: 'main', prompt: 'hi' },
      fetch: fetchMock,
    });
    expect(result).toEqual({ chatId: 'c1', turnId: 't1' });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      repoUrl: 'https://github.com/acme/w',
      baseBranch: 'main',
      prompt: 'hi',
    });
  });

  /**
   * Invalid inputs never reach the network: a bad query or body throws `ApiClientError` with a
   * client-side code and status 0.
   */
  it('rejects invalid query and body before fetching', async () => {
    const fetchMock = fetchReturning(() => jsonResponse({}));
    await expect(
      apiFetch('listChats', { query: { status: 'NOPE' as 'ACTIVE' }, fetch: fetchMock }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY', status: 0 });
    await expect(
      apiFetch('createChat', {
        body: { repoUrl: 'ftp://x', baseBranch: '', prompt: '' },
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_BODY', status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * Query values that are undefined/null are omitted; an empty query produces no `?`.
   */
  it('omits empty query parameters', async () => {
    const fetchMock = fetchReturning(() => jsonResponse({ repos: [] }));
    await apiFetch('listRepos', { fetch: fetchMock });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/repos');
    await apiFetch('listRepos', { query: { query: undefined }, fetch: fetchMock });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/repos');
  });

  /**
   * Numbers and booleans are sent as their text, like strings: a query value dropped for its type
   * is a filter the server never sees, and the caller has no way to tell that from a server that
   * ignored it. Only values of no other kind are left out.
   */
  it('sends every scalar the caller put in the query', async () => {
    const fetchMock = fetchReturning(() => jsonResponse({ repos: [] }));

    await apiFetch('listRepos', {
      query: { query: 'widgets' },
      fetch: fetchMock,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://127.0.0.1:3000');
    expect(url.searchParams.get('query')).toBe('widgets');

    // Numbers and booleans reach the wire as their text, exactly as strings do: a value dropped
    // for its type is a parameter the server never sees, and the caller cannot tell that from a
    // server that ignored it. Anything with no agreed spelling is left out instead of being sent
    // as `[object Object]`.
    expect(toQueryString({ text: 'x', count: 2, flag: false })).toBe('?text=x&count=2&flag=false');
    expect(toQueryString({ kept: 1, dropped: { nested: true } })).toBe('?kept=1');
    expect(toQueryString(undefined)).toBe('');
  });

  /**
   * A 2xx response that violates the response schema is an `ApiClientError` with
   * `INVALID_RESPONSE`, as is a non-JSON body.
   */
  it('rejects responses that violate the schema or are not JSON', async () => {
    await expect(
      apiFetch('listChats', { fetch: fetchReturning(() => jsonResponse({ chats: [{ id: 1 }] })) }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 200 });
    await expect(
      apiFetch('listChats', {
        fetch: fetchReturning(() => new Response('not json', { status: 200 })),
      }),
      // The three ways a 2xx can fail to satisfy an operation are told apart by their wording:
      // a body that is not JSON, a body where none was declared, and none where one was.
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 200,
      message: 'Response body is not JSON',
      name: 'ApiClientError',
    });
  });

  /**
   * Non-2xx responses: the `{ error: { code, message } }` body is surfaced; when the body is not
   * an error envelope (or not JSON at all) a status-based fallback is used.
   */
  it('maps non-2xx responses to ApiClientError', async () => {
    const notFound = apiFetch('getChat', {
      params: { id: 'x' },
      fetch: fetchReturning(() =>
        jsonResponse({ error: { code: 'NOT_FOUND', message: 'no such chat' } }, { status: 404 }),
      ),
    });
    await expect(notFound).rejects.toBeInstanceOf(ApiClientError);
    await expect(notFound).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'no such chat',
    });

    await expect(
      apiFetch('getHealth', {
        fetch: fetchReturning(() =>
          jsonResponse({ oops: true }, { status: 500, statusText: 'Server Error' }),
        ),
      }),
    ).rejects.toMatchObject({ status: 500, code: 'HTTP_500', message: 'Server Error' });

    await expect(
      apiFetch('getHealth', { fetch: fetchReturning(() => new Response('boom', { status: 502 })) }),
    ).rejects.toMatchObject({ status: 502, code: 'HTTP_502', message: 'Request failed' });
  });

  /**
   * The abort signal is forwarded to `fetch`, and an aborted fetch rejects with the abort error
   * unchanged (callers distinguish cancellation from API errors).
   */
  it('forwards the abort signal and propagates aborts', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const pending = apiFetch('getHealth', { signal: controller.signal, fetch: fetchMock });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  /**
   * Without an injected `fetch` the global one is used.
   */
  it('uses the global fetch by default', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        ok: true,
        instance: 'default',
        ports: { web: 3000, postgres: 3001, redis: 3002 },
        checks: {
          db: { ok: true },
          redis: { ok: true },
          docker: { ok: true },
          image: { ok: true },
          worker: { ok: true },
        },
      }),
    );
    try {
      const health = await apiFetch('getHealth');
      expect(health.ok).toBe(true);
      expect(globalFetch).toHaveBeenCalledWith('/api/health', expect.any(Object));
    } finally {
      globalFetch.mockRestore();
    }
  });
});

describe('apiFetch no-content operations', () => {
  /**
   * A delete answers `204 No Content`. Parsing that as JSON is what used to throw
   * `INVALID_RESPONSE` on every successful delete; the call must simply resolve.
   */
  it.each([
    ['deleteChat', { id: 'c1' }, '/api/chats/c1'],
    ['deleteJob', { id: 'j1' }, '/api/jobs/j1'],
    ['deleteSecret', { key: 'GITHUB_PAT' }, '/api/settings/GITHUB_PAT'],
  ] as const)('resolves %s on a 204 with no body', async (operation, params, path) => {
    const fetchMock = fetchReturning(() => new Response(null, { status: 204 }));
    await expect(apiFetch(operation, { params, fetch: fetchMock })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ method: 'DELETE' }));
  });

  /**
   * The contract says these operations send nothing back, so a body is a disagreement between
   * client and server and is reported rather than quietly dropped.
   */
  it('rejects a no-content operation that unexpectedly returns a body', async () => {
    const fetchMock = fetchReturning(() => jsonResponse({ ok: true }));
    await expect(
      apiFetch('deleteChat', { params: { id: 'c1' }, fetch: fetchMock }),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 200,
      message: 'Response carries a body but the operation declares none',
    });
  });

  /**
   * 204 is a null-body status, so the emptiness check exists for the statuses that may carry one:
   * a 200 whose body is blank still means "nothing to report" and must not fail the delete.
   */
  it('accepts a blank body as empty', async () => {
    const fetchMock = fetchReturning(() => new Response('\n  ', { status: 200 }));
    await expect(
      apiFetch('deleteChat', { params: { id: 'c1' }, fetch: fetchMock }),
    ).resolves.toBeUndefined();
  });

  /**
   * The mirror case: an operation that declares a body schema cannot be satisfied by a 204, and
   * says so precisely instead of surfacing as "not JSON".
   */
  it('rejects a 204 for an operation that declares a body', async () => {
    const fetchMock = fetchReturning(() => new Response(null, { status: 204 }));
    await expect(apiFetch('listChats', { fetch: fetchMock })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 204,
      message: 'Response carries no body but the operation declares one',
    });
  });
});

describe('createEventSource', () => {
  const created: string[] = [];

  function FakeEventSource(this: unknown, url: string): void {
    created.push(url);
  }

  afterEach(() => {
    created.length = 0;
    vi.unstubAllGlobals();
  });

  /**
   * Opens the stream at the given path, appending `from=` (URL-encoded) when resuming, with `&`
   * when the path already carries a query string.
   */
  it('opens a same-origin stream with an optional resume point', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    createEventSource('/api/chats/c1/events');
    createEventSource('/api/chats/c1/events', { lastEventId: '1700-0' });
    createEventSource('/api/chats/c1/events?x=1', { lastEventId: 'a b' });
    expect(created).toEqual([
      '/api/chats/c1/events',
      '/api/chats/c1/events?from=1700-0',
      '/api/chats/c1/events?x=1&from=a%20b',
    ]);
  });
});
