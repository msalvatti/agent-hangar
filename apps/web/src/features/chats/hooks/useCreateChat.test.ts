/**
 * Tests for `useCreateChat`: the create-and-navigate flow behind the home composer.
 */
import type { RepoSummary } from '@agent-hangar/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/mocks/server';
import { useApiQuery } from '@/shared/api/use-api-query';
import { getRecentRepos } from '@/shared/repo-picker';

import { useCreateChat } from './useCreateChat';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

/** A repository as `GET /api/repos` reports it, on the origin the caller names. */
function repo(fullName: string, url: string): RepoSummary {
  return { fullName, url, defaultBranch: 'main', private: false, description: null };
}

const githubRepo = repo('acme/api', 'https://github.com/acme/api');
const selfHostedRepo = repo('acme/infra', 'https://git.acme.test/acme/infra');

describe('useCreateChat', () => {
  beforeEach(() => {
    push.mockClear();
    localStorage.clear();
  });

  /**
   * The happy path posts the chat, remembers the repo and navigates to the new conversation.
   */
  it('creates a chat, records the repo and navigates to it', async () => {
    const { result } = renderHook(() => useCreateChat());
    await act(async () => {
      await result.current.create({ repo: githubRepo, branch: 'main', prompt: 'Explain auth.' });
    });
    await waitFor(() => {
      expect(push).toHaveBeenCalledTimes(1);
    });
    expect(push.mock.calls[0]?.[0]).toMatch(/^\/chats\/.+/);
    expect(getRecentRepos()).toContain('acme/api');
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  /**
   * Rule this protects: the clone URL sent is the one the listing reported, never one rebuilt
   * from `owner/name` against a hard-coded forge. A rebuilt URL made every repository outside
   * github.com unreachable from the interface, whatever the operator allowed, and the workspace
   * then failed to clone a repository that does not exist there.
   */
  it('sends the repository URL the listing reported, on any origin', async () => {
    const bodies: unknown[] = [];
    // Records the body and falls through (`undefined`) to the real mock handler, so the flow it
    // asserts is the one the app runs, not a stub of it.
    server.use(
      http.post('/api/chats', async ({ request }) => {
        bodies.push(await request.clone().json());
        return undefined;
      }),
    );
    const { result } = renderHook(() => useCreateChat());
    await act(async () => {
      await result.current.create({ repo: selfHostedRepo, branch: 'trunk', prompt: 'Audit it.' });
    });
    expect(bodies).toEqual([
      { repoUrl: 'https://git.acme.test/acme/infra', baseBranch: 'trunk', prompt: 'Audit it.' },
    ]);
    expect(push).toHaveBeenCalledTimes(1);
  });

  /**
   * The short form is still what the recent list remembers, since that is what the picker matches
   * its rows against.
   */
  it('records the short form of a repository on any origin', async () => {
    const { result } = renderHook(() => useCreateChat());
    await act(async () => {
      await result.current.create({ repo: selfHostedRepo, branch: 'trunk', prompt: 'Audit it.' });
    });
    expect(getRecentRepos()).toEqual(['acme/infra']);
  });

  /**
   * Success must refresh the sidebar list, which is keyed by the `chats` prefix.
   */
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
        repo: githubRepo,
        branch: 'main',
        prompt: 'Explain auth.',
      });
    });
    await waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * A rejected request leaves the composer usable and shows why it failed.
   */
  it('reports a validation failure without navigating', async () => {
    const { result } = renderHook(() => useCreateChat());
    await act(async () => {
      await result.current.create({ repo: githubRepo, branch: 'main', prompt: '' });
    });
    expect(push).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeDefined();
  });

  /**
   * A rejection that is not an `Error` (a network layer can produce one) still yields a message.
   */
  it('reports a non-Error rejection', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue('socket closed');
    try {
      const { result } = renderHook(() => useCreateChat());
      await act(async () => {
        await result.current.create({ repo: githubRepo, branch: 'main', prompt: 'hi' });
      });
      expect(result.current.error).toBe('socket closed');
    } finally {
      globalThis.fetch = original;
    }
  });

  /**
   * The composer locks while the request is in flight and unlocks afterwards, in both directions:
   * never locking sends a second chat on a second click, and never unlocking leaves the operator
   * with a composer they cannot use again.
   */
  it('locks the composer only while the request is in flight', async () => {
    const held: (() => void)[] = [];
    server.use(
      http.post('/api/chats', async () => {
        await new Promise<void>((resolve) => held.push(resolve));
        return undefined;
      }),
    );
    const { result } = renderHook(() => useCreateChat());
    expect(result.current.busy).toBe(false);

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.create({
        repo: githubRepo,
        branch: 'main',
        prompt: 'Explain auth.',
      });
    });
    await waitFor(() => {
      expect(result.current.busy).toBe(true);
    });

    await act(async () => {
      for (const release of held) {
        release();
      }
      await pending;
    });
    expect(result.current.busy).toBe(false);
  });

  /**
   * A retry starts clean. The message from the attempt before, left under a composer the operator
   * has since corrected, reads as a fresh rejection of what they just wrote.
   */
  it('clears a previous failure when a create is retried', async () => {
    const { result } = renderHook(() => useCreateChat());
    await act(async () => {
      await result.current.create({ repo: githubRepo, branch: 'main', prompt: '' });
    });
    expect(result.current.error).toBeDefined();

    await act(async () => {
      await result.current.create({ repo: githubRepo, branch: 'main', prompt: 'Explain auth.' });
    });

    expect(result.current.error).toBeUndefined();
  });

  /**
   * What is refreshed is the chat lists and nothing else: an invalidation broad enough to match
   * every key reloads every screen the app has open because one chat was created.
   */
  it('leaves unrelated queries alone', async () => {
    const settings = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => ({
      settings: useApiQuery(['settings'], settings),
      create: useCreateChat(),
    }));
    await waitFor(() => {
      expect(settings).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.create.create({
        repo: githubRepo,
        branch: 'main',
        prompt: 'Explain auth.',
      });
    });

    expect(settings).toHaveBeenCalledTimes(1);
  });

  /**
   * `reset` clears the message so a resubmission starts from a clean state.
   */
  it('clears the error on reset', async () => {
    const { result } = renderHook(() => useCreateChat());
    await act(async () => {
      await result.current.create({ repo: githubRepo, branch: 'main', prompt: '' });
    });
    act(() => {
      result.current.reset();
    });
    expect(result.current.error).toBeUndefined();
  });
});
