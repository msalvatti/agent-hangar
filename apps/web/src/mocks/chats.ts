/**
 * MSW handlers for the chat routes: list, create, detail, rename, post-message, archive/restore,
 * delete, and turn cancel.
 *
 * Layer: mock (handler).
 */
import {
  apiError,
  createChatRequest,
  listChatsQuery,
  okResponse,
  postMessageRequest,
  renameChatRequest,
  restorationNotice,
  routes,
} from '@agent-hangar/core';
import type { ChatSummary, MessageView, TurnView } from '@agent-hangar/core';
import { http, HttpResponse } from 'msw';

import type { StoredChat } from './store';
import { nextId, nowIso, store } from './store';

function validationError(message: string) {
  return HttpResponse.json(apiError.parse({ error: { code: 'VALIDATION', message } }), {
    status: 400,
  });
}

function notFound(message = 'Not found') {
  return HttpResponse.json(apiError.parse({ error: { code: 'NOT_FOUND', message } }), {
    status: 404,
  });
}

function findChat(id: string): StoredChat | undefined {
  return store.chats.find((entry) => entry.chat.id === id);
}

/** `GET /api/chats?status=` — sidebar list, ACTIVE by default, newest-updated first. */
const listChats = http.get(routes.chats, ({ request }) => {
  const url = new URL(request.url);
  const parsed = listChatsQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return validationError(parsed.error.message);
  }
  const status = parsed.data.status ?? 'ACTIVE';
  const chats: ChatSummary[] = store.chats
    .filter((entry) => entry.chat.status === status)
    .map((entry) => entry.chat)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return HttpResponse.json({ chats });
});

/** `POST /api/chats` — creates a chat, its first USER message and a QUEUED turn. */
const createChat = http.post(routes.chats, async ({ request }) => {
  const parsed = createChatRequest.safeParse(await request.json());
  if (!parsed.success) {
    return validationError(parsed.error.message);
  }
  const { repoUrl, baseBranch, prompt } = parsed.data;
  const chatId = nextId();
  const turnId = nextId();
  const now = nowIso();
  const title = prompt.slice(0, 60);

  const message: MessageView = {
    id: nextId(),
    turnId,
    seq: 1,
    role: 'USER',
    content: prompt,
    createdAt: now,
  };
  const turn: TurnView = {
    id: turnId,
    status: 'QUEUED',
    model: store.model,
    workspaceId: null,
    usage: { inputTokens: null, outputTokens: null, stepCount: 0 },
    error: null,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
  };
  const entry: StoredChat = {
    chat: {
      id: chatId,
      title,
      status: 'ACTIVE',
      repoUrl,
      baseBranch,
      workBranch: null,
      lastPushedSha: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      lastTurnStatus: 'QUEUED',
    },
    messages: [message],
    turns: [turn],
    toolCalls: [],
    workspace: null,
  };
  store.chats.push(entry);
  return HttpResponse.json({ chatId, turnId }, { status: 201 });
});

/** `GET /api/chats/:id` — chat + messages + turns + tool calls + live workspace. */
const getChat = http.get(routes.chat, ({ params }) => {
  const id = String(params.id);
  const entry = findChat(id);
  if (entry === undefined) {
    return notFound('Unknown chat');
  }
  return HttpResponse.json({
    chat: entry.chat,
    messages: entry.messages,
    turns: entry.turns,
    toolCalls: entry.toolCalls,
    workspace: entry.workspace,
  });
});

/** `PATCH /api/chats/:id` — rename. */
const renameChat = http.patch(routes.chat, async ({ params, request }) => {
  const id = String(params.id);
  const entry = findChat(id);
  if (entry === undefined) {
    return notFound('Unknown chat');
  }
  const parsed = renameChatRequest.safeParse(await request.json());
  if (!parsed.success) {
    return validationError(parsed.error.message);
  }
  entry.chat = { ...entry.chat, title: parsed.data.title, updatedAt: nowIso() };
  return HttpResponse.json(entry.chat);
});

/** `DELETE /api/chats/:id` — cascade delete. */
const deleteChat = http.delete(routes.chat, ({ params }) => {
  const id = String(params.id);
  const index = store.chats.findIndex((entry) => entry.chat.id === id);
  if (index === -1) {
    return notFound('Unknown chat');
  }
  store.chats.splice(index, 1);
  return new HttpResponse(null, { status: 204 });
});

/** `POST /api/chats/:id/messages` — appends a USER message and queues a new turn. */
const postMessage = http.post(routes.chatMessages, async ({ params, request }) => {
  const id = String(params.id);
  const entry = findChat(id);
  if (entry === undefined) {
    return notFound('Unknown chat');
  }
  if (entry.chat.status === 'ARCHIVED') {
    return HttpResponse.json(
      apiError.parse({ error: { code: 'CHAT_ARCHIVED', message: 'Chat is archived' } }),
      { status: 409 },
    );
  }
  const parsed = postMessageRequest.safeParse(await request.json());
  if (!parsed.success) {
    return validationError(parsed.error.message);
  }
  const now = nowIso();
  const turnId = nextId();
  const message: MessageView = {
    id: nextId(),
    turnId,
    seq: entry.messages.length + 1,
    role: 'USER',
    content: parsed.data.prompt,
    createdAt: now,
  };
  const turn: TurnView = {
    id: turnId,
    status: 'QUEUED',
    model: store.model,
    workspaceId: entry.workspace?.id ?? null,
    usage: { inputTokens: null, outputTokens: null, stepCount: 0 },
    error: null,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
  };
  entry.messages.push(message);
  entry.turns.push(turn);
  entry.chat = { ...entry.chat, updatedAt: now, lastTurnStatus: 'QUEUED' };
  return HttpResponse.json({ turnId });
});

/** `POST /api/chats/:id/archive` — destroys the live workspace and marks the chat ARCHIVED. */
const archiveChat = http.post(routes.chatArchive, ({ params }) => {
  const id = String(params.id);
  const entry = findChat(id);
  if (entry === undefined) {
    return notFound('Unknown chat');
  }
  const now = nowIso();
  entry.chat = { ...entry.chat, status: 'ARCHIVED', archivedAt: now, updatedAt: now };
  entry.workspace = null;
  return HttpResponse.json(entry.chat);
});

/**
 * `POST /api/chats/:id/restore` — reactivates the chat and records the restoration notice.
 *
 * The notice is built from the shared helper, not written out here. Its wording is normative
 * (spec 02 §4, spec 04 (b)) and the end-to-end suite reads it in mock mode, so a sentence of this
 * double's own would let that assertion pass against text the product never writes.
 */
const restoreChat = http.post(routes.chatRestore, ({ params }) => {
  const id = String(params.id);
  const entry = findChat(id);
  if (entry === undefined) {
    return notFound('Unknown chat');
  }
  const now = nowIso();
  entry.chat = { ...entry.chat, status: 'ACTIVE', archivedAt: null, updatedAt: now };
  entry.messages.push({
    id: nextId(),
    turnId: null,
    seq: entry.messages.length + 1,
    role: 'SYSTEM',
    content: restorationNotice({ at: new Date(now), workBranch: entry.chat.workBranch }),
    createdAt: now,
  });
  return HttpResponse.json(entry.chat);
});

/** `POST /api/turns/:id/cancel` — marks the turn CANCELLED. */
const cancelTurn = http.post(routes.turnCancel, ({ params }) => {
  const id = String(params.id);
  for (const entry of store.chats) {
    const turn = entry.turns.find((candidate) => candidate.id === id);
    if (turn !== undefined) {
      const now = nowIso();
      Object.assign(turn, { status: 'CANCELLED', finishedAt: now });
      entry.chat = { ...entry.chat, lastTurnStatus: 'CANCELLED', updatedAt: now };
      return HttpResponse.json(okResponse.parse({ ok: true }));
    }
  }
  return notFound('Unknown turn');
});

/** Handlers for every chat and turn route. */
export const chatHandlers = [
  listChats,
  createChat,
  getChat,
  renameChat,
  deleteChat,
  postMessage,
  archiveChat,
  restoreChat,
  cancelTurn,
];
