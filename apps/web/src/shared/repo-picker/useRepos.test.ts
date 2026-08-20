/**
 * Tests for the debounced repository search hook.
 */
import { routes } from '@agent-hangar/core';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '@/mocks/server';

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
    await waitFor(
      () => {
        expect(seenQueries).toContain('acme');
      },
      { timeout: 2_000 },
    );
    expect(result.current.status).toBe('success');
    expect(seenQueries).toEqual(['a', 'acme']);
  });
});
