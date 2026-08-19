/**
 * In-memory `WorkspaceRepository` enforcing "one live workspace per chat".
 *
 * Layer: test double.
 */
import { LiveWorkspaceExistsError } from '../../errors.js';
import type { Workspace } from '../../persistence/entities.js';
import type {
  CreateWorkspaceInput,
  WorkspaceRepository,
  WorkspaceStatusUpdate,
} from '../../persistence/ports.js';
import { LIVE_WORKSPACE_STATUSES } from '../../workspace/types.js';
import type { WorkspaceStatus } from '../../workspace/types.js';

import type { InMemoryStore } from './store.js';

function isLive(workspace: Workspace): boolean {
  return LIVE_WORKSPACE_STATUSES.includes(workspace.status);
}

/** Workspace rows. */
export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly store: InMemoryStore) {}

  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    if (input.chatId !== undefined && this.liveByChat(input.chatId) !== undefined) {
      throw new LiveWorkspaceExistsError(input.chatId);
    }
    const now = this.store.now();
    const workspace: Workspace = {
      id: this.store.newId(),
      kind: input.kind,
      status: 'CREATING',
      chatId: input.chatId ?? null,
      runnerKind: input.runnerKind,
      runnerRef: null,
      image: input.image,
      repoUrl: input.repoUrl,
      branch: input.branch,
      createdAt: now,
      readyAt: null,
      lastActiveAt: now,
      destroyedAt: null,
      failureReason: null,
    };
    this.store.workspaces.set(workspace.id, workspace);
    return { ...workspace };
  }

  async findLiveByChat(chatId: string): Promise<Workspace | null> {
    const workspace = this.liveByChat(chatId);
    return workspace === undefined ? null : { ...workspace };
  }

  async setStatus(
    id: string,
    status: WorkspaceStatus,
    update: WorkspaceStatusUpdate = {},
  ): Promise<Workspace> {
    const workspace = this.store.require(this.store.workspaces, 'Workspace', id);
    workspace.status = status;
    if (status === 'READY' && workspace.readyAt === null) {
      workspace.readyAt = this.store.now();
    }
    if (status === 'DESTROYED') {
      workspace.destroyedAt = this.store.now();
    }
    if (update.runnerRef !== undefined) {
      workspace.runnerRef = update.runnerRef;
    }
    if (update.failureReason !== undefined) {
      workspace.failureReason = update.failureReason;
    }
    return { ...workspace };
  }

  async markActive(id: string): Promise<void> {
    const workspace = this.store.require(this.store.workspaces, 'Workspace', id);
    workspace.lastActiveAt = this.store.now();
  }

  async listIdle(before: Date): Promise<Workspace[]> {
    return [...this.store.workspaces.values()]
      .filter((workspace) => workspace.status === 'READY' && workspace.lastActiveAt < before)
      .map((workspace) => ({ ...workspace }));
  }

  async listLive(): Promise<Workspace[]> {
    return [...this.store.workspaces.values()]
      .filter(isLive)
      .map((workspace) => ({ ...workspace }));
  }

  async get(id: string): Promise<Workspace | null> {
    const workspace = this.store.workspaces.get(id);
    return workspace === undefined ? null : { ...workspace };
  }

  private liveByChat(chatId: string): Workspace | undefined {
    return [...this.store.workspaces.values()].find(
      (workspace) => workspace.chatId === chatId && isLive(workspace),
    );
  }
}
