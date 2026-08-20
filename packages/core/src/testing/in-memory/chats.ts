/**
 * In-memory `ChatRepository`, `MessageRepository` and `TurnRepository`.
 *
 * Layer: test double.
 */
import type { Chat, Message, Turn, UsageTotals } from '../../persistence/entities.ts';
import type {
  ChatRepository,
  CreateChatInput,
  CreateTurnInput,
  ListMessagesOptions,
  MessageRepository,
  RestoreHints,
  TerminalStatus,
  TurnRepository,
  TurnStatusUpdate,
} from '../../persistence/ports.ts';
import type { ChatStatus, MessageRole, TurnStatus } from '../../workspace/types.ts';

import type { InMemoryStore } from './store.ts';

/** Chat rows with cascade delete to messages, turns and tool calls. */
export class InMemoryChatRepository implements ChatRepository {
  constructor(private readonly store: InMemoryStore) {}

  async create(input: CreateChatInput): Promise<Chat> {
    const now = this.store.now();
    const chat: Chat = {
      id: this.store.newId(),
      title: input.title,
      status: 'ACTIVE',
      repoUrl: input.repoUrl,
      baseBranch: input.baseBranch,
      workBranch: null,
      lastPushedSha: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.store.chats.set(chat.id, chat);
    return { ...chat };
  }

  async getById(id: string): Promise<Chat | null> {
    const chat = this.store.chats.get(id);
    return chat === undefined ? null : { ...chat };
  }

  async list(status?: ChatStatus): Promise<Chat[]> {
    return [...this.store.chats.values()]
      .filter((chat) => status === undefined || chat.status === status)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((chat) => ({ ...chat }));
  }

  async rename(id: string, title: string): Promise<Chat> {
    return this.update(id, { title });
  }

  async setStatus(id: string, status: ChatStatus): Promise<Chat> {
    return this.update(id, { status, archivedAt: status === 'ARCHIVED' ? this.store.now() : null });
  }

  async updateRestoreHints(id: string, hints: RestoreHints): Promise<Chat> {
    const patch: Partial<Chat> = {};
    if (hints.workBranch !== undefined) {
      patch.workBranch = hints.workBranch;
    }
    if (hints.lastPushedSha !== undefined) {
      patch.lastPushedSha = hints.lastPushedSha;
    }
    return this.update(id, patch);
  }

  async touch(id: string): Promise<void> {
    await this.update(id, {});
  }

  async delete(id: string): Promise<void> {
    this.store.require(this.store.chats, 'Chat', id);
    const turnIds = new Set(
      [...this.store.turns.values()].filter((turn) => turn.chatId === id).map((turn) => turn.id),
    );
    for (const [toolCallId, toolCall] of this.store.toolCalls) {
      if (toolCall.turnId !== null && turnIds.has(toolCall.turnId)) {
        this.store.toolCalls.delete(toolCallId);
      }
    }
    for (const turnId of turnIds) {
      this.store.turns.delete(turnId);
    }
    for (const [messageId, message] of this.store.messages) {
      if (message.chatId === id) {
        this.store.messages.delete(messageId);
      }
    }
    for (const workspace of this.store.workspaces.values()) {
      if (workspace.chatId === id) {
        workspace.chatId = null;
      }
    }
    this.store.chats.delete(id);
  }

  private async update(id: string, patch: Partial<Chat>): Promise<Chat> {
    const chat = this.store.require(this.store.chats, 'Chat', id);
    Object.assign(chat, patch, { updatedAt: this.store.now() });
    return { ...chat };
  }
}

/** Message rows; `seq` is gap-free per chat. */
export class InMemoryMessageRepository implements MessageRepository {
  constructor(private readonly store: InMemoryStore) {}

  async append(
    chatId: string,
    role: MessageRole,
    content: string,
    turnId?: string,
  ): Promise<Message> {
    this.store.require(this.store.chats, 'Chat', chatId);
    const seq = this.byChat(chatId).reduce((max, message) => Math.max(max, message.seq), 0) + 1;
    const message: Message = {
      id: this.store.newId(),
      chatId,
      turnId: turnId ?? null,
      seq,
      role,
      content,
      createdAt: this.store.now(),
    };
    this.store.messages.set(message.id, message);
    return { ...message };
  }

  async listByChat(chatId: string, options: ListMessagesOptions = {}): Promise<Message[]> {
    let messages = this.byChat(chatId).sort((a, b) => a.seq - b.seq);
    if (options.before !== undefined) {
      const before = options.before;
      messages = messages.filter((message) => message.seq < before);
    }
    if (options.limit !== undefined && messages.length > options.limit) {
      messages = messages.slice(messages.length - options.limit);
    }
    return messages.map((message) => ({ ...message }));
  }

  private byChat(chatId: string): Message[] {
    return [...this.store.messages.values()].filter((message) => message.chatId === chatId);
  }
}

/** Turn rows. */
export class InMemoryTurnRepository implements TurnRepository {
  constructor(private readonly store: InMemoryStore) {}

  async create(input: CreateTurnInput): Promise<Turn> {
    this.store.require(this.store.chats, 'Chat', input.chatId);
    const turn: Turn = {
      id: this.store.newId(),
      chatId: input.chatId,
      workspaceId: null,
      status: 'QUEUED',
      model: input.model,
      queueJobId: input.queueJobId ?? null,
      inputTokens: null,
      outputTokens: null,
      stepCount: 0,
      error: null,
      queuedAt: this.store.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.store.turns.set(turn.id, turn);
    return { ...turn };
  }

  async setStatus(id: string, status: TurnStatus, update: TurnStatusUpdate = {}): Promise<Turn> {
    const turn = this.store.require(this.store.turns, 'Turn', id);
    turn.status = status;
    if (status === 'PREPARING' && turn.startedAt === null) {
      turn.startedAt = this.store.now();
    }
    if (update.workspaceId !== undefined) {
      turn.workspaceId = update.workspaceId;
    }
    if (update.queueJobId !== undefined) {
      turn.queueJobId = update.queueJobId;
    }
    if (update.error !== undefined) {
      turn.error = update.error;
    }
    return { ...turn };
  }

  async get(id: string): Promise<Turn | null> {
    const turn = this.store.turns.get(id);
    return turn === undefined ? null : { ...turn };
  }

  async finish(
    id: string,
    status: TerminalStatus,
    usage: UsageTotals,
    error?: string,
  ): Promise<Turn> {
    const turn = this.store.require(this.store.turns, 'Turn', id);
    Object.assign(turn, {
      status,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      stepCount: usage.stepCount,
      error: error ?? turn.error,
      finishedAt: this.store.now(),
    });
    return { ...turn };
  }

  async listByChat(chatId: string): Promise<Turn[]> {
    return [...this.store.turns.values()]
      .filter((turn) => turn.chatId === chatId)
      .sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime())
      .map((turn) => ({ ...turn }));
  }
}
