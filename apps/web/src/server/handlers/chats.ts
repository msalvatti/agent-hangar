/**
 * Chat routes: create, list, read, rename, post message, archive, restore and delete.
 *
 * Layer: service (server).
 *
 * Each handler is a pure function of the container, a `Request` and the resolved path params, so
 * it runs under Vitest without Next.js. Rows are always written before anything is enqueued: a job
 * that arrives at the worker before its row exists has nothing to work on, while a row without a
 * job is visible and recoverable.
 */
import {
  chatSummary,
  createChatRequest,
  createChatResponse,
  enqueueDestroyChatWorkspace,
  enqueueRunTurn,
  listChatsQuery,
  listChatsResponse,
  postMessageRequest,
  postMessageResponse,
  renameChatRequest,
  restorationNotice,
  restoreChatQuery,
} from '@agent-hangar/core';
import type { Chat, Turn } from '@agent-hangar/core';

import type { ServerContainer } from '../container';
import { ConflictError, ResourceNotFoundError } from '../errors';
import {
  json,
  jsonResponse,
  noContent,
  parseJsonBody,
  parseQuery,
  withErrorHandling,
} from '../http';
import { allowedRepoHosts, assertRepoUrlAllowed } from '../repo-url';
import { assertSameOrigin } from '../same-origin';

import { requireNoLiveTurn, requireSecrets } from './guards';
import { lastTurnStatus, toChatDetail, toChatSummary } from './mappers';

/** Longest title derived from a prompt; the rest of the prompt is the first message. */
export const TITLE_LENGTH = 80;

/** Path parameters of the chat routes. */
export interface ChatParams {
  id: string;
}

/**
 * Derives a chat title from its first prompt.
 *
 * @param prompt - The user's first message.
 * @returns A single-line title of at most {@link TITLE_LENGTH} characters.
 */
export function titleFromPrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').slice(0, TITLE_LENGTH);
}

/**
 * Loads a chat or reports it missing.
 *
 * @param container - The server container.
 * @param id - Chat id.
 * @returns The chat row.
 * @throws ResourceNotFoundError 404 when there is no such chat.
 */
async function requireChat(container: ServerContainer, id: string): Promise<Chat> {
  const chat = await container.repos.chats.getById(id);
  if (chat === null) {
    throw new ResourceNotFoundError('Chat not found');
  }
  return chat;
}

/**
 * Creates a queued turn and hands it to the worker.
 *
 * The turn's `queueJobId` is set to its own id, which is also the BullMQ job id, so a retried
 * request enqueues the same work once. If the enqueue fails the turn is marked `FAILED` before the
 * error propagates: a `QUEUED` turn no worker will ever see would spin the UI forever.
 *
 * @param container - The server container.
 * @param chatId - Chat the turn belongs to.
 * @returns The created turn.
 * @throws Error Whatever the queue rejected with, after the turn was failed.
 */
async function queueTurn(container: ServerContainer, chatId: string): Promise<Turn> {
  const turn = await container.repos.turns.create({
    chatId,
    model: container.config.OPENAI_MODEL,
  });
  await container.repos.turns.setStatus(turn.id, 'QUEUED', { queueJobId: turn.id });
  try {
    await enqueueRunTurn(container.queues.chatTurns, { turnId: turn.id });
  } catch (error) {
    await container.repos.turns.finish(
      turn.id,
      'FAILED',
      { inputTokens: 0, outputTokens: 0, stepCount: 0 },
      'Could not enqueue the turn',
    );
    throw error;
  }
  return turn;
}

/**
 * Builds the full detail response of a chat.
 *
 * @param container - The server container.
 * @param chat - The chat row.
 * @returns The parsed detail value.
 */
async function readChatDetail(
  container: ServerContainer,
  chat: Chat,
): Promise<ReturnType<typeof toChatDetail>> {
  const { repos } = container;
  const [messages, turns, workspace] = await Promise.all([
    repos.messages.listByChat(chat.id),
    repos.turns.listByChat(chat.id),
    repos.workspaces.findLiveByChat(chat.id),
  ]);
  const toolCalls = (await Promise.all(turns.map((turn) => repos.toolCalls.listByTurn(turn.id))))
    .flat()
    .sort((left, right) => left.seq - right.seq);
  return toChatDetail({ chat, messages, turns, toolCalls, workspace });
}

/**
 * `POST /api/chats` — creates a chat, its first message and its first turn, then enqueues it.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @returns `201` with `{ chatId, turnId }`.
 */
export function createChat(container: ServerContainer, request: Request): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertSameOrigin(request);
    const body = await parseJsonBody(request, createChatRequest);
    assertRepoUrlAllowed(body.repoUrl, allowedRepoHosts(container.config));
    await requireSecrets(container);
    const chat = await container.repos.chats.create({
      title: titleFromPrompt(body.prompt),
      repoUrl: body.repoUrl,
      baseBranch: body.baseBranch,
    });
    await container.repos.messages.append(chat.id, 'USER', body.prompt);
    const turn = await queueTurn(container, chat.id);
    return jsonResponse(createChatResponse, { chatId: chat.id, turnId: turn.id }, { status: 201 });
  });
}

/**
 * `GET /api/chats?status=` — the sidebar list, most recently updated first.
 *
 * Omitting `status` lists every chat; the contract has no "all" value, so absence is what means
 * "do not filter".
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @returns `200` with the chat summaries.
 */
export function listChats(container: ServerContainer, request: Request): Promise<Response> {
  return withErrorHandling(container, async () => {
    const query = parseQuery(request.url, listChatsQuery);
    const chats = await container.repos.chats.list(query.status);
    const summaries = await Promise.all(
      chats.map(async (chat) =>
        toChatSummary(chat, lastTurnStatus(await container.repos.turns.listByChat(chat.id))),
      ),
    );
    return jsonResponse(listChatsResponse, { chats: summaries });
  });
}

/**
 * `GET /api/chats/:id` — the chat with its messages, turns, tool calls and live workspace.
 *
 * @param container - The server container.
 * @param _request - The incoming request; this route reads nothing from it.
 * @param params - Resolved path parameters.
 * @returns `200` with the detail, or `404`.
 */
export function getChat(
  container: ServerContainer,
  _request: Request,
  params: ChatParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    const chat = await requireChat(container, params.id);
    // The mapper already parsed the value against `chatDetail`; parsing it again here would only
    // repeat the work.
    return json(await readChatDetail(container, chat));
  });
}

/**
 * `PATCH /api/chats/:id` — renames the chat.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters.
 * @returns `200` with the updated summary, or `404`.
 */
export function renameChat(
  container: ServerContainer,
  request: Request,
  params: ChatParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertSameOrigin(request);
    await requireChat(container, params.id);
    const body = await parseJsonBody(request, renameChatRequest);
    const chat = await container.repos.chats.rename(params.id, body.title);
    const turns = await container.repos.turns.listByChat(chat.id);
    return jsonResponse(chatSummary, toChatSummary(chat, lastTurnStatus(turns)));
  });
}

/**
 * `POST /api/chats/:id/messages` — appends a user message and queues the turn that answers it.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters.
 * @returns `201` with `{ turnId }`.
 */
export function postMessage(
  container: ServerContainer,
  request: Request,
  params: ChatParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertSameOrigin(request);
    const chat = await requireChat(container, params.id);
    if (chat.status !== 'ACTIVE') {
      throw new ConflictError('CHAT_ARCHIVED', 'Restore the chat before sending messages');
    }
    await requireNoLiveTurn(container, chat.id);
    await requireSecrets(container);
    const body = await parseJsonBody(request, postMessageRequest);
    await container.repos.messages.append(chat.id, 'USER', body.prompt);
    const turn = await queueTurn(container, chat.id);
    await container.repos.chats.touch(chat.id);
    return jsonResponse(postMessageResponse, { turnId: turn.id }, { status: 201 });
  });
}

/**
 * `POST /api/chats/:id/archive` — archives the chat and asks the worker to tear its workspace down.
 *
 * The teardown job is enqueued unconditionally: the worker owns the decision of whether a
 * container exists, and it snapshots the repository before destroying it.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters.
 * @returns `200` with the archived summary.
 */
export function archiveChat(
  container: ServerContainer,
  request: Request,
  params: ChatParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertSameOrigin(request);
    const chat = await requireChat(container, params.id);
    if (chat.status !== 'ACTIVE') {
      throw new ConflictError('ILLEGAL_TRANSITION', 'Chat is not active');
    }
    await requireNoLiveTurn(container, chat.id);
    const archived = await container.repos.chats.setStatus(chat.id, 'ARCHIVED');
    await enqueueDestroyChatWorkspace(container.queues.workspaceGc, { chatId: chat.id });
    const turns = await container.repos.turns.listByChat(chat.id);
    return jsonResponse(chatSummary, toChatSummary(archived, lastTurnStatus(turns)));
  });
}

/**
 * `POST /api/chats/:id/restore` — reactivates the chat and records what the model lost.
 *
 * `?warm=1` is accepted and ignored: v1 has no warm-up job, and the next message recreates the
 * workspace from the persisted restore context.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters.
 * @returns `200` with the reactivated summary.
 */
export function restoreChat(
  container: ServerContainer,
  request: Request,
  params: ChatParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertSameOrigin(request);
    parseQuery(request.url, restoreChatQuery);
    const chat = await requireChat(container, params.id);
    if (chat.status !== 'ARCHIVED') {
      throw new ConflictError('ILLEGAL_TRANSITION', 'Chat is not archived');
    }
    const restored = await container.repos.chats.setStatus(chat.id, 'ACTIVE');
    await container.repos.messages.append(
      chat.id,
      'SYSTEM',
      restorationNotice({ at: container.clock.now(), workBranch: chat.workBranch }),
    );
    const turns = await container.repos.turns.listByChat(chat.id);
    return jsonResponse(chatSummary, toChatSummary(restored, lastTurnStatus(turns)));
  });
}

/**
 * `DELETE /api/chats/:id` — removes the chat and everything that cascades from it.
 *
 * The teardown job goes out before the row is deleted, while the chat id still resolves to a
 * workspace. The worker's processor must therefore be able to find the container by label once the
 * row is gone, because the workspace's chat reference is cleared by the cascade.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters.
 * @returns `204`.
 */
export function deleteChat(
  container: ServerContainer,
  request: Request,
  params: ChatParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertSameOrigin(request);
    const chat = await requireChat(container, params.id);
    await requireNoLiveTurn(container, chat.id);
    const live = await container.repos.workspaces.findLiveByChat(chat.id);
    if (live !== null) {
      await enqueueDestroyChatWorkspace(container.queues.workspaceGc, { chatId: chat.id });
    }
    await container.repos.chats.delete(chat.id);
    return noContent();
  });
}
