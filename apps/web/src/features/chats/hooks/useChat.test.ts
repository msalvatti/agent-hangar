/**
 * Tests for `useChat`: loading one chat and telling an unknown id from a real failure.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '@/mocks/server';

import { useChat } from './useChat';

describe('useChat', () => {
  // A known chat comes back with its summary and its rebuilt transcript.
  it('loads a chat and maps its transcript', async () => {
    const { result } = renderHook(() => useChat('chat-finished'));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.chat?.id).toBe('chat-finished');
    expect(result.current.mapped?.items.length).toBeGreaterThan(0);
    expect(result.current.notFound).toBe(false);
  });

  // Before the response arrives there is nothing to map.
  it('has nothing mapped while loading', () => {
    const { result } = renderHook(() => useChat('chat-finished'));
    expect(result.current.mapped).toBeUndefined();
  });

  // An unknown id is the one failure with its own screen.
  it('reports an unknown chat as not found', async () => {
    const { result } = renderHook(() => useChat('chat-missing'));
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.notFound).toBe(true);
  });

  // Any other failure is a generic error with a retry, not a "not found".
  it('reports a server failure as an error', async () => {
    server.use(
      http.get('/api/chats/:id', () =>
        HttpResponse.json({ error: { code: 'BOOM', message: 'nope' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useChat('chat-finished'));
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.notFound).toBe(false);
    expect(result.current.error?.message).toBe('nope');
  });
});
