/**
 * In-memory `WorkspaceRepository` enforcing "one live workspace per chat".
 *
 * Layer: test double.
 *
 * A conditional write is deterministic here in a way it can never be against a database: there is
 * no concurrency to arrange, so "the row moved" is expressed by moving it. That makes this double
 * — not Postgres — the place to pin what `claimStatus` promises a caller.
 */
import { LiveWorkspaceExistsError } from '../../errors.ts';
import type { Workspace } from '../../persistence/entities.ts';
import type {
  CreateWorkspaceInput,
  WorkspaceRepository,
  WorkspaceStatusUpdate,
} from '../../persistence/ports.ts';
import { LIVE_WORKSPACE_STATUSES } from '../../workspace/types.ts';
import type { WorkspaceStatus } from '../../workspace/types.ts';

import type { InMemoryStore } from './store.ts';

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
    // Postgres enforces the invariant with a partial unique index, which constrains UPDATEs as
    // well as INSERTs: returning a row to a live status while a sibling of the same chat is live
    // violates it. Checking only in `create` would let this fake accept a write the database
    // rejects, and every later lane tests against this fake.
    if (
      workspace.chatId !== null &&
      LIVE_WORKSPACE_STATUSES.includes(status) &&
      this.liveByChat(workspace.chatId, workspace.id) !== undefined
    ) {
      throw new LiveWorkspaceExistsError(workspace.chatId);
    }
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

  async claimStatus(
    id: string,
    from: WorkspaceStatus,
    to: WorkspaceStatus,
    update: WorkspaceStatusUpdate = {},
  ): Promise<Workspace | null> {
    if (this.store.workspaces.get(id)?.status !== from) {
      return null;
    }
    // The winning claim writes exactly what an unconditional write of the same status writes; the
    // whole difference is the guard above. Delegating is what keeps the two indistinguishable to
    // a caller that switched from one to the other.
    return this.setStatus(id, to, update);
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

  /**
   * The live workspace of a chat, if any.
   *
   * @param chatId - Chat to look up.
   * @param exceptId - Row to ignore, so a status update does not collide with itself.
   */
  private liveByChat(chatId: string, exceptId?: string): Workspace | undefined {
    return [...this.store.workspaces.values()].find(
      (workspace) => workspace.chatId === chatId && workspace.id !== exceptId && isLive(workspace),
    );
  }
}
