/**
 * Tests for the chat/turn mock handlers: every route's response shape, ordering, and error paths.
 */
import {
  chatDetail,
  chatSummary,
  createChatResponse,
  listChatsResponse,
  okResponse,
  postMessageResponse,
  RESTORATION_NOTICE_PREFIX,
} from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

async function errorBody(
  response: Response,
): Promise<{ error: { code: string; message: string } }> {
  return (await response.json()) as { error: { code: string; message: string } };
}

describe('GET /api/chats', () => {
  // ACTIVE is the default status filter, newest-updated first.
  it('lists ACTIVE chats by default, newest-updated first', async () => {
    const response = await fetch('/api/chats');
    expect(response.status).toBe(200);
    const body = listChatsResponse.parse(await response.json());
    expect(body.chats.every((chat) => chat.status === 'ACTIVE')).toBe(true);
    const updatedTimestamps = body.chats.map((chat) => Date.parse(chat.updatedAt));
    expect(updatedTimestamps).toEqual([...updatedTimestamps].sort((a, b) => b - a));
  });

  // status=ARCHIVED lists only archived chats.
  it('lists ARCHIVED chats when requested', async () => {
    const response = await fetch('/api/chats?status=ARCHIVED');
    const body = listChatsResponse.parse(await response.json());
    expect(body.chats.every((chat) => chat.status === 'ARCHIVED')).toBe(true);
    expect(body.chats.length).toBeGreaterThan(0);
  });

  // An unrecognized status value is a 400 validation error, not a silent empty list.
  it('400s for an invalid status value', async () => {
    const response = await fetch('/api/chats?status=NOT_A_STATUS');
    expect(response.status).toBe(400);
    const body = await errorBody(response);
    expect(body.error.code).toBe('VALIDATION');
  });
});

describe('POST /api/chats', () => {
  // A valid request creates a chat and a QUEUED turn, returning 201.
  it('creates a chat with a QUEUED turn', async () => {
    const response = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoUrl: 'https://github.com/acme/api',
        baseBranch: 'main',
        prompt: 'Add a health check endpoint.',
      }),
    });
    expect(response.status).toBe(201);
    const body = createChatResponse.parse(await response.json());

    const detailResponse = await fetch(`/api/chats/${body.chatId}`);
    const detail = chatDetail.parse(await detailResponse.json());
    expect(detail.chat.title).toBe('Add a health check endpoint.');
    expect(detail.turns[0]?.status).toBe('QUEUED');
    expect(detail.messages[0]?.content).toBe('Add a health check endpoint.');
  });

  // The title is clamped to the first 60 characters of the prompt.
  it('clamps the title to 60 characters', async () => {
    const prompt = 'x'.repeat(120);
    const response = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoUrl: 'https://github.com/acme/api', baseBranch: 'main', prompt }),
    });
    const body = createChatResponse.parse(await response.json());
    const detail = chatDetail.parse(await (await fetch(`/api/chats/${body.chatId}`)).json());
    expect(detail.chat.title).toHaveLength(60);
  });

  // An invalid body (bad repoUrl) is a 400 VALIDATION error.
  it('400s on an invalid body', async () => {
    const response = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoUrl: 'not-a-url', baseBranch: 'main', prompt: 'hi' }),
    });
    expect(response.status).toBe(400);
    expect((await errorBody(response)).error.code).toBe('VALIDATION');
  });
});

describe('GET /api/chats/:id', () => {
  // The seeded running chat satisfies chatDetail byte-for-byte.
  it('returns chatDetail for a seeded chat', async () => {
    const response = await fetch('/api/chats/chat-finished');
    expect(response.status).toBe(200);
    const body = chatDetail.parse(await response.json());
    expect(body.chat.id).toBe('chat-finished');
    expect(body.turns).toHaveLength(1);
    expect(body.toolCalls).toHaveLength(1);
  });

  // An unknown chat id is a 404.
  it('404s for an unknown chat', async () => {
    const response = await fetch('/api/chats/does-not-exist');
    expect(response.status).toBe(404);
    expect((await errorBody(response)).error.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /api/chats/:id', () => {
  // A valid title renames the chat.
  it('renames the chat', async () => {
    const response = await fetch('/api/chats/chat-finished', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed title' }),
    });
    expect(response.status).toBe(200);
    const body = chatSummary.parse(await response.json());
    expect(body.title).toBe('Renamed title');
  });

  // An empty title is a 400.
  it('400s on an empty title', async () => {
    const response = await fetch('/api/chats/chat-finished', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    });
    expect(response.status).toBe(400);
  });

  // An unknown chat id is a 404.
  it('404s for an unknown chat', async () => {
    const response = await fetch('/api/chats/does-not-exist', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(response.status).toBe(404);
  });
});

describe('DELETE /api/chats/:id', () => {
  // Deleting a chat removes it (204), and it is then gone.
  it('deletes a chat, 204, then 404s on a following GET', async () => {
    const created = createChatResponse.parse(
      await (
        await fetch('/api/chats', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            repoUrl: 'https://github.com/acme/api',
            baseBranch: 'main',
            prompt: 'to be deleted',
          }),
        })
      ).json(),
    );
    const deleteResponse = await fetch(`/api/chats/${created.chatId}`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(204);
    expect(await deleteResponse.text()).toBe('');
    const getResponse = await fetch(`/api/chats/${created.chatId}`);
    expect(getResponse.status).toBe(404);
  });

  // An unknown chat id is a 404.
  it('404s for an unknown chat', async () => {
    const response = await fetch('/api/chats/does-not-exist', { method: 'DELETE' });
    expect(response.status).toBe(404);
  });
});

describe('POST /api/chats/:id/messages', () => {
  // A valid prompt appends a USER message and queues a new turn.
  it('appends a message and queues a new turn', async () => {
    const response = await fetch('/api/chats/chat-finished/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'One more thing.' }),
    });
    expect(response.status).toBe(200);
    const body = postMessageResponse.parse(await response.json());

    const detail = chatDetail.parse(await (await fetch('/api/chats/chat-finished')).json());
    expect(detail.turns.some((turn) => turn.id === body.turnId && turn.status === 'QUEUED')).toBe(
      true,
    );
    expect(detail.messages.at(-1)?.content).toBe('One more thing.');
  });

  // A chat with no workspace yet (never provisioned, unlike chat-finished's) queues a turn with
  // workspaceId: null rather than inheriting a stale one.
  it('queues a turn with a null workspaceId for a chat with no workspace', async () => {
    const response = await fetch('/api/chats/chat-running/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Another thing.' }),
    });
    expect(response.status).toBe(200);
    const body = postMessageResponse.parse(await response.json());
    const detail = chatDetail.parse(await (await fetch('/api/chats/chat-running')).json());
    expect(detail.turns.find((turn) => turn.id === body.turnId)?.workspaceId).toBeNull();
  });

  // An archived chat rejects new messages with 409 CHAT_ARCHIVED.
  it('409s on an archived chat', async () => {
    const response = await fetch('/api/chats/chat-archived/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(response.status).toBe(409);
    expect((await errorBody(response)).error.code).toBe('CHAT_ARCHIVED');
  });

  // An unknown chat id is a 404.
  it('404s for an unknown chat', async () => {
    const response = await fetch('/api/chats/does-not-exist/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(response.status).toBe(404);
  });

  // An invalid body (empty prompt) is a 400.
  it('400s on an empty prompt', async () => {
    const response = await fetch('/api/chats/chat-finished/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('POST /api/chats/:id/archive and /restore', () => {
  // Archiving flips status and clears the live workspace.
  it('archives a chat', async () => {
    const response = await fetch('/api/chats/chat-finished/archive', { method: 'POST' });
    expect(response.status).toBe(200);
    const body = chatSummary.parse(await response.json());
    expect(body.status).toBe('ARCHIVED');
    expect(body.archivedAt).not.toBeNull();
  });

  // Restoring an archived chat reactivates it and appends the normative restoration notice — the
  // same text the product writes, so a spec reading it in mock mode is reading the product.
  it('restores an archived chat and records the restoration notice', async () => {
    const response = await fetch('/api/chats/chat-archived/restore', { method: 'POST' });
    expect(response.status).toBe(200);
    const body = chatSummary.parse(await response.json());
    expect(body.status).toBe('ACTIVE');
    expect(body.archivedAt).toBeNull();

    const detail = chatDetail.parse(await (await fetch('/api/chats/chat-archived')).json());
    const lastMessage = detail.messages.at(-1);
    expect(lastMessage?.role).toBe('SYSTEM');
    expect(lastMessage?.content).toContain(RESTORATION_NOTICE_PREFIX);
    expect(lastMessage?.content).toContain('pushed work on `agent/qc7` is checked out');
  });

  // An unknown chat id 404s for both archive and restore.
  it('404s for an unknown chat', async () => {
    expect((await fetch('/api/chats/does-not-exist/archive', { method: 'POST' })).status).toBe(404);
    expect((await fetch('/api/chats/does-not-exist/restore', { method: 'POST' })).status).toBe(404);
  });
});

describe('POST /api/turns/:id/cancel', () => {
  // Cancelling a known turn marks it CANCELLED and updates the chat's lastTurnStatus.
  it('cancels a known turn', async () => {
    const response = await fetch('/api/turns/turn-running-1/cancel', { method: 'POST' });
    expect(response.status).toBe(200);
    const body = okResponse.parse(await response.json());
    expect(body.ok).toBe(true);

    const detail = chatDetail.parse(await (await fetch('/api/chats/chat-running')).json());
    expect(detail.turns[0]?.status).toBe('CANCELLED');
    expect(detail.chat.lastTurnStatus).toBe('CANCELLED');
  });

  // An unknown turn id is a 404.
  it('404s for an unknown turn', async () => {
    const response = await fetch('/api/turns/does-not-exist/cancel', { method: 'POST' });
    expect(response.status).toBe(404);
  });
});

describe('POST /api/turns/:id/retry', () => {
  // Retrying re-queues the failed turn itself and adds nothing to the chat's history, which is
  // the behaviour the screen is tested against.
  it('re-queues a failed turn without touching its messages', async () => {
    const before = chatDetail.parse(await (await fetch('/api/chats/chat-failed')).json());

    const response = await fetch('/api/turns/turn-failed-1/retry', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(okResponse.parse(await response.json()).ok).toBe(true);
    const after = chatDetail.parse(await (await fetch('/api/chats/chat-failed')).json());
    expect(after.messages).toEqual(before.messages);
    expect(after.turns).toHaveLength(1);
    expect(after.turns[0]).toMatchObject({ id: 'turn-failed-1', status: 'QUEUED', error: null });
    expect(after.chat.lastTurnStatus).toBe('QUEUED');
  });

  // A turn that did not fail is refused, exactly as the route refuses it.
  it('409s for a turn that has not failed', async () => {
    const response = await fetch('/api/turns/turn-finished-1/retry', { method: 'POST' });
    expect(response.status).toBe(409);
    expect((await errorBody(response)).error.code).toBe('TURN_NOT_RETRYABLE');
  });

  // An unknown turn id is a 404, so a client naming the wrong row learns it rather than silently
  // succeeding against nothing.
  it('404s for an unknown turn', async () => {
    const response = await fetch('/api/turns/does-not-exist/retry', { method: 'POST' });
    expect(response.status).toBe(404);
  });
});
