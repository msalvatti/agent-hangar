/**
 * Prisma implementation of `WorkspaceRepository`.
 *
 * Layer: service (persistence).
 *
 * "At most one live workspace per chat" is enforced by the database (the hand-written partial
 * unique index `Workspace_one_live_per_chat`), on UPDATEs as well as INSERTs, so `create` and
 * `setStatus` both translate a P2002 on that index into `LiveWorkspaceExistsError` instead of
 * re-checking the invariant in application code. Because that error names the owning *chat*, and
 * `setStatus` only knows the workspace id, the chat is read on the error path and passed to the
 * translator. `setStatus` runs its guarded `readyAt` stamp and the status update in one
 * transaction, so a rejected READY transition never leaves a timestamp behind. `setStatus`
 * intentionally does not touch `lastActiveAt` — only `markActive` does — matching
 * `InMemoryWorkspaceRepository`, which every later lane's tests run against.
 *
 * `claimStatus` writes the same columns as `setStatus` from the same builder, and differs in two
 * ways: it carries the expected status in its `WHERE`, and it refuses a move the lifecycle does not
 * allow — a self-transition above all, which would match on every attempt and so report every
 * caller a winner. That predicate is the arbitration: two callers that
 * read the same row race in Postgres rather than in a process, so a claim held across processes
 * means what a claim held in one process means.
 */
import type { Redactor } from '../../secrets/types.ts';
import { assertWorkspaceTransition } from '../../workspace/lifecycle.ts';
import { LIVE_WORKSPACE_STATUSES } from '../../workspace/types.ts';
import type { WorkspaceStatus } from '../../workspace/types.ts';
import type { Workspace } from '../entities.ts';
import type { Prisma, PrismaClient } from '../generated/client.ts';
import type { CreateWorkspaceInput, WorkspaceRepository, WorkspaceStatusUpdate } from '../ports.ts';

import { toPrismaWorkspaceKind, toPrismaWorkspaceStatus, toWorkspace } from './mappers.ts';
import { translatePrismaError } from './prisma-errors.ts';

/** Columns a status write sets; every field beyond `status` is written only when it applies. */
interface WorkspaceStatusData {
  status: WorkspaceStatus;
  destroyedAt?: Date;
  runnerRef?: string | null;
  failureReason?: string | null;
}

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
      translatePrismaError(error, { entity: 'Workspace', chatId: input.chatId ?? 'none' });
    }
  }

  /** @inheritDoc */
  async findLiveByChat(chatId: string): Promise<Workspace | null> {
    const row = await this.prisma.workspace.findFirst({
      where: { chatId, status: { in: [...LIVE_WORKSPACE_STATUSES] } },
    });
    return row === null ? null : toWorkspace(row);
  }

  /**
   * The columns a status write sets, beyond the status itself.
   *
   * Shared by {@link setStatus} and {@link claimStatus} so the conditional write cannot drift from
   * the unconditional one: the two differ in which rows they match, never in what they write.
   *
   * @param status - Status being written.
   * @param update - Optional columns the caller passed.
   * @returns The Prisma `data` payload.
   */
  private statusData(status: WorkspaceStatus, update: WorkspaceStatusUpdate): WorkspaceStatusData {
    const data: WorkspaceStatusData = { status: toPrismaWorkspaceStatus(status) };
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
    return data;
  }

  /** @inheritDoc */
  async setStatus(
    id: string,
    status: WorkspaceStatus,
    update: WorkspaceStatusUpdate = {},
  ): Promise<Workspace> {
    try {
      const row = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        if (status === 'READY') {
          // Only stamps `readyAt` the first time, same guarded-`updateMany` pattern as Turn.
          await tx.workspace.updateMany({
            where: { id, readyAt: null },
            data: { readyAt: new Date() },
          });
        }
        return tx.workspace.update({ where: { id }, data: this.statusData(status, update) });
      });
      return toWorkspace(row);
    } catch (error) {
      const chatId = await this.chatIdOf(id);
      translatePrismaError(error, {
        entity: 'Workspace',
        id,
        // Stryker disable next-line ConditionalExpression: spread conditionally because the field
        // is optional and this project forbids handing an optional property an explicit
        // `undefined`; a chat that is not there and a chat that is absent read the same further on,
        // where the id is the fallback for both.
        ...(chatId === null ? {} : { chatId }),
      });
    }
  }

  /**
   * @inheritDoc
   *
   * The expected status is part of the `WHERE` of the update itself, so Postgres — not this
   * process — decides which of two concurrent callers wins: the second one's statement re-evaluates
   * the predicate against the row the first one committed, matches nothing and returns no row.
   * Reading the row first and updating by id would put the decision back in the application, which
   * is the race this method exists to remove.
   *
   * A row that does not exist is reported the same way as one that moved: both mean the caller may
   * not act, and neither is worth a second query to tell apart.
   */
  async claimStatus(
    id: string,
    from: WorkspaceStatus,
    to: WorkspaceStatus,
    update: WorkspaceStatusUpdate = {},
  ): Promise<Workspace | null> {
    assertWorkspaceTransition(from, to, id);
    const where = { id, status: toPrismaWorkspaceStatus(from) };
    try {
      const row = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        if (to === 'READY') {
          await tx.workspace.updateMany({
            where: { ...where, readyAt: null },
            data: { readyAt: new Date() },
          });
        }
        const rows = await tx.workspace.updateManyAndReturn({
          where,
          data: this.statusData(to, update),
        });
        return rows[0] ?? null;
      });
      return row === null ? null : toWorkspace(row);
    } catch (error) {
      const chatId = await this.chatIdOf(id);
      translatePrismaError(error, {
        entity: 'Workspace',
        id,
        // Stryker disable next-line ConditionalExpression: spread conditionally because the field
        // is optional and this project forbids handing an optional property an explicit
        // `undefined`; a chat that is not there and a chat that is absent read the same further on,
        // where the id is the fallback for both.
        ...(chatId === null ? {} : { chatId }),
      });
    }
  }

  /**
   * Reads the chat a workspace belongs to, on the error path of a status write only.
   *
   * `LiveWorkspaceExistsError` carries the chat that already owns a live workspace, but the
   * violated partial unique index reports neither; the row itself is the only place the chat can
   * be recovered from, and reading it lazily keeps the successful path at one round trip.
   *
   * The lookup is best-effort on purpose: its only job is to name an error that is already being
   * thrown, so a failure here (a connection lost at the same moment as the write) must not
   * replace the real failure with a second one. It answers `null` instead, and the caller falls
   * back to the workspace id.
   *
   * @param id - Workspace whose owning chat is needed.
   * @returns The chat id, or `null` for a job workspace, a row that no longer exists, or a lookup
   *   that failed.
   */
  private async chatIdOf(id: string): Promise<string | null> {
    // The read runs on a path that is already failing, so its own failure is an answer rather than
    // an exception: a lookup that cannot be made is a chat that cannot be named.
    const row = await this.prisma.workspace
      .findUnique({ where: { id }, select: { chatId: true } })
      .catch(
        // Stryker disable next-line ArrowFunction: a failed lookup and a row that is not there are
        // the same absence to the optional read below, whichever of them this hands back.
        () => null,
      );
    // Stryker disable next-line OptionalChaining: the value above is null exactly when there is no
    // row, so the optional step and a plain read differ only in which error is thrown for a case
    // that cannot arise.
    return row?.chatId ?? null;
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
