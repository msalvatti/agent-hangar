/**
 * Unit tests for `translatePrismaError`.
 *
 * Layer: unit.
 * Goal: every raw Prisma failure shape is translated to the right typed error, purely by
 * duck-typing — no Prisma runtime import, no database.
 * Mocks: none (plain objects stand in for `PrismaClientKnownRequestError`).
 */
import { describe, expect, it } from 'vitest';

import { LiveWorkspaceExistsError, NotFoundError, UniqueViolationError } from './errors.js';
import { translatePrismaError } from './prisma-errors.js';

describe('translatePrismaError', () => {
  /** The partial-unique-index violation is recognised via `meta.target` naming the index. */
  it('translates P2002 on the live-workspace index (meta.target) to LiveWorkspaceExistsError', () => {
    const error = {
      code: 'P2002',
      message: 'Unique constraint failed',
      meta: { target: 'Workspace_one_live_per_chat' },
    };
    expect(() => translatePrismaError(error, { entity: 'Workspace', id: 'chat-1' })).toThrow(
      LiveWorkspaceExistsError,
    );
  });

  /**
   * The index is hand-written raw SQL, so Prisma may instead only name it in the message with no
   * `meta.target` at all — both shapes must be recognised.
   */
  it('translates P2002 naming the live-workspace index only in the message', () => {
    const error = {
      code: 'P2002',
      message: 'Unique constraint failed on the constraint: `Workspace_one_live_per_chat`',
    };
    let caught: unknown;
    try {
      translatePrismaError(error, { entity: 'Workspace', id: 'chat-1' });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(LiveWorkspaceExistsError);
    expect((caught as LiveWorkspaceExistsError).chatId).toBe('chat-1');
  });

  /**
   * The exact shape `@prisma/adapter-pg` (Prisma 7.9 against Postgres 18) reports for the
   * hand-written partial index: `meta.target` is absent; the index name only appears inside
   * `meta.driverAdapterError.cause.originalMessage`, the real Postgres error text. Captured once
   * against the compose database and pinned here so the translator is proven against reality, not
   * a guess.
   */
  it('translates the real driver-adapter shape of the live-workspace violation', () => {
    const error = {
      code: 'P2002',
      message:
        'Invalid `client.workspace.create()` invocation\nUnique constraint failed on the fields: (`"chatId"`)',
      meta: {
        modelName: 'Workspace',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '23505',
            originalMessage:
              'duplicate key value violates unique constraint "Workspace_one_live_per_chat"',
            kind: 'UniqueConstraintViolation',
            constraint: { fields: ['"chatId"'] },
          },
        },
      },
    };
    let caught: unknown;
    try {
      translatePrismaError(error, { entity: 'Workspace', id: 'chat-1' });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(LiveWorkspaceExistsError);
    expect((caught as LiveWorkspaceExistsError).chatId).toBe('chat-1');
  });

  /**
   * The same driver-adapter shape for an unrelated constraint (a plain `@unique` field, not a
   * hand-written index) becomes a generic UniqueViolationError, with the field name recovered
   * from `constraint.fields` (embedded quotes stripped) since `meta.target` is never present in
   * this shape.
   */
  it('translates the driver-adapter shape of an unrelated constraint to UniqueViolationError', () => {
    const error = {
      code: 'P2002',
      message: 'Unique constraint failed on the fields: (`"workspaceId"`)',
      meta: {
        modelName: 'JobRun',
        driverAdapterError: {
          cause: {
            originalMessage:
              'duplicate key value violates unique constraint "JobRun_workspaceId_key"',
            constraint: { fields: ['"workspaceId"'] },
          },
        },
      },
    };
    let caught: unknown;
    try {
      translatePrismaError(error, { entity: 'JobRun', id: 'run-1' });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(UniqueViolationError);
    expect((caught as UniqueViolationError).field).toBe('workspaceId');
  });

  /** When the caller has no id to report, the live-workspace error still falls back to 'unknown'. */
  it('defaults chatId to "unknown" when ctx.id is absent', () => {
    const error = {
      code: 'P2002',
      message: 'Unique constraint failed',
      meta: { target: 'Workspace_one_live_per_chat' },
    };
    let caught: unknown;
    try {
      translatePrismaError(error, { entity: 'Workspace' });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(LiveWorkspaceExistsError);
    expect((caught as LiveWorkspaceExistsError).chatId).toBe('unknown');
  });

  /** A P2002 naming an unrelated index becomes a generic UniqueViolationError. */
  it('translates a P2002 with an array meta.target to UniqueViolationError', () => {
    const error = {
      code: 'P2002',
      message: 'Unique constraint failed',
      meta: { target: ['workspaceId'] },
    };
    let caught: unknown;
    try {
      translatePrismaError(error, { entity: 'JobRun', id: 'run-1' });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(UniqueViolationError);
    expect((caught as UniqueViolationError).entity).toBe('JobRun');
    expect((caught as UniqueViolationError).field).toBe('workspaceId');
  });

  /** Without any target information the field falls back to `'unknown'` rather than throwing. */
  it('translates a P2002 with no meta and a generic message to UniqueViolationError("unknown")', () => {
    const error = { code: 'P2002', message: 'Unique constraint failed' };
    let caught: unknown;
    try {
      translatePrismaError(error, { entity: 'Secret' });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(UniqueViolationError);
    expect((caught as UniqueViolationError).field).toBe('unknown');
  });

  /** The live-workspace error carries the chat when the caller knows only the workspace id. */
  it('translates P2002 on the live-workspace index with ctx.chatId to that chat', () => {
    const error = {
      code: 'P2002',
      message: 'Unique constraint failed on Workspace_one_live_per_chat',
    };
    let caught: unknown;
    try {
      translatePrismaError(error, { entity: 'Workspace', id: 'ws-1', chatId: 'chat-1' });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(LiveWorkspaceExistsError);
    expect((caught as LiveWorkspaceExistsError).chatId).toBe('chat-1');
  });

  /** P2025 (record required by the write was not found) becomes NotFoundError. */
  it('translates P2025 to NotFoundError, defaulting the id to "unknown" when absent', () => {
    const error = { code: 'P2025', message: 'Record not found' };
    let caught: unknown;
    try {
      translatePrismaError(error, { entity: 'Chat' });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect((caught as NotFoundError).entity).toBe('Chat');
    expect((caught as NotFoundError).id).toBe('unknown');
  });

  /** P2003 with a declared parent names that parent, not the row being written. */
  it('translates P2003 to NotFoundError naming the parent the foreign key points at', () => {
    const error = { code: 'P2003', message: 'Foreign key constraint failed' };
    let caught: unknown;
    try {
      translatePrismaError(error, {
        entity: 'JobRun',
        parent: { entity: 'ScheduledJob', id: 'job-1' },
      });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect((caught as NotFoundError).entity).toBe('ScheduledJob');
    expect((caught as NotFoundError).id).toBe('job-1');
  });

  /** Without a declared parent, P2003 falls back to the entity/id of the write. */
  it('translates P2003 without a parent to NotFoundError naming the entity, id defaulting', () => {
    const error = { code: 'P2003', message: 'Foreign key constraint failed' };
    let caught: unknown;
    try {
      translatePrismaError(error, { entity: 'Turn' });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect((caught as NotFoundError).entity).toBe('Turn');
    expect((caught as NotFoundError).id).toBe('unknown');
  });

  /** Any other Prisma error code is rethrown unchanged (same reference). */
  it('rethrows an unknown Prisma error code unchanged', () => {
    const error = { code: 'P2034', message: 'Transaction write conflict' };
    expect(() => translatePrismaError(error, { entity: 'Chat', id: 'c1' })).toThrow(error.message);
    try {
      translatePrismaError(error, { entity: 'Chat', id: 'c1' });
    } catch (thrown) {
      expect(thrown).toBe(error);
    }
  });

  /** A non-Prisma error (or any non-object) is rethrown unchanged, never wrapped. */
  it.each([
    ['a plain Error', new Error('boom')],
    ['a string', 'boom'],
    ['null', null],
    ['an object missing code', { message: 'no code here' }],
  ])('rethrows %s unchanged', (_label, value) => {
    try {
      translatePrismaError(value, { entity: 'Chat', id: 'c1' });
      throw new Error('expected translatePrismaError to throw');
    } catch (thrown) {
      expect(thrown).toBe(value);
    }
  });
});
