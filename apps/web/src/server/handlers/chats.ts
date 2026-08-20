/**
 * Chat routes: create, list, read, rename, post message, archive, restore and delete.
 *
 * Layer: service (server).
 *
 * Each handler is a pure function of the container, a `Request` and the resolved path params, so
 * it runs under Vitest without Next.js. Every row a job depends on is settled in Postgres before
 * the job is enqueued, deletions included: a job that arrives at the worker before the store agrees
 * with it acts on a state nobody asked for, while a row whose job never went out is visible and
 * recoverable.
 *
 * Sending a message claims the chat's single work slot with the turn row itself. The row is
 * `QUEUED` from the instant it is created, so a second request that creates one sees the first and
 * gives its own back instead of enqueueing a rival turn. Each request's own insert precedes its own
 * read, so the two orderings that would let both proceed contradict each other and the chat can
 * never end up with two live turns. The claim is a committed row rather than an in-process lock, so
 * it holds between two web processes reading the same database. Postgres has no partial unique
 * index over a chat's live turn, so the invariant is enforced here rather than declared once in the
 * schema.
 *
 * Archiving races the same request on a different field and is settled the same way. Its claim is
 * the status write, made before it re-reads the chat's turns; a message writes its turn before it
 * re-reads the status. Write-then-read on both sides is the whole argument, and it rules out the
 * outcome that matters — an `ARCHIVED` chat whose workspace teardown is queued while a turn it
 * accepted is still live.
 *
 * What the claim buys is mutual exclusion, not a winner. Refusing on sight of any rival is what
 * makes the rule single-valued, and the price is that when both inserts land before either read —
 * the ordinary outcome for two genuinely simultaneous requests, not a rare corner — *both* requests
 * give their claim back and neither message is accepted. A double-click or a client retry whose
 * latencies match is therefore answered twice with 409, and the caller has to send the message
 * again; nothing here breaks the tie for them. One further limit: if giving a claim back fails, the
 * chat keeps a `QUEUED` turn no worker will run until it is cancelled through
 * `POST /api/turns/:id/cancel`.
 *
 * Nothing fallible runs after the turn is handed to the worker. Every write a message needs — the
 * claim, the sidebar's ordering key, the message row — happens before the dispatch, so a failure
 * is always a failure of work that has not started: the error is honest and the retry is clean. A
 * bookkeeping write placed after the dispatch would answer 500 for a turn the worker already holds
 * and send the caller into a retry that meets its own turn as `TURN_IN_PROGRESS`, which is why
 * none is. The bump costs one small wrong in exchange: a send that fails after it leaves the chat
 * sorting as recently touched with nothing new in it, until the next write to that chat corrects
 * the key. A misordered sidebar is a smaller wrong than an error for work that is running.
 *
 * Archiving and restoring each write the chat's status before a second operation that can fail —
 * enqueuing the teardown job, appending the restoration notice — and each is a status the guards
 * above only accept from one side (`ACTIVE` to archive, `ARCHIVED` to restore), so a row left in
 * the new status has no request that can ever retry the failed half. Both undo that status write
 * on failure through `compensate` (`./compensate.ts`, shared with `handlers/jobs.ts`), the same
 * helper and the same shape as the job routes: the row goes back to the status it held before the
 * request, and the failed enqueue or append is what the request still fails with. A restore's undo
 * sets `archivedAt` to the moment of the undo, not the instant the chat was originally archived —
 * `Chat.setStatus` has no way to pin an exact timestamp — so the row returns to `ARCHIVED` but not
 * byte-for-byte to what it was. The guarantee stops where the undo itself fails: the two halves are
 * left disagreeing, the request still fails with the original error, and the mismatch is only
 * recorded in the log line `compensate` writes, naming the chat. Nothing here repairs that; an
 * operator, or a later request against the same chat that rewrites the status again, is what would.
 */
import {
  chatSummary,
  createChatRequest,
  createChatResponse,
  enqueueDestroyChatWorkspace,
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

import { compensate } from './compensate';
import { dispatchTurn } from './dispatch';
import { isLive, NO_USAGE, requireNoLiveTurn, requireSecrets } from './guards';
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

/** Error recorded on a turn whose claim on the chat was given back before any work started. */
const CLAIM_RELEASED = 'Released: another message claimed the chat at the same moment';

/**
 * Creates the turn row that claims the chat's single work slot.
 *
 * The row is `QUEUED` the moment it exists, which is what makes the claim visible to a concurrent
 * request before anything has been handed to the worker.
 *
 * @param container - The server container.
 * @param chatId - Chat the turn belongs to.
 * @returns The created turn.
 */
function claimTurn(container: ServerContainer, chatId: string): Promise<Turn> {
  return container.repos.turns.create({ chatId, model: container.config.OPENAI_MODEL });
}

/**
 * Refuses to continue when the chat is no longer accepting work.
 *
 * Read after the caller has written its own claim, so it sees an archive that committed
 * concurrently: the archive's status write and this read are ordered the same way on both sides,
 * which is what stops a message and an archive from both proceeding.
 *
 * @param container - The server container.
 * @param chatId - Chat to re-read.
 * @throws ConflictError 409 `CHAT_ARCHIVED` when the chat was archived meanwhile.
 */
async function requireStillActive(container: ServerContainer, chatId: string): Promise<void> {
  const chat = await requireChat(container, chatId);
  if (chat.status !== 'ACTIVE') {
    throw new ConflictError('CHAT_ARCHIVED', 'The chat was archived while the message was sent');
  }
}

/**
 * Refuses to continue when the chat carries a live turn other than the caller's own claim.
 *
 * Losing on sight rather than by comparing ids is what keeps the rule single-valued under every
 * interleaving: the request that never saw a rival is the only one that can win, so two requests
 * can both refuse but can never both proceed.
 *
 * @param container - The server container.
 * @param chatId - Chat the claim was made against.
 * @param turnId - The caller's own claim, excluded from the check.
 * @throws ConflictError 409 `TURN_IN_PROGRESS` when another live turn exists.
 */
async function requireSoleClaim(
  container: ServerContainer,
  chatId: string,
  turnId: string,
): Promise<void> {
  const turns = await container.repos.turns.listByChat(chatId);
  if (turns.some((turn) => turn.id !== turnId && isLive(turn.status))) {
    throw new ConflictError(
      'TURN_IN_PROGRESS',
      'Another message claimed this chat at the same moment; send it again',
    );
  }
}

/**
 * Builds the full detail response of a chat.
 *
 * The tool calls are flattened turn by turn and not re-sorted. `seq` orders a call within its own
 * turn and nothing wider, so comparing it across turns interleaves them: two turns of two calls
 * come back as first-of-each then second-of-each instead of in execution order. The turns arrive
 * oldest first and each turn's calls arrive in `seq` order, so concatenating them is already the
 * order the work happened in.
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
  const toolCalls = (
    await Promise.all(turns.map((turn) => repos.toolCalls.listByTurn(turn.id)))
  ).flat();
  return toChatDetail({ chat, messages, turns, toolCalls, workspace });
}

/**
 * `POST /api/chats` — creates a chat, its first message and its first turn, then enqueues it.
 *
 * The turn is claimed and dispatched without the check {@link postMessage} runs, because the chat
 * id is minted by this request: no other request can name it until this one has answered.
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
    const turn = await dispatchTurn(container, await claimTurn(container, chat.id));
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
 * {@link requireNoLiveTurn} reads the chat's turns and the turn that answers this message is
 * written afterwards, so two simultaneous requests can both find the chat idle. The gap is closed
 * on the far side of the write instead of before it: each request creates its own `QUEUED` turn
 * and then looks again, and a request that finds a live turn other than its own gives its claim
 * back and refuses. The same re-read covers the archive route, which races this one on the other
 * field: the status is read again after the claim exists, so a chat archived meanwhile is seen.
 * The message is appended only once both checks have held, so a refused request leaves no half of
 * the exchange behind.
 *
 * Both durable writes sit inside that guarded block, and the ordering key is bumped before the
 * message rather than after the dispatch. The order is what makes each failure cheap: a bump that
 * fails has written nothing but a sort key, an append that fails has written nothing at all, and
 * either way the claim goes back and no turn was ever queued.
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
    const turn = await claimTurn(container, chat.id);
    try {
      await requireSoleClaim(container, chat.id, turn.id);
      await requireStillActive(container, chat.id);
      await container.repos.chats.touch(chat.id);
      await container.repos.messages.append(chat.id, 'USER', body.prompt);
    } catch (error) {
      await compensate(
        container,
        { chatId: chat.id, turnId: turn.id },
        'could not release a chat turn claim',
        () => container.repos.turns.finish(turn.id, 'CANCELLED', NO_USAGE, CLAIM_RELEASED),
      );
      throw error;
    }
    await dispatchTurn(container, turn);
    return jsonResponse(postMessageResponse, { turnId: turn.id }, { status: 201 });
  });
}

/**
 * `POST /api/chats/:id/archive` — archives the chat and asks the worker to tear its workspace down.
 *
 * The teardown job is enqueued unconditionally: the worker owns the decision of whether a
 * container exists, and it snapshots the repository before destroying it.
 *
 * The status write is this route's claim on the chat, and it is made before the live-turn check
 * that decides whether the teardown may go out. A message request claims the chat by writing its
 * own turn and then re-reads the status, so each side writes before it reads the other's marker
 * and the two cannot both proceed: either the archive sees the turn and gives up, or the message
 * sees `ARCHIVED` and gives up, or both see each other and both give up, which costs a retry and
 * never a destroyed workspace under running work. Whatever fails after the status write — the
 * re-read finding a turn, or the enqueue itself — undoes it, because `ARCHIVED` is the only status
 * this route will act on again and a row left in it would have no request that could ask for the
 * teardown.
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
    try {
      // Re-read after the status write, which is this route's claim: a message that passed its own
      // live-turn check before the archive landed has written its turn by now, and tearing the
      // workspace down under it would destroy the container the worker is about to use.
      await requireNoLiveTurn(container, chat.id);
      await enqueueDestroyChatWorkspace(container.queues.workspaceGc, { chatId: chat.id });
    } catch (error) {
      await compensate(
        container,
        { chatId: chat.id },
        'could not undo a partial chat archive',
        () => container.repos.chats.setStatus(chat.id, 'ACTIVE'),
      );
      throw error;
    }
    const turns = await container.repos.turns.listByChat(chat.id);
    return jsonResponse(chatSummary, toChatSummary(archived, lastTurnStatus(turns)));
  });
}

/**
 * `POST /api/chats/:id/restore` — reactivates the chat and records what the model lost.
 *
 * `?warm=1` is accepted and ignored: v1 has no warm-up job, and the next message recreates the
 * workspace from the persisted restore context. If the notice cannot be appended, the status write
 * is undone: `ACTIVE` is a status this route refuses to act on, so a row left in it after a failed
 * append would have no request left that could ever retry the notice.
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
    try {
      await container.repos.messages.append(
        chat.id,
        'SYSTEM',
        restorationNotice({ at: container.clock.now(), workBranch: chat.workBranch }),
      );
    } catch (error) {
      await compensate(
        container,
        { chatId: chat.id },
        'could not undo a partial chat restore',
        () => container.repos.chats.setStatus(chat.id, 'ARCHIVED'),
      );
      throw error;
    }
    const turns = await container.repos.turns.listByChat(chat.id);
    return jsonResponse(chatSummary, toChatSummary(restored, lastTurnStatus(turns)));
  });
}

/**
 * `DELETE /api/chats/:id` — removes the chat and everything that cascades from it.
 *
 * The row is deleted first and the teardown is enqueued afterwards, so every teardown the worker
 * can see names a chat that is already gone. Enqueueing first made the job visible while the
 * delete was still uncommitted, and a delete that then failed left a queued teardown that would
 * destroy the workspace of a chat still `ACTIVE`. The worker finds the container by its chat label
 * rather than by the row, which is what lets the job go out this late; the live workspace is read
 * before the delete because the cascade clears the workspace's chat reference, and the job is sent
 * only when there was one to tear down.
 *
 * The limit is the far side of the same window: an enqueue that fails after the delete committed
 * answers 500 with the row gone and the container still running. There is nothing to compensate —
 * the chat cannot be put back — so the residue is a workspace row whose chat reference is now null
 * and whose status is still live, which is exactly what the idle reaper and `pnpm ws:reap` collect
 * by. A container reclaimed late is recoverable; a workspace destroyed under a live chat is not.
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
    await container.repos.chats.delete(chat.id);
    if (live !== null) {
      await enqueueDestroyChatWorkspace(container.queues.workspaceGc, { chatId: chat.id });
    }
    return noContent();
  });
}
