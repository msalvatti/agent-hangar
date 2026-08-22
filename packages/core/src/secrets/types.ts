/**
 * Secrets and redaction contracts.
 *
 * Layer: service (port).
 *
 * Plaintext secrets exist only in the `PUT /api/settings/:key` request body, in worker memory
 * while one turn is started, and in the file the runner places for that turn — which the runtime
 * reads and unlinks before the agent runs anything. Never in the container's environment, which
 * every process of a workspace can read back for as long as the container lives. Everything else
 * sees ciphertext, `last4`, or `[REDACTED]`.
 */

/** Credentials the app stores. */
export type SecretKey = 'GITHUB_PAT' | 'OPENAI_API_KEY';

/** Every {@link SecretKey}, in display order. */
export const SECRET_KEYS: readonly SecretKey[] = ['GITHUB_PAT', 'OPENAI_API_KEY'];

/** Replacement token written in place of a secret. */
export const REDACTED_TOKEN = '[REDACTED]';

/**
 * Shape patterns that are always redacted, even without a registered value.
 *
 * The regexes carry no flags; consumers that need global matching must construct their own copy
 * (`new RegExp(pattern.source, 'g')`) because a shared `g` regex is stateful.
 */
export const SECRET_SHAPE_PATTERNS: readonly RegExp[] = [
  /ghp_[A-Za-z0-9]{36}/,
  /github_pat_[A-Za-z0-9_]{22,}/,
  /sk-proj-[A-Za-z0-9_-]{20,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /Authorization:\s*Bearer\s+\S+/i,
];

/** Encrypted envelope stored in the `Secret` table. Never contains plaintext. */
export interface SecretEnvelope {
  /** AES-256-GCM ciphertext. */
  ciphertext: Uint8Array;
  /** 12 random bytes, unique per write. */
  iv: Uint8Array;
  /** 16-byte GCM authentication tag. */
  authTag: Uint8Array;
  /** Master key version used for this envelope (rotation hook). */
  keyVersion: number;
  /** Last four characters of the plaintext, for UI masking only. */
  last4: string;
}

/** Status of one stored secret as exposed outside the worker. */
export interface SecretStatus {
  set: boolean;
  last4?: string;
  updatedAt?: Date;
}

/** Encrypts, stores and (worker-only) reveals credentials. */
export interface SecretsService {
  /** Encrypts and stores a value, replacing any previous one. */
  set(key: SecretKey, plaintext: string): Promise<{ last4: string }>;
  /** Removes the stored value. */
  remove(key: SecretKey): Promise<void>;
  /** Masked status of every key. */
  status(): Promise<Record<SecretKey, SecretStatus>>;
  /** Worker-only: decrypt for injection. Never called from the web app. */
  reveal(key: SecretKey): Promise<string | null>;
}

/** Removes secrets from text and JSON before anything is logged, persisted or published. */
export interface Redactor {
  /** Registers live secret values (called by the worker after `reveal`) so exact matches are redacted too. */
  register(values: readonly string[]): void;
  /** Replaces registered values and shape-pattern matches with {@link REDACTED_TOKEN}. Idempotent. */
  redact(input: string): string;
  /** Applies {@link Redactor.redact} to every string inside an arbitrary JSON value. */
  redactJson(input: unknown): unknown;
}
