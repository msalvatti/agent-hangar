/**
 * Tests for `useCreateChat`: the create-and-navigate flow behind the home composer.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useApiQuery } from '@/shared/api/use-api-query';
import { getRecentRepos } from '@/shared/repo-picker';

import { useCreateChat } from './useCreateChat';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

describe('useCreateChat', () => {
  beforeEach(() => {
    push.mockClear();
    localStorage.clear();
  });

  // The happy path posts the chat, remembers the repo and navigates to the new conversation.
  it('creates a chat, records the repo and navigates to it', async () => {
    const { result } = renderHook(() => useCreateChat());
    await act(async () => {
      await result.current.create({ repo: 'acme/api', branch: 'main', prompt: 'Explain auth.' });
    });
    await waitFor(() => {
      expect(push).toHaveBeenCalledTimes(1);
    });
    expect(push.mock.calls[0]?.[0]).toMatch(/^\/chats\/.+/);
    expect(getRecentRepos()).toContain('acme/api');
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  // Success must refresh the sidebar list, which is keyed by the `chats` prefix.
  it('invalidates the chat list queries', async () => {
    const loader = vi.fn().mockResolvedValue({ chats: [] });
    const { result } = renderHook(() => ({
      list: useApiQuery(['chats', 'ACTIVE'], loader),
      create: useCreateChat(),
    }));
    await waitFor(() => {
      expect(result.current.list.status).toBe('success');
    });
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.create.create({
        repo: 'acme/api',
        branch: 'main',
        prompt: 'Explain auth.',
      });
    });
    await waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(2);
    });
  });

  // A rejected request leaves the composer usable and shows why it failed.
  it('reports a validation failure without navigating', async () => {
    const { result } = renderHook(() => useCreateChat());
    await act(async () => {
      await result.current.create({ repo: 'acme/api', branch: 'main', prompt: '' });
    });
    expect(push).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeDefined();
  });

  // A repository that is not `owner/name` throws before any request is made.
  it('reports a malformed repository without calling the API', async () => {
    const { result } = renderHook(() => useCreateChat());
    await act(async () => {
      await result.current.create({ repo: 'acme', branch: 'main', prompt: 'hi' });
    });
    expect(result.current.error).toMatch(/owner\/name/);
    expect(push).not.toHaveBeenCalled();
  });

  // A rejection that is not an `Error` (a network layer can produce one) still yields a message.
  it('reports a non-Error rejection', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue('socket closed');
    try {
      const { result } = renderHook(() => useCreateChat());
      await act(async () => {
        await result.current.create({ repo: 'acme/api', branch: 'main', prompt: 'hi' });
      });
      expect(result.current.error).toBe('socket closed');
    } finally {
      globalThis.fetch = original;
    }
  });

  // `reset` clears the message so a resubmission starts from a clean state.
  it('clears the error on reset', async () => {
    const { result } = renderHook(() => useCreateChat());
    await act(async () => {
      await result.current.create({ repo: 'acme', branch: 'main', prompt: 'hi' });
    });
    act(() => {
      result.current.reset();
    });
    expect(result.current.error).toBeUndefined();
  });
});
