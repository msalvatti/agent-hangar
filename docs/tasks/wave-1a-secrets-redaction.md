# Wave 1 — Lane W1-A: Secrets, redaction, logging (core)

| | |
|---|---|
| **Lane** | W1-A (Wave 1, parallel with W1-B … W1-I) |
| **Status** | 🟦 running |
| **Progress** | 2/5 tasks |
| **Branch** | `feat/w1a-secrets-redaction` |
| **Owned paths** | `packages/core/src/secrets/**` (except the frozen `types.ts`), `packages/core/src/redaction/**`, `packages/core/src/logging/**` — plus two append-only exceptions: `packages/core/vitest.config.ts` (`coverage.include` only) (the root `packages/core/src/index.ts` is frozen — it already re-exports `./secrets/index.js`, `./redaction/index.js`, `./logging/index.js`; this lane adds exports only to those folder barrels) |
| **Depends on** | W0 merged to `main` |
| **Unblocks** | W2-A (settings routes, status-only secrets), W2-B (worker reveal + inject + redact) |
| **Source** | [docs/plan.md §6 W1-A](../plan.md) · spec [03 §6](../spec/03-interfaces.md) · [04 (d)](../spec/04-flows.md) · [06 §2](../spec/06-testing.md) |
| **Last updated** | 2026-08-19 |

## Context

W0 froze `SecretKey`, `SecretsService`, `Redactor` and `SECRET_SHAPE_PATTERNS` in `packages/core/src/secrets/types.ts`, the `SecretRepository` port (with its envelope type) in `packages/core/src/persistence/ports.ts`, the error classes (`SecretIntegrityError`, `ConfigError`, `AgentHangarError`) in `packages/core/src/errors.ts`, the config schema (`MASTER_KEY_PATH`) in `packages/core/src/config/schema.ts`, and the test doubles (`InMemorySecretRepository`, canaries, `assertNoCanary`) in `packages/core/src/testing/**`. This lane implements the behaviour behind those contracts: the AES-256-GCM `SecretsService`, the master-key file handling, the `Redactor` (exact registered values + shape patterns), and the pino logger factory that guarantees secrets never reach logs. W2-A consumes `status()`; W2-B consumes `reveal()`, `register()` and the logger.

Plaintext secrets exist only in memory inside `set()`/`reveal()` and in the worker's `create()` call. Nothing in this lane ever logs, stores, or returns a plaintext beyond `reveal()`.

## Rules of this lane

1. Edit only the owned paths. `packages/core/src/secrets/types.ts`, `errors.ts`, `persistence/ports.ts`, `testing/**` are frozen W0 contracts — if a change is needed, stop, record it as a `contractChangeRequests[]` entry in the PR summary, and continue with a local wrapper type.
2. No new dependencies. `node:crypto`, `node:fs/promises`, `node:path`, `pino` (already installed) are everything this lane needs. If something is missing, stop and report.
3. Extend `packages/core/vitest.config.ts` `coverage.include` with `src/secrets/**`, `src/redaction/**`, `src/logging/**`. Thresholds stay 100/100/100/100.
4. No `enum`, no suppression comments (`eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`), JSDoc on every export + a file header comment, test files with a header and a block comment on every `it()`, English only.
5. Tests use the canaries from `@agent-hangar/core/testing` (`GITHUB_CANARY`, `OPENAI_CANARY`, `assertNoCanary`) — never real-looking secret values. Test names must not embed canary values (a green `vitest` run must print zero canary occurrences).
6. Never log a plaintext secret, never include plaintext in an error message, never `console.log` in src.
7. Conventional Commits, English, no AI-attribution trailers. Branch `feat/w1a-secrets-redaction`, one PR at the end (Task 1A.5).

## Reference docs

- [docs/plan.md](../plan.md) § "3. Parallelism rules", § "6. Wave 1" (W1-A), § "11. Orchestrator protocol", § "12. Status dashboard"
- [spec 03 — Interface contracts](../spec/03-interfaces.md) § "6. Secrets service"
- [spec 04 — Flows](../spec/04-flows.md) § "(d) Secrets: save → encrypt → inject → redact" (incl. the controls table)
- [spec 02 — Data model](../spec/02-data-model.md) § "2" (`Secret` model) and § "3. Invariants" item 4
- [spec 06 — Testing](../spec/06-testing.md) § "2. Unit tests" (secrets/, redaction/)
- Contract files: `packages/core/src/secrets/types.ts`, `packages/core/src/persistence/ports.ts`, `packages/core/src/errors.ts`, `packages/core/src/config/schema.ts`, `packages/core/src/testing/{canaries,in-memory-repositories,index}.ts`

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 1A.1 | Master key provider: `MasterKeyFile` (0600 create/verify) + `StaticMasterKey` | ✅ | P0 | S | — |
| 1A.2 | AES-256-GCM envelope crypto + `SecretsService` over `SecretRepository` | ✅ | P0 | M | 1A.1 |
| 1A.3 | `Redactor`: exact registered values + shape patterns, `redactJson`, idempotent | 📋 | P0 | M | — |
| 1A.4 | pino logger factory with redact paths + `Redactor` serializer/hook | 📋 | P0 | S | 1A.3 |
| 1A.5 | Close-out: gates, code review, dashboard, PR | 📋 | P0 | S | 1A.1–1A.4 |

---

## Task 1A.1 — Master key provider: `MasterKeyFile` + `StaticMasterKey`

**Status:** ✅ Done · **Priority:** P0 · **Size:** S · **Depends on:** —

**Description.** Implement the master-key source used by the secrets service: a file-backed provider (`~/.agent-hangar/master.key` by default, path from config) that creates the key with mode 0600 when missing, refuses group/world-readable files, validates the content (32 bytes as 64 hex chars), and exposes a `keyVersion`; plus an in-memory provider for tests.

**Acceptance criteria**
- [x] `MasterKeyProvider` interface and `MasterKey { key: Buffer (32 bytes); version: number }` exported from `packages/core/src/secrets/master-key.ts`
- [x] `MasterKeyFile.load()` creates the parent dir (0700) and the file (0600, `randomBytes(32).toString('hex') + '\n'`) when missing; loads and caches when present
- [x] Refuses with `ConfigError` (message contains `chmod 600 <path>`) when the file mode has any group/world bits (`mode & 0o077 !== 0`)
- [x] Refuses with `ConfigError` when content is not exactly 64 hex chars (trailing newline allowed)
- [x] `StaticMasterKey` returns a caller-supplied 32-byte key and version (used by tests and by `FakeKeyFile`-style usage in other lanes)
- [x] 100 % coverage on `src/secrets/master-key.ts` and `src/secrets/master-key-file.ts`

**Files to create**
`packages/core/src/secrets/master-key.ts`, `packages/core/src/secrets/master-key-file.ts`, `packages/core/src/secrets/master-key-file.test.ts`, `packages/core/src/secrets/master-key.test.ts`; modify `packages/core/vitest.config.ts` (`coverage.include` += `src/secrets/**`).

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core is framework-free (zod, pino available; node:crypto / node:fs for this lane). Vitest 4 with @vitest/coverage-v8.
Branch feat/w1a-secrets-redaction (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-A (Secrets, redaction, logging) — Task 1A.1 of 5 (FIRST)

PRECONDITIONS
- W0 merged to main; branch off latest main; contracts exist at packages/core/src/secrets/types.ts, persistence/ports.ts, errors.ts (ConfigError, SecretIntegrityError, AgentHangarError), config/schema.ts (MASTER_KEY_PATH), testing/* (canaries, in-memory repositories).
- `pnpm install --frozen-lockfile && pnpm typecheck` green on main before you start.

REQUIRED READING (only these):
- CLAUDE.md (root) — ownership map and gates
- packages/core/src/secrets/types.ts, packages/core/src/errors.ts, packages/core/src/config/schema.ts (MASTER_KEY_PATH default and shape)
- docs/spec/04-flows.md § "(d) Secrets" — the "Key" and "Repo" rows of the controls table
- docs/spec/06-testing.md § "2. Unit tests" → `secrets/` bullet (master key file cases)

TASK
Implement the master-key provider abstraction and its file-backed implementation so the secrets service (Task 1A.2) never touches the filesystem itself, and so tests can inject a static key.

DELIVERABLES

1. `packages/core/src/secrets/master-key.ts`
   ```ts
   /** 32-byte AES-256 key plus the version recorded on every envelope written with it. */
   export interface MasterKey { readonly key: Buffer; readonly version: number }
   export interface MasterKeyProvider { load(): Promise<MasterKey> }
   export const MASTER_KEY_BYTES = 32;
   export const MASTER_KEY_VERSION = 1;   // bump on rotation (rotation itself is out of scope)
   export class StaticMasterKey implements MasterKeyProvider { constructor(key: Buffer, version = MASTER_KEY_VERSION) … }
   ```
   `StaticMasterKey` throws `ConfigError` in the constructor when `key.length !== MASTER_KEY_BYTES`.
2. `packages/core/src/secrets/master-key-file.ts` — `export class MasterKeyFile implements MasterKeyProvider` with `constructor(options: { path: string; version?: number })`:
   - `load()`: if a previous load succeeded, return the cached `MasterKey`. Else: `mkdir(dirname(path), { recursive: true, mode: 0o700 })`; try `readFile(path, 'utf8')`; on `ENOENT` create with `writeFile(path, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' })` then re-read; on `EEXIST` from a concurrent creator just re-read. Then `stat(path)`: if `(mode & 0o077) !== 0` throw `ConfigError` with message `master key file <path> is readable by group/others; run: chmod 600 <path>`. Validate content: trimmed value must match `/^[0-9a-f]{64}$/i`, else throw `ConfigError` ("master key file <path> must contain 32 bytes as 64 hex characters"). Return `{ key: Buffer.from(hex, 'hex'), version }`.
   - Never log. Never include file content in any error message.
   - Export a small helper `isWorldOrGroupReadable(mode: number): boolean` (pure, tested separately).
3. Tests (`master-key.test.ts`, `master-key-file.test.ts`) using `fs.mkdtemp(join(os.tmpdir(), 'ah-key-'))` and cleanup in `afterEach`:
   - StaticMasterKey returns the key/version; rejects wrong length.
   - File missing → created with mode 0600 (assert `(stat.mode & 0o777) === 0o600`), parent dir created, content matches 64 hex + newline, second `load()` returns the same key without re-reading (spy on fs or change the file and assert cached value).
   - File present and valid → loaded, version passed through (custom version 2 preserved).
   - File with mode 0644 → `ConfigError`, message contains `chmod 600`.
   - File with mode 0640 → `ConfigError` (group bit alone is refused).
   - Malformed content (63 hex chars; non-hex; empty) → `ConfigError`.
   - `EEXIST` race: pre-create the file between the `readFile` ENOENT and the `writeFile` by mocking `node:fs/promises` `writeFile` once to throw `{ code: 'EEXIST' }` and assert the subsequent read succeeds.
   - Uppercase hex is accepted and decodes to the same bytes.
4. `packages/core/vitest.config.ts`: add `'src/secrets/**'` to `coverage.include` (the existing `exclude` of `src/**/types.ts` keeps the frozen types file out).
5. `packages/core/src/secrets/index.ts` barrel exporting everything public in this folder (types re-export + the two files); the root `packages/core/src/index.ts` already re-exports `./secrets/index.js` (frozen in W0) — do not edit it.

Constraints:
- Follow /bymax-workflow:standards: TS strict, JSDoc + file headers, English, no enum, no suppression comments, test headers and a block comment on every it().
- Only `node:fs/promises`, `node:path`, `node:crypto`, `node:os` (tests). If an eslint-plugin-security rule fires at error level on legitimate fs usage with a non-literal path, do NOT add a suppression comment — report it in the PR under "tooling" and keep the code.
- No new dependencies.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green; 100 % on `src/secrets/master-key.ts` and `src/secrets/master-key-file.ts`
- `pnpm typecheck && pnpm lint` — exit 0
- `pnpm --filter @agent-hangar/core test 2>&1 | grep -c TESTCANARY` — prints 0

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-1a-secrets-redaction.md (task block and task index row)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/5 tasks`)
4. Append a completion log entry at the end of the file: `- 1A.1 ✅ <YYYY-MM-DD> — <one-line summary>`
5. Commit: `feat(core): add master key file provider with 0600 enforcement`
````

---

## Task 1A.2 — AES-256-GCM envelope crypto + `SecretsService`

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 1A.1

**Description.** Implement the pure encrypt/decrypt functions (AES-256-GCM, 12-byte random iv, 16-byte auth tag, `keyVersion`) and the `SecretsService` from spec 03 §6 over the `SecretRepository` port: `set` → encrypt + upsert + return `last4`; `remove`; `status()` for both keys; `reveal` (worker-only, documented) → decrypt with auth-tag verification.

**Acceptance criteria**
- [x] `encryptSecret(plaintext, masterKey)` returns `{ ciphertext, iv (12 bytes), authTag (16 bytes), keyVersion }`; two calls with the same input produce different `iv` and `ciphertext`
- [x] `decryptSecret(envelope, masterKey)` round-trips; tampered ciphertext, tampered authTag, wrong key, wrong iv length, and `keyVersion !== masterKey.version` all throw `SecretIntegrityError` (never the raw `node:crypto` error)
- [x] `createSecretsService({ repository, masterKey })` implements `SecretsService` exactly as declared in `secrets/types.ts`; `set` rejects empty plaintext with `InvalidSecretError` (local `AgentHangarError` subclass, code `SECRET_INVALID`); `last4` = last `min(4, length)` characters
- [x] `reveal` returns `null` when no row exists; `status()` always returns an entry for every `SecretKey` (`{ set: false }` or `{ set: true, last4, updatedAt }`)
- [x] The repository never sees plaintext (test serialises the in-memory repository state and runs `assertNoCanary`)
- [x] 100 % coverage on `src/secrets/crypto.ts`, `src/secrets/secrets-service.ts`, `src/secrets/errors.ts`

**Files to create**
`packages/core/src/secrets/crypto.ts`, `packages/core/src/secrets/crypto.test.ts`, `packages/core/src/secrets/errors.ts`, `packages/core/src/secrets/secrets-service.ts`, `packages/core/src/secrets/secrets-service.test.ts`; update `packages/core/src/secrets/index.ts`.

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core is framework-free. Vitest 4 with @vitest/coverage-v8.
Branch feat/w1a-secrets-redaction (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-A (Secrets, redaction, logging) — Task 1A.2 of 5 (MIDDLE)

PRECONDITIONS
- W0 merged to main; branch off latest main; contracts exist at packages/core/src/secrets/types.ts (SecretKey, SecretsService, Redactor, SECRET_SHAPE_PATTERNS), persistence/ports.ts (SecretRepository + its envelope type), errors.ts, testing/* (InMemorySecretRepository, canaries).
- Task 1A.1 done: `MasterKeyProvider`, `MasterKey`, `StaticMasterKey` exist in `src/secrets/master-key.ts`.

REQUIRED READING (only these):
- packages/core/src/secrets/types.ts (SecretsService signature — implement it verbatim)
- packages/core/src/persistence/ports.ts (SecretRepository methods and the envelope type it accepts/returns — use that exact type; do not redefine it)
- packages/core/src/errors.ts (SecretIntegrityError, AgentHangarError constructor shape)
- packages/core/src/testing/in-memory-repositories.ts (how to construct the in-memory SecretRepository) and testing/canaries.ts
- docs/spec/03-interfaces.md § "6. Secrets service"
- docs/spec/02-data-model.md § "2" (Secret model: ciphertext, iv 12 bytes, authTag 16 bytes, keyVersion, last4) and § "3. Invariants" item 4
- docs/spec/06-testing.md § "2. Unit tests" → `secrets/` bullet

TASK
Implement the envelope crypto and the SecretsService so apps/web can save/remove/report secrets without ever seeing plaintext back, and apps/worker can reveal them for container injection.

DELIVERABLES

1. `packages/core/src/secrets/crypto.ts` — pure functions over `node:crypto`:
   ```ts
   export const IV_BYTES = 12; export const AUTH_TAG_BYTES = 16; export const ALGORITHM = 'aes-256-gcm';
   export interface SecretEnvelope { ciphertext: Buffer; iv: Buffer; authTag: Buffer; keyVersion: number }  // if ports.ts already exports an envelope type with these fields, import and re-export THAT type instead of declaring a new one
   export function encryptSecret(plaintext: string, masterKey: MasterKey): SecretEnvelope
   export function decryptSecret(envelope: SecretEnvelope, masterKey: MasterKey): string
   export function last4(plaintext: string): string
   ```
   - `encryptSecret`: `iv = randomBytes(IV_BYTES)`; `createCipheriv(ALGORITHM, masterKey.key, iv)`; ciphertext = `concat([update(utf8), final()])`; `authTag = cipher.getAuthTag()`; `keyVersion = masterKey.version`.
   - `decryptSecret`: guard first — `envelope.keyVersion !== masterKey.version` → `SecretIntegrityError('secret was encrypted with master key version X, current is Y')`; `iv.length !== IV_BYTES` or `authTag.length !== AUTH_TAG_BYTES` → `SecretIntegrityError`. Then `createDecipheriv` + `setAuthTag` + `update` + `final` inside try/catch; any thrown error → `SecretIntegrityError('secret integrity check failed')` (do not include the cause message — it can leak nothing useful and keeps output clean; attach `cause` via the `ErrorOptions` if `SecretIntegrityError` supports it).
   - Inputs from the repository may arrive as `Uint8Array`; normalise with `Buffer.from(...)` at the service boundary (item 3), not here.
   - `last4(p)` → `p.slice(-4)` (for length ≤ 4 returns the whole value — the UI still masks it; documented in JSDoc).
   - Note in the file header: no comparisons of secrets happen here, so `crypto.timingSafeEqual` is not needed; GCM's auth tag verification is constant-time inside OpenSSL.
2. `packages/core/src/secrets/errors.ts` — `export class InvalidSecretError extends AgentHangarError { readonly code = 'SECRET_INVALID' }` with default message `secret value must be a non-empty string`. (Follow the constructor pattern used by the subclasses in errors.ts.)
3. `packages/core/src/secrets/secrets-service.ts`
   ```ts
   export interface SecretsServiceDeps { repository: SecretRepository; masterKey: MasterKeyProvider }
   export function createSecretsService(deps: SecretsServiceDeps): SecretsService
   ```
   - `set(key, plaintext)`: `typeof plaintext !== 'string' || plaintext.length === 0` → throw `InvalidSecretError`. `const mk = await masterKey.load()`; `encryptSecret`; `repository.upsert(key, { ...envelope, last4: last4(plaintext) })` (shape exactly as the port expects); return `{ last4 }`.
   - `remove(key)` → `repository.remove(key)`.
   - `status()` → build a `Record<SecretKey, …>` with BOTH keys (`'GITHUB_PAT'`, `'OPENAI_API_KEY'` — iterate a local `SECRET_KEYS: readonly SecretKey[]` constant exported from this file; if types.ts already exports such a constant, use it) from `repository.status()` (or `get` per key if the port has no `status()`), mapping to `{ set: true, last4, updatedAt }` / `{ set: false }`. Never include ciphertext in the result.
   - `reveal(key)`: row = `await repository.get(key)`; `null` → `null`; else `decryptSecret({ ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv), authTag: Buffer.from(row.authTag), keyVersion: row.keyVersion }, await masterKey.load())`. JSDoc MUST state: "Worker-only. Never call from apps/web. The returned plaintext must be passed straight to `WorkspaceRunner.create()` env and to `Redactor.register()`; do not store it on any object."
   - The service holds no plaintext in closure state; `masterKey.load()` is awaited on every call (provider caches).
4. Tests:
   - `crypto.test.ts`: roundtrip with GITHUB_CANARY and OPENAI_CANARY; unicode plaintext roundtrip; two encryptions of the same plaintext → different iv, different ciphertext, same length; iv length 12 and authTag length 16; tampered ciphertext (flip one byte) → `SecretIntegrityError`; tampered authTag → `SecretIntegrityError`; wrong key (another random 32 bytes) → `SecretIntegrityError`; wrong iv length (11 bytes) → `SecretIntegrityError`; keyVersion mismatch → `SecretIntegrityError` whose message mentions both versions; `last4` for '', 'abc', 'abcd', 'abcde'; error is `instanceof SecretIntegrityError` and `instanceof AgentHangarError` with the W0 `code`.
   - `secrets-service.test.ts` (in-memory repository + `StaticMasterKey`): `set` returns last4 and the repository row has `keyVersion === 1`, 12-byte iv, 16-byte tag; serialised repository state (`JSON.stringify` of what the in-memory repo exposes, or `Buffer.toString('utf8')` of the stored ciphertext) passes `assertNoCanary`; `reveal` returns the exact plaintext; `reveal` of a key never set → `null`; `remove` then `reveal` → `null` and `status().GITHUB_PAT.set === false`; `status()` has both keys in every state; `set` with '' → `InvalidSecretError`; `set` twice replaces (reveal returns the second value, `status().last4` updated); a row stored with keyVersion 2 → `reveal` throws `SecretIntegrityError`; `reveal` with a corrupted stored ciphertext → `SecretIntegrityError`.
5. Update `packages/core/src/secrets/index.ts` to export the new modules.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- `node:crypto` only (`crypto` bare import is lint-banned). No plaintext in logs, errors or return values other than `reveal`.
- Do not modify `secrets/types.ts`, `persistence/ports.ts`, `errors.ts` or `testing/**`.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green; 100 % on `src/secrets/**` (types.ts excluded by config)
- `pnpm typecheck && pnpm lint` — exit 0
- `pnpm --filter @agent-hangar/core test 2>&1 | grep -c TESTCANARY` — prints 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1a-secrets-redaction.md; append `- 1A.2 ✅ <date> — <summary>`; commit `feat(core): add AES-256-GCM secrets service over the secret repository port`.
````

---

## Task 1A.3 — `Redactor`: exact registered values + shape patterns, `redactJson`, idempotent

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** Implement the `Redactor` from spec 03 §6: replaces registered live secret values (exact substring, plus their URL-encoded form) and every `SECRET_SHAPE_PATTERNS` match with `[REDACTED]`, in strings and deep inside JSON-like values; idempotent; no false positives on ordinary hex.

**Acceptance criteria**
- [ ] `createRedactor(options?)` returns a `RegisteringRedactor` (`Redactor` + `register(values)` + `clear()`), exported from `packages/core/src/redaction/redactor.ts`
- [ ] Exact values: registered values (and `encodeURIComponent(value)` when different) are replaced everywhere, longest first; values shorter than `MIN_REGISTERED_LENGTH` (4) are ignored with no error
- [ ] Shape patterns: every regex in `SECRET_SHAPE_PATTERNS` is applied globally (fresh `RegExp` with the `g` flag built from `source`/`flags`; never a shared stateful instance); the Bearer token value is gone from the output
- [ ] `redactJson` walks plain objects/arrays recursively (keys and string values), leaves numbers/booleans/null untouched, returns a new structure (input not mutated), tolerates cycles (`'[Circular]'`)
- [ ] `redact(redact(x)) === redact(x)`; `[REDACTED]` never matches a pattern
- [ ] 100 % coverage on `src/redaction/**`

**Files to create**
`packages/core/src/redaction/redactor.ts`, `packages/core/src/redaction/redactor.test.ts`, `packages/core/src/redaction/index.ts`; modify `packages/core/vitest.config.ts` (`coverage.include` += `src/redaction/**`), (folder barrel only — root `src/index.ts` is frozen).

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core is framework-free. Vitest 4 with @vitest/coverage-v8.
Branch feat/w1a-secrets-redaction (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-A (Secrets, redaction, logging) — Task 1A.3 of 5 (MIDDLE)

PRECONDITIONS
- W0 merged to main; branch off latest main; contracts exist at packages/core/src/secrets/types.ts (Redactor interface, SECRET_SHAPE_PATTERNS), testing/canaries.ts (GITHUB_CANARY, OPENAI_CANARY, CANARY_VALUES, assertNoCanary).
- Independent of 1A.1/1A.2 (may be done in any order after them; keep commits separate).

REQUIRED READING (only these):
- packages/core/src/secrets/types.ts (Redactor, SECRET_SHAPE_PATTERNS — implement against these exactly)
- packages/core/src/testing/canaries.ts
- docs/spec/03-interfaces.md § "6. Secrets service" (Redactor + the shape-pattern paragraph)
- docs/spec/04-flows.md § "(d)" REDACT section and controls table rows "Shell tool", "Logs"
- docs/spec/06-testing.md § "2. Unit tests" → `redaction/` bullet

TASK
Implement the Redactor used by the worker (every AgentEvent before persistence/XADD), by repositories (redact-on-write, W1-E injects it) and by the logger (Task 1A.4).

DELIVERABLES

1. `packages/core/src/redaction/redactor.ts`
   ```ts
   export const REDACTED = '[REDACTED]';
   export const MIN_REGISTERED_LENGTH = 4;
   export interface RedactorOptions { patterns?: readonly RegExp[]; replacement?: string }   // defaults: SECRET_SHAPE_PATTERNS, REDACTED
   export interface RegisteringRedactor extends Redactor {
     /** Register live secret values (worker calls this right after SecretsService.reveal). Idempotent; ignores empty/short values. */
     register(values: Iterable<string>): void;
     /** Forget registered values (tests / worker shutdown). Shape patterns stay active. */
     clear(): void;
   }
   export function createRedactor(options?: RedactorOptions): RegisteringRedactor
   export function escapeRegExp(value: string): string
   ```
   - State: `Set<string>` of registered values. `register` adds each value with `length >= MIN_REGISTERED_LENGTH`; also adds `encodeURIComponent(value)` when it differs (PAT inside a URL query/userinfo).
   - `redact(input)`: (1) for each registered value sorted by length desc, `split(value).join(replacement)` (no regex needed for exact values); (2) for each pattern, `input.replace(new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'), replacement)` — build these compiled globals ONCE in the factory, not per call. For a pattern that captures the secret after a fixed prefix (the Bearer pattern), the result must not contain the token; whether the prefix `Authorization: Bearer ` survives depends on how W0 wrote the regex — the test asserts token absence and presence of `[REDACTED]`, not the prefix. Non-string input → `String(input)`? No: the contract says `redact(input: string)`; keep it strict.
   - `redactJson(input)`: recursive with a `WeakSet` for cycle detection → `'[Circular]'`; strings → `redact`; arrays → map; plain objects (`Object.getPrototypeOf(v) === Object.prototype || === null`) → new object with redacted keys and values; `Date`, `Buffer`/`Uint8Array`, class instances, functions, symbols, bigint → returned as-is (documented); `undefined` preserved.
   - Idempotence follows from `[REDACTED]` not matching any pattern and not being registered — add a guard that refuses to register the replacement token itself.
2. `packages/core/src/redaction/index.ts` barrel; the root `packages/core/src/index.ts` already re-exports `./redaction/index.js` — do not edit it.
3. `packages/core/src/redaction/redactor.test.ts` — cases (each a separate it() with a block comment):
   - exact value redaction: registered GITHUB_CANARY inside plain text, inside a JSON string (`JSON.stringify({ token: GITHUB_CANARY })`), inside a URL (`https://x-access-token:${GITHUB_CANARY}@github.com/o/r.git`), URL-encoded form (`encodeURIComponent('sk-abc/def+ghi' style value containing chars that encode)` — register a value with `/` and `+` and assert both raw and encoded forms are redacted);
   - longest-first: register `abcd` and `abcdefgh`, input `abcdefgh` → a single `[REDACTED]` (not `[REDACTED]efgh`);
   - values shorter than 4 are ignored (register 'ab', input 'ab' unchanged); registering `[REDACTED]` is ignored;
   - `clear()` forgets registered values but shape patterns still apply;
   - shape patterns, one it() per pattern: `ghp_` + 36 alnum; `github_pat_` + 22+ `[A-Za-z0-9_]`; `sk-` + 20+; `sk-proj-` + 20+; `Authorization: Bearer <token>` — use synthetic values built in the test from the canaries or `'x'.repeat(n)`; assert the secret is absent and `[REDACTED]` present; multiple occurrences in one string are all replaced;
   - no false positive: a 40-char git sha (`'a'.repeat(40)` or `'deadbeef'.repeat(5)`), the word `Bearer` alone, `sk-short` (fewer than 20 chars), and ordinary prose stay byte-identical;
   - `redactJson`: nested objects/arrays with canaries at depth 3 (values and keys), numbers/booleans/null untouched, input object not mutated (deep-equal snapshot before/after), cyclic object → contains `'[Circular]'` and does not throw, Date instance returned as the same reference, `undefined` preserved;
   - idempotence: `redact(redact(s)) === redact(s)` for a string mixing all patterns and a registered value; same for `redactJson`;
   - `escapeRegExp` escapes every special character (round-trip: `new RegExp(escapeRegExp(s)).test(s)` for `s = '.*+?^${}()|[]\\/'`);
   - final sanity: `assertNoCanary(redact(text-with-both-canaries-registered))` passes.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- Do not edit `secrets/types.ts`; if `SECRET_SHAPE_PATTERNS` lacks a pattern the spec lists, implement against what exists and record a contractChangeRequest in the PR.
- Performance: no regex construction inside `redact()`; no `JSON.parse/stringify` round-trip in `redactJson`.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green; 100 % on `src/redaction/**`
- `pnpm typecheck && pnpm lint` — exit 0
- `pnpm --filter @agent-hangar/core test 2>&1 | grep -c TESTCANARY` — prints 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1a-secrets-redaction.md; append `- 1A.3 ✅ <date> — <summary>`; commit `feat(core): add redactor for registered secrets and shape patterns`.
````

---

## Task 1A.4 — pino logger factory with redact paths + `Redactor` serializer/hook

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** S · **Depends on:** 1A.3

**Description.** Provide `createLogger` (pino) for apps/worker and apps/web API routes: pino `redact` on known secret-bearing paths, a `formatters.log`/`formatters.bindings` pass through `redactor.redactJson`, a `hooks.logMethod` that redacts message strings and interpolation args, and an `err` serializer that redacts message/stack. No PII, no plaintext, ever.

**Acceptance criteria**
- [ ] `createLogger({ level, redactor, name?, destination?, base? })` exported from `packages/core/src/logging/logger.ts`; returns a pino `Logger`
- [ ] `LOG_REDACT_PATHS` constant exported (`env.GITHUB_TOKEN`, `env.OPENAI_API_KEY`, `*.env.GITHUB_TOKEN`, `*.env.OPENAI_API_KEY`, `headers.authorization`, `*.headers.authorization`, `req.headers.authorization`, `secret`, `*.secret`, `plaintext`, `*.plaintext`, `apiKey`, `*.apiKey`, `token`, `*.token`) with censor `[REDACTED]`
- [ ] Canaries passed as message, as interpolation arg, inside merge objects at any depth, inside child bindings, inside `err.message`/`err.stack`, and under a redact path never appear in the output stream (`assertNoCanary` on the captured output)
- [ ] Level, `name` and `base` are honoured; `destination` defaults to stdout (pino default) and can be any `DestinationStream`
- [ ] 100 % coverage on `src/logging/**`

**Files to create**
`packages/core/src/logging/logger.ts`, `packages/core/src/logging/logger.test.ts`, `packages/core/src/logging/index.ts`; modify `packages/core/vitest.config.ts` (`coverage.include` += `src/logging/**`), (folder barrel only — root `src/index.ts` is frozen).

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core is framework-free (pino is a dependency of core). Vitest 4 with @vitest/coverage-v8.
Branch feat/w1a-secrets-redaction (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-A (Secrets, redaction, logging) — Task 1A.4 of 5 (MIDDLE)

PRECONDITIONS
- W0 merged to main; branch off latest main; contracts exist at packages/core/src/secrets/types.ts, testing/canaries.ts.
- Task 1A.3 done: `createRedactor` / `RegisteringRedactor` exist in `src/redaction/redactor.ts`.

REQUIRED READING (only these):
- packages/core/src/redaction/redactor.ts (your own API)
- packages/core/src/testing/canaries.ts
- docs/spec/04-flows.md § "(d)" — controls table rows "Logs" and "Transport" (request logging disabled for /api/settings is W2-A's job; this lane gives them the safe logger)
- pino docs (installed version, `node_modules/pino/docs/`): `redact`, `formatters`, `hooks.logMethod`, `serializers`, `destination`

TASK
Create the single logger factory every process uses, so redaction is structural (paths + serializer + hook) rather than something each call site must remember.

DELIVERABLES

1. `packages/core/src/logging/logger.ts`
   ```ts
   import type { DestinationStream, Logger, LoggerOptions } from 'pino';
   export const LOG_REDACT_PATHS: readonly string[] = [ /* list from the acceptance criteria */ ];
   export interface CreateLoggerOptions {
     level: string;                      // validated by pino; 'silent' allowed
     redactor: Pick<Redactor, 'redact' | 'redactJson'>;
     name?: string;
     base?: Record<string, unknown>;     // default { pid, hostname } removed → use {} (no hostname PII by default; documented)
     destination?: DestinationStream;    // default: pino's stdout
   }
   export function createLogger(options: CreateLoggerOptions): Logger
   ```
   - Options passed to pino: `level`, `name`, `base: options.base ?? {}`, `redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED }`, `formatters: { log: (obj) => redactor.redactJson(obj) as Record<string, unknown>, bindings: (b) => redactor.redactJson(b) as Record<string, unknown> }`, `serializers: { err: (err) => redactErr(pino.stdSerializers.err(err)) }` where `redactErr` maps `message`, `stack`, `type` and any string props through `redactor.redact`, `hooks: { logMethod(args, method) { method.apply(this, args.map(a => typeof a === 'string' ? redactor.redact(a) : a)) } }`, `timestamp: pino.stdTimeFunctions.isoTime`.
   - The `formatters.log` path must be typed without `any`: cast the result of `redactJson` through `unknown` to `Record<string, unknown>` (it is a plain object by construction) — one cast, documented in a comment.
   - If pino (installed major) rejects `formatters` together with a transport, that is irrelevant here because this factory never configures a transport (apps/worker's own `logger.ts` wraps pretty printing; document that in the file header).
2. `packages/core/src/logging/index.ts` barrel; the root `packages/core/src/index.ts` already re-exports `./logging/index.js` — do not edit it.
3. `packages/core/src/logging/logger.test.ts` — capture output with a `Writable` (`new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } })`) passed as `destination`; a redactor with both canaries registered. Cases:
   - message string containing GITHUB_CANARY → output contains `[REDACTED]`, `assertNoCanary(output)` passes;
   - interpolation (`logger.info('token=%s', OPENAI_CANARY)`) → redacted;
   - merge object at depth 3 (`{ a: { b: { c: OPENAI_CANARY } } }`) → redacted by `formatters.log`;
   - redact path (`{ env: { GITHUB_TOKEN: 'not-a-canary-shape-value-1234' } }`) → value replaced by `[REDACTED]` even though it matches no pattern (proves paths work independently of the redactor); also `{ req: { headers: { authorization: 'Basic abc' } } }`;
   - child bindings (`logger.child({ apiKey: OPENAI_CANARY, turnId: 't1' }).info('x')`) → binding redacted, `turnId` preserved;
   - `logger.error({ err: new Error(`boom ${GITHUB_CANARY}`) }, 'failed')` → `err.message` and `err.stack` redacted, `err.type === 'Error'`;
   - an unshaped value that the redactor does not know (plain text) is logged verbatim (no over-redaction);
   - `level: 'warn'` suppresses `info`; `level: 'silent'` writes nothing; `name` appears in output; `base: { service: 'worker' }` appears; default `base` yields no `hostname`/`pid` keys;
   - output lines are valid JSON with an ISO `time` field.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- No `pino-pretty` import in src (dev-only dependency; worker decides pretty printing).
- No new dependencies.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green; 100 % on `src/logging/**`
- `pnpm typecheck && pnpm lint` — exit 0
- `pnpm --filter @agent-hangar/core test 2>&1 | grep -c TESTCANARY` — prints 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1a-secrets-redaction.md; append `- 1A.4 ✅ <date> — <summary>`; commit `feat(core): add redacting pino logger factory`.
````

---

## Task 1A.5 — Close-out: gates, code review, dashboard, PR

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** S · **Depends on:** 1A.1–1A.4

**Description.** Run every gate for the lane's owned paths, run the code review to zero findings, update the plan dashboard and the tasks index, open the PR and return the structured summary to the orchestrator.

**Acceptance criteria**
- [ ] `pnpm lint && pnpm format:check && pnpm typecheck` exit 0; `pnpm --filter @agent-hangar/core test -- --coverage` green with 100 % lines/branches/functions/statements on `src/secrets/**`, `src/redaction/**`, `src/logging/**`
- [ ] `pnpm --filter @agent-hangar/core test 2>&1 | grep -c TESTCANARY` prints 0
- [ ] `/bymax-quality:code-review` run on the branch with zero open findings (CRITICAL/HIGH/MEDIUM/LOW all resolved or explicitly justified in the PR)
- [ ] `docs/plan.md` §12 row W1-A → 🟨 with branch + PR number + coverage; `docs/tasks/README.md` row for this lane updated
- [ ] PR opened against `main`; structured summary `{ pr, branch, headSha, gates, coverage, contractChangeRequests }` returned

**Files to modify**
`docs/plan.md` (§12 row only), `docs/tasks/README.md` (lane row only), `docs/tasks/wave-1a-secrets-redaction.md` (header + log).

**Agent prompt**

````
You are a senior engineer closing out lane W1-A of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 · Node 24 · Vitest 4 · GitHub CLI.
Branch feat/w1a-secrets-redaction (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-A (Secrets, redaction, logging) — Task 1A.5 of 5 (LAST)

PRECONDITIONS
- Tasks 1A.1–1A.4 done and committed on this branch; working tree clean.

REQUIRED READING (only these):
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard"
- docs/tasks/README.md (the index row for W1-A)
- CLAUDE.md "Gates before any PR"

TASK
Run all gates for the owned paths, review to zero findings, update the dashboards, open the PR, and return the structured summary. Do not merge, do not wait for CI.

DELIVERABLES

1. Gates (all must pass; fix, never suppress):
   - `pnpm lint && pnpm format:check && pnpm typecheck`
   - `pnpm --filter @agent-hangar/core test -- --coverage` → thresholds 100×4 enforced by `packages/core/vitest.config.ts`; confirm `coverage.include` contains `src/secrets/**`, `src/redaction/**`, `src/logging/**`
   - `pnpm --filter @agent-hangar/core test 2>&1 | grep -c TESTCANARY` → `0`
   - `git diff --name-only main...HEAD` shows only owned paths + `packages/core/vitest.config.ts` + this task file (+ the two docs rows in step 3). Anything else → revert it.
2. Run `/bymax-quality:code-review` (full mode) on `main...HEAD`. Resolve every finding — CRITICAL, HIGH, MEDIUM, LOW. A finding you decide not to fix must be listed in the PR body under "Review notes" with the reason. Re-run the gates after fixes. If the environment's pre-push hook requires a recorded, cleared review, follow its instructions (`~/.claude/hooks/code-review-clear.sh`) only after every finding is resolved.
3. Dashboards: `docs/plan.md` §12 row `W1-A` → `🟨` with `feat/w1a-secrets-redaction` / `#<PR>` and the coverage summary; `docs/tasks/README.md` row for W1-A → 🟨 PR open. Header of this file: Status → 🟨 PR open, Progress 5/5.
4. Commit `docs(tasks): close out W1-A` (after the PR number is known, amend the row in a follow-up commit if needed — never force-push).
5. Open the PR: `gh pr create --base main --head feat/w1a-secrets-redaction --title "feat(core): secrets service, redactor and redacting logger (W1-A)" --body-file <generated>`. Body sections: Summary · What is implemented (file list) · How consumers use it (W2-A: `status()`; W2-B: `reveal()` → `register()` → `create()`; logger factory) · Gates (commands + results) · Coverage (the four numbers for owned paths) · Canary check (`grep -c` = 0) · Review notes · Contract change requests (empty list or entries `{ file, change, reason }`). English, no attribution.
6. Return to the orchestrator exactly: `{ pr: <number>, branch: 'feat/w1a-secrets-redaction', headSha: '<sha>', gates: { lint, format, typecheck, unit }, coverage: { lines, branches, functions, statements }, contractChangeRequests: [...] }`.

Constraints:
- English; Conventional Commits; no AI attribution anywhere.
- Do not touch paths outside the owned list except the two dashboard rows named above.

Verification:
- `gh pr view --json number,headRefOid,state` — PR exists, open
- `git status --porcelain` — empty

Completion Protocol: update status/AC/progress in docs/tasks/wave-1a-secrets-redaction.md (lane header Status → 🟨 PR open); append `- 1A.5 ✅ <date> — PR #<n> opened`; push the final commit before opening the PR.
````

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)
- 1A.1 ✅ 2026-08-19 — master key providers: 0600 atomic key file with owner-only enforcement, hex validation and caching, plus StaticMasterKey.
- 1A.2 ✅ 2026-08-19 — AES-256-GCM envelope crypto with fail-closed integrity checks and the SecretsService over the SecretRepository port.
