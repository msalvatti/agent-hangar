/**
 * Tests for the debounced repository search hook.
 */
import { routes } from '@agent-hangar/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '@/mocks/server';
import { invalidateQueries } from '@/shared/api/use-api-query';

import { useRepos } from './useRepos';

describe('useRepos', () => {
  // The debounced query eventually reaches the mock API and returns the seeded repos.
  it('fetches repos matching the query after the debounce window', async () => {
    const { result } = renderHook(() => useRepos('api'));
    await waitFor(
      () => {
        expect(result.current.status).toBe('success');
      },
      { timeout: 2_000 },
    );
    expect(result.current.data?.repos.map((repo) => repo.fullName)).toEqual(['acme/api']);
  });

  // Rapid query changes within the debounce window collapse into one final request (plus the
  // unavoidable immediate request for the mount value — `useDebounced` returns its initial value
  // right away, only *changes* after mount go through the debounce timer). Spies on the mock
  // handler with real timers throughout, matching the debounce hook's own real `setTimeout`,
  // rather than driving it with fake timers — `@testing-library/dom`'s `waitFor` only recognizes
  // Jest's fake timers (see its `jestFakeTimersAreEnabled` helper), so under Vitest it always
  // polls with a real `setInterval` regardless of `vi.useFakeTimers()`; switching timer modes
  // mid-test left React's scheduler bound to a clock that had stopped advancing, hanging the test
  // until Vitest's own per-test timeout.
  /**
   * The listing is registered under a key the rest of the tree invalidates by name — the settings
   * page does it after a token changes. Registered under anything else, the picker would go on
   * showing the repositories the previous token could reach.
   */
  it('refetches when the repos key is invalidated', async () => {
    const { result } = renderHook(() => useRepos(''));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    act(() => {
      invalidateQueries(['repos']);
    });

    await waitFor(() => {
      expect(result.current.isRefetching).toBe(true);
    });
    await waitFor(() => {
      expect(result.current.isRefetching).toBe(false);
    });
  });

  it('debounces rapid query changes into a single search', async () => {
    const seenQueries: string[] = [];
    server.use(
      http.get(routes.repos, ({ request }) => {
        const url = new URL(request.url);
        seenQueries.push(url.searchParams.get('query') ?? '');
        return HttpResponse.json({
          repos: [
            {
              fullName: 'acme/api',
              url: 'https://github.com/acme/api',
              defaultBranch: 'main',
              private: true,
              description: null,
            },
          ],
        });
      }),
    );
    const { result, rerender } = renderHook(({ query }: { query: string }) => useRepos(query), {
      initialProps: { query: 'a' },
    });
    rerender({ query: 'ac' });
    rerender({ query: 'acm' });
    rerender({ query: 'acme' });
    // Both conditions in the one waiter, because arriving is not settling: the handler records the
    // query the moment the request reaches it, and the response, the promise that carries it, the
    // state write and React's commit all still lie between that and a hook that reports `success`.
    // Waiting on the recorded query alone and asserting the status on the next line races that gap,
    // which is a race a slower machine wins — the status is `loading` until the load finishes, and
    // no timeout can be long enough to make a proxy condition mean the thing it stands in for.
    // The key comparison in `useApiQuery` is what makes the pair unambiguous: a `success` seen
    // after `acme` has been requested can only be `acme`'s, never the mount query's left over.
    await waitFor(
      () => {
        expect(seenQueries).toContain('acme');
        expect(result.current.status).toBe('success');
      },
      { timeout: 2_000 },
    );
    // Settled, so the request list is final: nothing else can issue one.
    expect(seenQueries).toEqual(['a', 'acme']);
  });
});
