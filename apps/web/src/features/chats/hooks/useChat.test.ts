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

  /**
   * A chat that has been created but has not yet run a turn has no last turn. Reading one out of an
   * empty list throws while rendering, which takes the whole chat view down — and this is the state
   * every chat is in for the moment between its creation and its first turn being queued.
   */
  it('reports no last turn for a chat that has not run one', async () => {
    server.use(
      http.get('/api/chats/:id', () =>
        HttpResponse.json({
          chat: {
            id: 'chat-new',
            title: 'Just created',
            status: 'ACTIVE',
            repoUrl: 'https://github.com/acme/api',
            baseBranch: 'main',
            workBranch: null,
            lastPushedSha: null,
            createdAt: '2026-08-19T10:00:00.000Z',
            updatedAt: '2026-08-19T10:00:00.000Z',
            archivedAt: null,
            lastTurnStatus: null,
          },
          messages: [],
          turns: [],
          toolCalls: [],
          workspace: null,
        }),
      ),
    );
    const { result } = renderHook(() => useChat('chat-new'));

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.lastTurnId).toBeNull();
    expect(result.current.mapped?.phase).toBe('idle');
  });

  // Before the response arrives there is nothing to map.
  it('has nothing mapped while loading', () => {
    const { result } = renderHook(() => useChat('chat-finished'));
    expect(result.current.mapped).toBeUndefined();
  });

  // Navigating from one chat to another keeps the hook mounted and only changes the id. Until the
  // new chat arrives there is nothing to show for it: the previous chat's transcript belongs to
  // the previous chat, and rendering it under the new id would attribute one conversation's
  // messages to another.
  it('shows nothing from the previous chat while the next one loads', async () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => useChat(id), {
      initialProps: { id: 'chat-finished' },
    });
    await waitFor(() => {
      expect(result.current.chat?.id).toBe('chat-finished');
    });

    rerender({ id: 'chat-running' });
    expect(result.current.chat).toBeUndefined();
    expect(result.current.mapped).toBeUndefined();
    expect(result.current.status).toBe('loading');

    await waitFor(() => {
      expect(result.current.chat?.id).toBe('chat-running');
    });
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
