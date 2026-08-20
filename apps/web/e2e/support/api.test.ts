/**
 * Unit tests for the API client the specs assert with.
 *
 * Layer: unit test.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createApi, E2eApiError, UNPARSEABLE_ERROR_CODE } from './api';
import type { E2eFetcher, E2eRawResponse } from './api';

const BASE_URL = 'http://127.0.0.1:3900';

const body = z.object({ id: z.string() });

function fetcherReturning(response: E2eRawResponse): { fetcher: E2eFetcher; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fetcher: E2eFetcher = async (url, init) => {
    calls.push([url, init]);
    return Promise.resolve(response);
  };
  return { fetcher, calls };
}

describe('createApi', () => {
  /** A GET resolves the path against the base URL and parses the body with the given schema. */
  it('parses a successful GET with the contract schema', async () => {
    const { fetcher, calls } = fetcherReturning({ status: 200, text: '{"id":"c1"}' });
    const api = createApi(fetcher, BASE_URL);
    await expect(api.get('/api/chats/c1', body)).resolves.toEqual({ id: 'c1' });
    expect(calls[0]).toEqual([`${BASE_URL}/api/chats/c1`, { method: 'GET' }]);
  });

  /** A response that does not match the contract fails here, not three assertions later. */
  it('rejects a body that does not match the schema', async () => {
    const { fetcher } = fetcherReturning({ status: 200, text: '{"nope":1}' });
    await expect(createApi(fetcher, BASE_URL).get('/api/chats/c1', body)).rejects.toThrow();
  });

  /** POST and PUT send their body through and parse the response. */
  it('sends a body on POST and PUT', async () => {
    const { fetcher, calls } = fetcherReturning({ status: 201, text: '{"id":"c2"}' });
    const api = createApi(fetcher, BASE_URL);
    await api.post('/api/chats', { prompt: 'x' }, body);
    await api.put('/api/settings/GITHUB_PAT', { value: 'v' }, body);
    expect(calls[0]?.[1]).toEqual({ method: 'POST', body: { prompt: 'x' } });
    expect(calls[1]?.[1]).toEqual({ method: 'PUT', body: { value: 'v' } });
  });

  /** DELETE expects no body and resolves on any success status. */
  it('performs a DELETE without parsing a body', async () => {
    const { fetcher, calls } = fetcherReturning({ status: 204, text: '' });
    await expect(createApi(fetcher, BASE_URL).del('/api/jobs/j1')).resolves.toBeUndefined();
    expect(calls[0]?.[1]).toEqual({ method: 'DELETE' });
  });

  /** An error body that follows the contract surfaces its code, which specs assert on. */
  it('throws the contract error code on a failure', async () => {
    const { fetcher } = fetcherReturning({
      status: 409,
      text: '{"error":{"code":"SECRETS_MISSING","message":"no credentials"}}',
    });
    const failure = await createApi(fetcher, BASE_URL)
      .get('/api/chats/c1', body)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(E2eApiError);
    expect((failure as E2eApiError).status).toBe(409);
    expect((failure as E2eApiError).code).toBe('SECRETS_MISSING');
    expect((failure as E2eApiError).message).toContain('no credentials');
  });

  /** A failure whose body is not the contract's shape still throws, carrying the raw text. */
  it('throws a distinguishable error when the failure body is not the contract shape', async () => {
    const { fetcher } = fetcherReturning({ status: 500, text: '<html>boom</html>' });
    const failure = await createApi(fetcher, BASE_URL)
      .get('/api/chats/c1', body)
      .catch((error: unknown) => error);
    expect((failure as E2eApiError).code).toBe(UNPARSEABLE_ERROR_CODE);
    expect((failure as E2eApiError).message).toContain('boom');
  });

  /** A DELETE that fails must throw too, or a cleanup step would silently do nothing. */
  it('throws when a DELETE fails', async () => {
    const { fetcher } = fetcherReturning({
      status: 404,
      text: '{"error":{"code":"NOT_FOUND","message":"gone"}}',
    });
    await expect(createApi(fetcher, BASE_URL).del('/api/jobs/j1')).rejects.toBeInstanceOf(
      E2eApiError,
    );
  });

  /** `raw` hands back the untouched status and text, for assertions the schemas cannot make. */
  it('exposes the untouched response through raw', async () => {
    const { fetcher } = fetcherReturning({ status: 418, text: 'teapot' });
    await expect(
      createApi(fetcher, BASE_URL).raw('/api/health', { method: 'GET' }),
    ).resolves.toEqual({ status: 418, text: 'teapot' });
  });

  /** The transport is called once per request, so a retry cannot hide behind the client. */
  it('performs exactly one request per call', async () => {
    const fetcher = vi.fn<E2eFetcher>(async () =>
      Promise.resolve({ status: 200, text: '{"id":"a"}' }),
    );
    await createApi(fetcher, BASE_URL).get('/api/chats/a', body);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
