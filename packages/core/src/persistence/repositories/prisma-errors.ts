/**
 * Translates a raw Prisma error into the typed persistence errors of `errors.ts`.
 *
 * Layer: service (persistence).
 *
 * The error is detected by duck-typing (`code` and `meta` shape) rather than `instanceof` the
 * generated `PrismaClientKnownRequestError` class, so unit tests can exercise every branch with a
 * plain object and no Prisma runtime import is needed here at all.
 */
import { LiveWorkspaceExistsError, NotFoundError, UniqueViolationError } from './errors.js';

/** Name of the hand-written partial unique index (see `prisma/migrations/0001_init`). */
const LIVE_WORKSPACE_INDEX = 'Workspace_one_live_per_chat';

/** Context a caller supplies so the translated error names the right entity and id. */
export interface PrismaErrorContext {
  /** Domain entity name, e.g. `'Chat'`. */
  entity: string;
  /** Identifier of the row involved, when known. */
  id?: string;
  /**
   * Chat the row belongs to. A `LiveWorkspaceExistsError` carries the owning chat, not the
   * workspace, so a write that knows only the workspace id supplies the chat separately.
   */
  chatId?: string;
  /**
   * Row a foreign key of this write points at. A P2003 means that parent does not exist, so the
   * translated `NotFoundError` names the parent rather than the row being written.
   */
  parent?: { entity: string; id: string };
}

/**
 * Shape this module relies on; duck-typed rather than imported from the generated client.
 *
 * Two distinct `meta` shapes are handled, because they come from two different Prisma error
 * paths observed against Postgres 18 / Prisma 7.9 with `@prisma/adapter-pg`:
 *   - The classic engine shape: `meta.target` (a field-name array or string).
 *   - The driver-adapter shape (what a raw-SQL index, such as the hand-written partial unique
 *     index, actually produces): `meta.driverAdapterError.cause.originalMessage` — the real
 *     Postgres error text, which names the constraint — and `meta.driverAdapterError.cause
 *     .constraint.fields` (quoted field names, e.g. `'"chatId"'`).
 */
interface KnownRequestErrorShape {
  code: string;
  message: string;
  meta?:
    | {
        target?: readonly string[] | string;
        driverAdapterError?: {
          cause?: {
            originalMessage?: string;
            constraint?: { fields?: readonly string[] };
          };
        };
      }
    | undefined;
}

/**
 * Narrows `error` to the shape of a `PrismaClientKnownRequestError`.
 *
 * @param error - Anything caught in a `catch` block.
 */
function isKnownRequestError(error: unknown): error is KnownRequestErrorShape {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as Record<string, unknown>;
  return typeof candidate.code === 'string' && typeof candidate.message === 'string';
}

/**
 * Joins the field names of a P2002 into one comma-separated string, trying the classic
 * `meta.target` shape first and falling back to the driver-adapter constraint's field list
 * (stripping the embedded double quotes Postgres includes around identifiers).
 *
 * @param meta - The raw `meta` of a P2002 error.
 */
function targetText(meta: KnownRequestErrorShape['meta']): string {
  const target = meta?.target;
  if (target !== undefined) {
    return typeof target === 'string' ? target : target.join(',');
  }
  const fields = meta?.driverAdapterError?.cause?.constraint?.fields;
  if (fields !== undefined) {
    return fields.map((field) => field.replaceAll('"', '')).join(',');
  }
  return '';
}

/**
 * Every place the violated constraint's identity might be named, joined into one string to
 * search: the target field list, the driver adapter's original Postgres message (which names a
 * raw-SQL index Postgres itself enforced), and the top-level Prisma message as a last resort.
 *
 * @param error - The known-request error.
 */
function constraintMentionText(error: KnownRequestErrorShape): string {
  const originalMessage = error.meta?.driverAdapterError?.cause?.originalMessage ?? '';
  return `${targetText(error.meta)} ${originalMessage} ${error.message}`;
}

/**
 * Translates a P2002 (unique constraint violation) into the specific typed error it represents.
 *
 * The partial unique index enforcing "one live workspace per chat" is hand-written SQL, so its
 * name only ever surfaces in the driver adapter's original Postgres message or the top-level
 * Prisma message — never in `meta.target` — hence searching every location.
 *
 * @param error - The known-request error.
 * @param ctx - Entity/id context for the translated error.
 */
function translateUniqueViolation(error: KnownRequestErrorShape, ctx: PrismaErrorContext): never {
  if (constraintMentionText(error).includes(LIVE_WORKSPACE_INDEX)) {
    throw new LiveWorkspaceExistsError(ctx.chatId ?? ctx.id ?? 'unknown');
  }
  const target = targetText(error.meta);
  throw new UniqueViolationError(ctx.entity, target.length > 0 ? target : 'unknown');
}

/**
 * Translates a raw Prisma error caught around a repository write into a typed persistence error.
 *
 * @param error - Whatever the `catch` block received.
 * @param ctx - Entity/id context used to build the translated error's message.
 * @throws LiveWorkspaceExistsError for the partial-unique-index violation.
 * @throws UniqueViolationError for any other P2002.
 * @throws NotFoundError for P2003 (foreign key violation: the parent row does not exist) and for
 *   P2025 (record required by the operation was not found).
 * @throws The original `error`, unchanged, for anything else (including non-Prisma errors).
 */
export function translatePrismaError(error: unknown, ctx: PrismaErrorContext): never {
  // Kept untyped-narrowed so the final rethrow below still carries the original `unknown` type
  // rather than the local `KnownRequestErrorShape`, which is a plain duck-typed interface, not an
  // `Error` subtype, even though the real value always is one at runtime.
  const original: unknown = error;
  if (!isKnownRequestError(error)) {
    throw original;
  }
  if (error.code === 'P2002') {
    translateUniqueViolation(error, ctx);
  }
  if (error.code === 'P2003') {
    const parent = ctx.parent;
    throw parent === undefined
      ? new NotFoundError(ctx.entity, ctx.id ?? 'unknown')
      : new NotFoundError(parent.entity, parent.id);
  }
  if (error.code === 'P2025') {
    throw new NotFoundError(ctx.entity, ctx.id ?? 'unknown');
  }
  throw original;
}
