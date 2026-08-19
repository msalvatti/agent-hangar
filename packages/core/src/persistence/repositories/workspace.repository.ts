/**
 * Prisma implementation of `WorkspaceRepository`.
 *
 * Layer: service (persistence).
 *
 * "At most one live workspace per chat" is enforced by the database (the hand-written partial
 * unique index `Workspace_one_live_per_chat`), on UPDATEs as well as INSERTs, so `create` and
 * `setStatus` both translate a P2002 on that index into `LiveWorkspaceExistsError` instead of
 * re-checking the invariant in application code. `setStatus` intentionally does not touch
 * `lastActiveAt` — only `markActive` does — matching `InMemoryWorkspaceRepository`, which every
 * later lane's tests run against.
 */
import type { Redactor } from '../../secrets/types.js';
import { LIVE_WORKSPACE_STATUSES } from '../../workspace/types.js';
import type { WorkspaceStatus } from '../../workspace/types.js';
import type { Workspace } from '../entities.js';
import type { PrismaClient } from '../generated/client.js';
import type { CreateWorkspaceInput, WorkspaceRepository, WorkspaceStatusUpdate } from '../ports.js';

import { toPrismaWorkspaceKind, toPrismaWorkspaceStatus, toWorkspace } from './mappers.js';
import { translatePrismaError } from './prisma-errors.js';

/** Workspace rows. */
export class PrismaWorkspaceRepository implements WorkspaceRepository {
  /**
   * @param prisma - Connected Prisma client.
   * @param redactor - Redacts `failureReason` before it is written.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redactor: Redactor,
  ) {}

  /** @inheritDoc */
  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    try {
      const row = await this.prisma.workspace.create({
        data: {
          kind: toPrismaWorkspaceKind(input.kind),
          chatId: input.chatId ?? null,
          runnerKind: input.runnerKind,
          image: input.image,
          repoUrl: input.repoUrl,
          branch: input.branch,
          status: 'CREATING',
        },
      });
      return toWorkspace(row);
    } catch (error) {
      translatePrismaError(error, { entity: 'Workspace', id: input.chatId ?? 'none' });
    }
  }

  /** @inheritDoc */
  async findLiveByChat(chatId: string): Promise<Workspace | null> {
    const row = await this.prisma.workspace.findFirst({
      where: { chatId, status: { in: [...LIVE_WORKSPACE_STATUSES] } },
    });
    return row === null ? null : toWorkspace(row);
  }

  /** @inheritDoc */
  async setStatus(
    id: string,
    status: WorkspaceStatus,
    update: WorkspaceStatusUpdate = {},
  ): Promise<Workspace> {
    try {
      if (status === 'READY') {
        // Only stamps `readyAt` the first time, same guarded-`updateMany` pattern as Turn.
        await this.prisma.workspace.updateMany({
          where: { id, readyAt: null },
          data: { readyAt: new Date() },
        });
      }
      const data: {
        status: WorkspaceStatus;
        destroyedAt?: Date;
        runnerRef?: string | null;
        failureReason?: string | null;
      } = { status: toPrismaWorkspaceStatus(status) };
      if (status === 'DESTROYED') {
        data.destroyedAt = new Date();
      }
      if (update.runnerRef !== undefined) {
        data.runnerRef = update.runnerRef;
      }
      if (update.failureReason !== undefined) {
        data.failureReason =
          update.failureReason === null ? null : this.redactor.redact(update.failureReason);
      }
      const row = await this.prisma.workspace.update({ where: { id }, data });
      return toWorkspace(row);
    } catch (error) {
      translatePrismaError(error, { entity: 'Workspace', id });
    }
  }

  /** @inheritDoc */
  async markActive(id: string): Promise<void> {
    try {
      await this.prisma.workspace.update({ where: { id }, data: { lastActiveAt: new Date() } });
    } catch (error) {
      translatePrismaError(error, { entity: 'Workspace', id });
    }
  }

  /** @inheritDoc */
  async listIdle(before: Date): Promise<Workspace[]> {
    const rows = await this.prisma.workspace.findMany({
      where: { status: 'READY', lastActiveAt: { lt: before } },
      orderBy: { lastActiveAt: 'asc' },
    });
    return rows.map(toWorkspace);
  }

  /** @inheritDoc */
  async listLive(): Promise<Workspace[]> {
    const rows = await this.prisma.workspace.findMany({
      where: { status: { in: [...LIVE_WORKSPACE_STATUSES] } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toWorkspace);
  }

  /** @inheritDoc */
  async get(id: string): Promise<Workspace | null> {
    const row = await this.prisma.workspace.findUnique({ where: { id } });
    return row === null ? null : toWorkspace(row);
  }
}
