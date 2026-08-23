/**
 * Tests for `useChats`: the two sidebar lists and their combined status.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '@/mocks/server';
import { invalidateQueries } from '@/shared/api/use-api-query';

import { useChats } from './useChats';

/**
 * Counts the listing requests each section makes, leaving them to be answered as usual.
 *
 * @returns A count per `status` parameter.
 */
function countListings(): { active: () => number; archived: () => number } {
  const seen: Record<string, number> = { ACTIVE: 0, ARCHIVED: 0 };
  server.use(
    http.get('/api/chats', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status') ?? '';
      seen[status] = (seen[status] ?? 0) + 1;
      return undefined;
    }),
  );
  return { active: () => seen.ACTIVE ?? 0, archived: () => seen.ARCHIVED ?? 0 };
}

describe('useChats', () => {
  // Both lists load independently and are reported separately.
  it('loads the active and archived lists', async () => {
    const { result } = renderHook(() => useChats());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.active.length).toBeGreaterThan(0);
    expect(result.current.archived.map((chat) => chat.id)).toContain('chat-archived');
  });

  // Until both have arrived the sidebar keeps showing skeletons.
  it('reports loading until both lists arrive', () => {
    const { result } = renderHook(() => useChats());
    expect(result.current.status).toBe('loading');
    // Both sections render an empty list rather than undefined rows while they wait.
    expect(result.current.active).toEqual([]);
    expect(result.current.archived).toEqual([]);
  });

  /**
   * "Loaded" means both. The sidebar swaps its skeletons for the real lists on this one value, so
   * reporting success while the second list is still in flight shows an archived section that is
   * empty because nothing has arrived, which reads exactly like an archive with nothing in it.
   */
  it('keeps reporting loading while one list is still in flight', async () => {
    let release = (): void => {
      throw new Error('The request was released before it was made');
    };
    server.use(
      http.get('/api/chats', async ({ request }) => {
        if (new URL(request.url).searchParams.get('status') === 'ARCHIVED') {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return undefined;
      }),
    );

    const { result } = renderHook(() => useChats());
    await waitFor(() => {
      expect(result.current.active.length).toBeGreaterThan(0);
    });
    expect(result.current.status).toBe('loading');

    act(() => {
      release();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
  });

  /**
   * Both lists sit under one prefix, so anything that changes a chat — archiving it, deleting it,
   * renaming it — reloads them together with a single invalidation and neither section is left
   * showing the chat as it was.
   */
  it('reloads both lists when the chats prefix is invalidated', async () => {
    const seen = countListings();
    const { result } = renderHook(() => useChats());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(seen.active()).toBe(1);
    expect(seen.archived()).toBe(1);

    act(() => {
      invalidateQueries(['chats']);
    });

    await waitFor(() => {
      expect(seen.active()).toBe(2);
      expect(seen.archived()).toBe(2);
    });
  });

  /**
   * And the two are still separate keys underneath, so a change that only concerns one section
   * reloads that one. Registered under the same key they would answer each other's invalidations
   * and — worse — each would serve the other's cached rows.
   */
  it.each([
    ['ACTIVE', 'active'],
    ['ARCHIVED', 'archived'],
  ] as const)('reloads only the %s list when its own key is invalidated', async (key, section) => {
    const seen = countListings();
    const { result } = renderHook(() => useChats());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    act(() => {
      invalidateQueries(['chats', key]);
    });

    await waitFor(() => {
      expect(seen[section]()).toBe(2);
    });
    expect(seen[section === 'active' ? 'archived' : 'active']()).toBe(1);
  });

  // A failure on either list is a failure of the section, with the message to show.
  it.each(['ACTIVE', 'ARCHIVED'])('reports an error when the %s list fails', async (failing) => {
    server.use(
      http.get('/api/chats', ({ request }) => {
        if (new URL(request.url).searchParams.get('status') === failing) {
          return HttpResponse.json({ error: { code: 'BOOM', message: 'nope' } }, { status: 500 });
        }
        return undefined;
      }),
    );
    const { result } = renderHook(() => useChats());
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error?.message).toBe('nope');
  });

  // Refetching reloads both lists at once.
  it('refetches both lists', async () => {
    const { result } = renderHook(() => useChats());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    await result.current.refetch();
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
  });
});
