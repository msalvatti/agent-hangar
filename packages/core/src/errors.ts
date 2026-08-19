/**
 * Typed error classes shared by every process (web, worker, agent runtime).
 *
 * Layer: utility.
 *
 * Every error carries a stable `code` literal so callers can branch without string-matching
 * messages, and so the API layer can map errors to `{ error: { code, message } }` responses.
 */

/** Options accepted by every Agent Hangar error. */
export interface AgentHangarErrorOptions {
  /** Underlying cause, forwarded to the native `Error` `cause` property. */
  cause?: unknown;
}

/**
 * Base class of every domain error.
 *
 * Subclasses narrow `code` to a literal type; never construct this class directly.
 */
export class AgentHangarError extends Error {
  /** Stable machine-readable identifier of the error kind. */
  readonly code: string;

  /**
   * Creates a domain error.
   *
   * @param code - Stable machine-readable identifier.
   * @param message - Human-readable description; never contains secrets.
   * @param options - Optional `cause`.
   */
  constructor(code: string, message: string, options: AgentHangarErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
  }
}

/** The workspace image is not present on the Docker host. */
export class WorkspaceImageMissing extends AgentHangarError {
  override readonly code = 'WORKSPACE_IMAGE_MISSING' as const;
  /** Image reference that was looked up. */
  readonly image: string;

  /**
   * @param image - Image reference (tag or digest) that could not be found.
   * @param options - Optional `cause`.
   */
  constructor(image: string, options?: AgentHangarErrorOptions) {
    super(
      'WORKSPACE_IMAGE_MISSING',
      `Workspace image "${image}" was not found. Build it with: pnpm infra:image`,
      options,
    );
    this.image = image;
  }
}

/** A stored secret failed authentication (tampered ciphertext, wrong key, or bad envelope). */
export class SecretIntegrityError extends AgentHangarError {
  override readonly code = 'SECRET_INTEGRITY' as const;

  /**
   * @param message - Description of the integrity failure; never the secret itself.
   * @param options - Optional `cause`.
   */
  constructor(
    message = 'Stored secret failed integrity verification.',
    options?: AgentHangarErrorOptions,
  ) {
    super('SECRET_INTEGRITY', message, options);
  }
}

/** The host ↔ workspace NDJSON protocol was violated. */
export class ProtocolError extends AgentHangarError {
  override readonly code = 'PROTOCOL_ERROR' as const;

  /**
   * @param message - What was malformed.
   * @param options - Optional `cause`.
   */
  constructor(message: string, options?: AgentHangarErrorOptions) {
    super('PROTOCOL_ERROR', message, options);
  }
}

/** A cron expression or timezone could not be parsed. */
export class InvalidCronError extends AgentHangarError {
  override readonly code = 'INVALID_CRON' as const;
  /** The offending expression. */
  readonly cron: string;

  /**
   * @param cron - The cron expression that failed validation.
   * @param reason - Parser message explaining why.
   * @param options - Optional `cause`.
   */
  constructor(cron: string, reason: string, options?: AgentHangarErrorOptions) {
    super('INVALID_CRON', `Invalid cron expression "${cron}": ${reason}`, options);
    this.cron = cron;
  }
}

/** A lifecycle state machine refused a transition. */
export class IllegalTransitionError extends AgentHangarError {
  override readonly code = 'ILLEGAL_TRANSITION' as const;
  /** Entity type, e.g. `Workspace`, `Turn`. */
  readonly entity: string;
  /** State the entity was in. */
  readonly from: string;
  /** State that was requested. */
  readonly to: string;

  /**
   * @param entity - Entity type name.
   * @param from - Current state.
   * @param to - Requested state.
   * @param options - Optional `cause`.
   */
  constructor(entity: string, from: string, to: string, options?: AgentHangarErrorOptions) {
    super('ILLEGAL_TRANSITION', `${entity} cannot transition from ${from} to ${to}.`, options);
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

/** A chat already has a live workspace (at most one per chat). */
export class LiveWorkspaceExistsError extends AgentHangarError {
  override readonly code = 'LIVE_WORKSPACE_EXISTS' as const;
  /** Chat that already owns a live workspace. */
  readonly chatId: string;

  /**
   * @param chatId - Chat that already owns a live workspace.
   * @param options - Optional `cause`.
   */
  constructor(chatId: string, options?: AgentHangarErrorOptions) {
    super('LIVE_WORKSPACE_EXISTS', `Chat ${chatId} already has a live workspace.`, options);
    this.chatId = chatId;
  }
}

/** A row that a repository method needs does not exist. */
export class NotFoundError extends AgentHangarError {
  override readonly code = 'NOT_FOUND' as const;
  /** Entity type, e.g. `Chat`. */
  readonly entity: string;
  /** Identifier that was looked up. */
  readonly id: string;

  /**
   * @param entity - Entity type name.
   * @param id - Identifier that was looked up.
   * @param options - Optional `cause`.
   */
  constructor(entity: string, id: string, options?: AgentHangarErrorOptions) {
    super('NOT_FOUND', `${entity} ${id} was not found.`, options);
    this.entity = entity;
    this.id = id;
  }
}

/** A write violates a uniqueness invariant (mirrors a Postgres unique-violation). */
export class UniqueViolationError extends AgentHangarError {
  override readonly code = 'UNIQUE_VIOLATION' as const;
  /** Entity type, e.g. `JobRun`. */
  readonly entity: string;
  /** Field (or index name) that must be unique. */
  readonly field: string;

  /**
   * @param entity - Entity type name.
   * @param field - Field or index that must be unique.
   * @param options - Optional `cause`.
   */
  constructor(entity: string, field: string, options?: AgentHangarErrorOptions) {
    super('UNIQUE_VIOLATION', `${entity}.${field} must be unique.`, options);
    this.entity = entity;
    this.field = field;
  }
}

/** Environment or instance configuration is invalid or a required resource is unreachable. */
export class ConfigError extends AgentHangarError {
  override readonly code = 'CONFIG_ERROR' as const;

  /**
   * @param message - Readable list of configuration problems.
   * @param options - Optional `cause`.
   */
  constructor(message: string, options?: AgentHangarErrorOptions) {
    super('CONFIG_ERROR', message, options);
  }
}

/**
 * Narrows an unknown value to an {@link AgentHangarError}.
 *
 * @param value - Anything caught in a `catch` block.
 * @returns `true` when the value is a domain error.
 */
export function isAgentHangarError(value: unknown): value is AgentHangarError {
  return value instanceof AgentHangarError;
}

/**
 * The shape a driver-generated failure classification has: a bare identifier, nothing else.
 *
 * Every classification worth reporting already fits — Node system codes (`ECONNREFUSED`), SQLSTATE
 * codes (`28P01`), Prisma codes (`P1001`) and error class names are all identifiers. A connection
 * string is not, and cannot be made into one: it cannot be spelled without `:`, `/` and `@`. So
 * rather than trusting the caller to hand over a driver-generated value, {@link
 * describeClientFailure} refuses anything that does not have this shape. The bound is written into
 * the literal because building the pattern from a named constant would need `new RegExp`, which
 * `eslint-plugin-security` rejects; 64 is far above the longest code or class name either driver
 * emits.
 */
const DRIVER_CLASSIFICATION = /^\w{1,64}$/u;

/**
 * Reads the classification a rejected value offers, or `undefined` when it offers none.
 *
 * Introspection is guarded because the value is `unknown`: a `code` getter or a `Proxy` trap may
 * throw, and whatever it throws could itself be the driver error this function exists to keep out
 * of the report. Swallowing it and falling back is the safe direction.
 *
 * @param error - The value a client rejected with.
 * @returns The driver code, else the error's class name, else `undefined`.
 */
function readClassification(error: unknown): string | undefined {
  try {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const { code } = error;
      if (typeof code === 'string' && code.length > 0) {
        return code;
      }
    }
    if (error instanceof Error && error.constructor.name !== 'Error') {
      return error.constructor.name;
    }
  } catch {
    // Deliberately swallowed rather than rethrown: what a hostile getter or trap throws can
    // itself carry the connection string, so letting it out would defeat the whole function.
    // Falling through to `undefined` — reported as `unknown` — is the handling.
  }
  return undefined;
}

/**
 * Describes why an infrastructure client failed, using nothing the client was configured with.
 *
 * A driver error is not safe to repeat. Postgres and Redis clients put the connection string —
 * password included — into the message of a connection failure, and attaching the error as `cause`
 * republishes it to anything that walks the chain, which `util.inspect`, a structured logger and a
 * test reporter all do. Only a driver-generated classification is returned: the `code` a driver
 * sets (`ECONNREFUSED`, `28P01`, …) or, failing that, the error's constructor name.
 *
 * The guarantee does not rest on the caller passing a real driver error. The classification must
 * also look like one — see {@link DRIVER_CLASSIFICATION} — so a rejection carrying, say,
 * `code: 'redis://u:pw@host'` is reported as `unknown` rather than repeated.
 *
 * @param error - The value a client rejected with.
 * @returns A short classification safe to put in a message and to persist.
 */
export function describeClientFailure(error: unknown): string {
  const classification = readClassification(error);
  if (classification !== undefined && DRIVER_CLASSIFICATION.test(classification)) {
    return classification;
  }
  return 'unknown';
}
