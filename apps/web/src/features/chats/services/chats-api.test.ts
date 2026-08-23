/**
 * Tests for the chat API wrappers: every call reaches the mock API and returns a body the
 * contract schema accepts, and failures surface as `ApiClientError`.
 */
import { describe, expect, it } from 'vitest';

import { ApiClientError } from '@/shared/api/client';

import {
  archiveChat,
  cancelTurn,
  createChat,
  deleteChat,
  getChat,
  getSettingsStatus,
  listChats,
  postMessage,
  renameChat,
  restoreChat,
} from './chats-api';

describe('chats-api', () => {
  // The sidebar list is filtered by lifecycle state and comes back parsed.
  it('lists active chats', async () => {
    const result = await listChats('ACTIVE', new AbortController().signal);
    expect(result.chats.length).toBeGreaterThan(0);
    expect(result.chats.every((chat) => chat.status === 'ACTIVE')).toBe(true);
  });

  // Archived chats are a separate list, not a flag on the active one.
  it('lists archived chats', async () => {
    const result = await listChats('ARCHIVED', new AbortController().signal);
    expect(result.chats.map((chat) => chat.id)).toContain('chat-archived');
  });

  // The detail call returns the chat plus everything the transcript needs to render.
  it('reads one chat with its messages and turns', async () => {
    const result = await getChat('chat-finished', new AbortController().signal);
    expect(result.chat.id).toBe('chat-finished');
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.turns.length).toBeGreaterThan(0);
  });

  // Creating a chat yields the two ids the caller navigates and subscribes with.
  it('creates a chat and returns the chat and turn ids', async () => {
    const result = await createChat({
      repoUrl: 'https://github.com/acme/api.git',
      baseBranch: 'main',
      prompt: 'Explain the auth flow.',
    });
    expect(result.chatId).not.toHaveLength(0);
    expect(result.turnId).not.toHaveLength(0);
  });

  // A follow-up queues another turn on an existing chat.
  it('posts a follow-up message', async () => {
    const result = await postMessage('chat-finished', 'And now add a test for it.');
    expect(result.turnId).not.toHaveLength(0);
  });

  // Renaming replaces the title and returns the refreshed summary.
  it('renames a chat', async () => {
    const result = await renameChat('chat-finished', 'Renamed chat');
    expect(result.title).toBe('Renamed chat');
  });

  // Archiving and restoring flip the lifecycle state in both directions.
  it('archives and restores a chat', async () => {
    expect((await archiveChat('chat-finished')).status).toBe('ARCHIVED');
    expect((await restoreChat('chat-finished')).status).toBe('ACTIVE');
  });

  // The delete operation answers 204, so the wrapper resolves to nothing at all.
  it('deletes a chat and resolves to undefined', async () => {
    await expect(deleteChat('chat-finished')).resolves.toBeUndefined();
  });

  // Cancelling a running turn acknowledges with the shared `{ ok: true }` body.
  it('cancels a turn', async () => {
    await expect(cancelTurn('turn-running-1')).resolves.toEqual({ ok: true });
  });

  // Settings status reports which credentials are set — never their values.
  it('reads the settings status', async () => {
    const result = await getSettingsStatus(new AbortController().signal);
    expect(result.githubPat.set).toBe(true);
    expect(result.model).not.toHaveLength(0);
  });

  /**
   * The caller's signal reaches the request. The home screen asks for this status on every mount
   * and the query aborts what is in flight when the view goes away; a request that ignores the
   * signal resolves into a component that no longer exists.
   */
  it('carries the abort signal into the request', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(getSettingsStatus(controller.signal)).rejects.toThrow();
  });

  // An unknown id is a 404 from the API and an `ApiClientError` to the caller.
  it('throws ApiClientError for an unknown turn', async () => {
    await expect(cancelTurn('turn-missing')).rejects.toBeInstanceOf(ApiClientError);
  });

  // An unknown chat fails the same way rather than resolving to an empty detail.
  it('throws ApiClientError for an unknown chat', async () => {
    await expect(getChat('chat-missing', new AbortController().signal)).rejects.toMatchObject({
      status: 404,
    });
  });
});
