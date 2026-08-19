/**
 * Tests for `useChats`: the two sidebar lists and their combined status.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '@/mocks/server';

import { useChats } from './useChats';

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
    expect(result.current.active).toEqual([]);
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
