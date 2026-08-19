# Wave 1 — Lane E — Persistence repositories (core)

| | |
|---|---|
| **Lane** | W1-E (parallel with W1-A … W1-I; no Docker) |
| **Status** | 🟦 running |
| **Progress** | 4/5 tasks |
| **Branch** | `feat/w1e-persistence` |
| **Owned paths** | `packages/core/src/persistence/repositories/**`, `packages/core/src/persistence/testing/db.ts` (+ its test), `packages/core/vitest.config.ts` (`coverage.include` lines only) |
| **Depends on** | W0 merged to `main` |
| **Unblocks** | W2-A (web API routes), W2-B (worker processors) |
| **Source** | [docs/plan.md §6 W1-E](../plan.md) · spec [02](../spec/02-data-model.md) [03 §6](../spec/03-interfaces.md) [06 §3](../spec/06-testing.md) |
| **Last updated** | 2026-08-19 |

## Context

W0 froze the repository **ports** (`packages/core/src/persistence/ports.ts`), the Prisma 7 schema + first migration (`packages/core/prisma/**`), the client factory (`persistence/client.ts`) and the in-memory doubles (`src/testing/in-memory-repositories.ts`). This lane writes the **Prisma implementations** of every port so W2-A (web API) and W2-B (worker) can swap the in-memory repositories for real Postgres without touching any caller.

Repositories are the **only writers** to Postgres (spec 02 §3 invariant 1). Every column that can carry agent or tool output is redacted at the repository boundary through an injected `Redactor`, so a canary value can never reach a row even if a caller forgets. Prisma types never leave `src/persistence/**`; callers see domain types from `src/workspace/types.ts` and `ports.ts` only.

Testing model for this lane (plan §6 W1-E): mappers and helpers are unit-tested; every repository method and every data-model invariant is tested **against compose Postgres** (`AH_INSTANCE=test`) in suites tagged `@db`. `pnpm test` runs the `@db` suites whenever `DATABASE_URL` is set, and coverage counts them — CI always has a database, so the 100 % gate is real there.

## Rules of this lane

1. Owned paths only. Do not edit `ports.ts`, `schema.prisma`, migrations, `client.ts`, `errors.ts`, `workspace/types.ts` or `testing/in-memory-repositories.ts`. If a port signature blocks you, stop and report a `contractChangeRequest` (additive only) instead of changing it.
2. No new dependencies; no new migrations. The schema is frozen; if a query needs an index the schema lacks, note it in the PR — do not add it.
3. No `enum` keyword. Prisma's generated enums stay inside `src/persistence/**`; they are translated to the string-literal unions of `workspace/types.ts` in `mappers.ts` and nowhere else.
4. Redact-on-write is mandatory for: `Message.content`, `Turn.error`, `Workspace.failureReason`, `JobRun.output`, `JobRun.error`, `ToolCallLog.args` (via `redactJson`), `ToolCallLog.resultHead`. Never redact identifiers, URLs, branch names or enum values.
5. Integration test files are named `*.integration.test.ts`, their top-level `describe` title starts with `@db`, and they use `withTestDb` / `truncateAll` from `persistence/testing/db.ts`. They must FAIL (not skip) when `CI=1` and the database is unreachable.
6. Coverage thresholds stay 100/100/100/100. Extend `packages/core/vitest.config.ts` `coverage.include` with `src/persistence/repositories/**` and `src/persistence/testing/**`; keep the W0 rule that when `DATABASE_URL` is unset the integration files are excluded from the run **and** `src/persistence/repositories/**` is dropped from `coverage.include` (mappers/errors/helpers stay), so a unit-only run still passes its thresholds.
7. JSDoc on every export, file header on every file, English only, test files with a header and a block comment on every `it()`. No suppression comments. Canaries from `@agent-hangar/core/testing` (`GITHUB_CANARY`, `OPENAI_CANARY`, `assertNoCanary`) — never real-looking secrets in tests or fixtures.
8. Conventional Commits, English, no attribution trailers. Branch `feat/w1e-persistence`. One PR at the end (Task 1E.5).

## Reference docs

- [docs/plan.md](../plan.md) § "6. Wave 1" (W1-E), § "3. Parallelism rules", § "11. Orchestrator protocol"
- [spec 02 — Data model](../spec/02-data-model.md) (all sections; §3 invariants and §4 restore fields drive the method behaviours)
- [spec 03 — Interface contracts](../spec/03-interfaces.md) § "6. Secrets service" (`Redactor` is injected, never constructed here)
- [spec 06 — Testing](../spec/06-testing.md) § "3. Integration tests" (Persistence bullet), § "2. Unit tests"
- W0 contract files: `packages/core/src/persistence/ports.ts`, `persistence/client.ts`, `persistence/generated/**` (via `pnpm db:generate`), `workspace/types.ts`, `secrets/types.ts`, `errors.ts`, `testing/in-memory-repositories.ts`, `testing/canaries.ts`, `persistence/testing/db.ts`

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 1E.1 | Mappers, repository errors, Prisma error translation, `createRepositories` skeleton, db helper extension | ✅ | P0 | M | — |
| 1E.2 | `ChatRepository`, `MessageRepository` (gap-free `seq` transaction), `TurnRepository` + `@db` suites | ✅ | P0 | L | 1E.1 |
| 1E.3 | `WorkspaceRepository` (partial-unique → typed error), `ScheduledJobRepository`, `JobRunRepository` + `@db` suites | ✅ | P0 | L | 1E.1 |
| 1E.4 | `ToolCallLogRepository`, `SecretRepository`, cross-repository invariant suite (cascade, concurrency, canary never stored) | ✅ | P0 | M | 1E.2, 1E.3 |
| 1E.5 | Close-out: gates, code review, dashboard, PR | 📋 | P0 | S | 1E.1–1E.4 |

---

## Task 1E.1 — Mappers, repository errors, Prisma error translation, `createRepositories` skeleton, db helper extension

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** Lay the shared ground for every repository: a pure `mappers.ts` that converts Prisma rows and enums to domain types (and back), a small typed-error module for persistence-level failures, a translator from `PrismaClientKnownRequestError` codes to those errors, the `createRepositories(prisma, redactor)` factory with the same shape as `createInMemoryRepositories`, and the `@db` helper extensions the later tasks need. Everything here except the factory's wiring is unit-testable without a database.

**Acceptance criteria**
- [x] `mappers.ts` exports one `to<Entity>(row)` function per model (`toChat`, `toMessage`, `toTurn`, `toWorkspace`, `toScheduledJob`, `toJobRun`, `toToolCallLog`, `toSecretEnvelope`) returning the domain types used by `ports.ts`, with `null` → `undefined` conversion where the domain type uses optional fields (`exactOptionalPropertyTypes`) and `Date` values passed through untouched
- [x] `mappers.ts` exports validated enum converters for every Prisma enum (`asChatStatus`, `asMessageRole`, `asTurnStatus`, `asWorkspaceKind`, `asWorkspaceStatus`, `asJobRunStatus`, `asJobRunTrigger`, `asToolCallStatus`, `asSecretKey`) that throw `PersistenceMappingError` on an unknown value, and their inverses that are identity on the literal strings
- [x] `errors.ts` exports `EntityNotFoundError` (`code: 'ENTITY_NOT_FOUND'`, fields `entity`, `id`), `LiveWorkspaceConflictError` (`code: 'LIVE_WORKSPACE_CONFLICT'`, field `chatId`), `UniqueViolationError` (`code: 'UNIQUE_VIOLATION'`, field `constraint`), `PersistenceMappingError` (`code: 'PERSISTENCE_MAPPING'`), all extending `AgentHangarError` from `src/errors.ts`
- [x] `prisma-errors.ts` exports `translatePrismaError(error: unknown, ctx): never` mapping `P2002` → `LiveWorkspaceConflictError` when the violated index is `Workspace_one_live_per_chat`, otherwise `UniqueViolationError`; `P2025` → `EntityNotFoundError`; anything else is rethrown unchanged
- [x] `index.ts` exports `createRepositories(prisma, redactor): Repositories` (property names identical to `createInMemoryRepositories` in `src/testing/in-memory-repositories.ts`) plus every class and error; nothing Prisma-typed is exported
- [x] `persistence/testing/db.ts` gains `describeDb(title, fn)` (registers a `describe` titled `@db <title>` that runs when `DATABASE_URL` is set, throws a loud error when `CI=1` and it is unset/unreachable, and logs a skip message locally otherwise), `seedChat(client, overrides?)`, `rawSelect<T>(client, sql, ...params)` and `countRows(client, table)`
- [x] Unit tests give 100 % coverage on `mappers.ts`, `errors.ts`, `prisma-errors.ts`; `db.ts` additions are covered by the `@db` runs of later tasks plus a unit test of `describeDb`'s decision function (`shouldRunDbSuite(env)`)

**Files to create/modify**
`packages/core/src/persistence/repositories/{mappers,mappers.test,errors,errors.test,prisma-errors,prisma-errors.test,index}.ts`, `packages/core/src/persistence/testing/db.ts` (+ `db.test.ts` for the pure decision function), `packages/core/vitest.config.ts` (`coverage.include` extension only).

**Agent prompt**

````
You are a senior backend engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Postgres 18 · Prisma 7.9 (`prisma-client` generator, `@prisma/adapter-pg`, generated client in `packages/core/src/persistence/generated` via `pnpm db:generate`) · Vitest 4 with @vitest/coverage-v8.
Branch feat/w1e-persistence (worktree, branched off latest main). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-E (Persistence repositories) — Task 1E.1 of 5 (FIRST)

PRECONDITIONS
- W0 merged to main; you branched off latest main. `pnpm install --frozen-lockfile` and `pnpm db:generate` succeed.
- Compose Postgres for the test instance is available. The instance name alone does not pick a port block, so use `AH_INSTANCE=test AH_PORT_BASE=3200` consistently for this lane. In your shell: `eval "$(AH_INSTANCE=test AH_PORT_BASE=3200 bash infra/scripts/env.sh --print)"` (exports `DATABASE_URL=postgresql://ah:ah@127.0.0.1:3201/agent_hangar_test`, `COMPOSE_PROJECT_NAME=agent-hangar-test`, …), then `docker compose -f infra/docker-compose.yml up -d --wait` (compose interpolates from the exported environment — do not overwrite the repo's `.env.local`), then `pnpm --filter @agent-hangar/core db:migrate` once.

REQUIRED READING (only these):
- packages/core/src/persistence/ports.ts (every method you will implement — read the JSDoc carefully; return types decide null-vs-throw)
- packages/core/src/workspace/types.ts (domain unions and records)
- packages/core/src/secrets/types.ts (`Redactor`, `SecretKey`)
- packages/core/src/errors.ts (`AgentHangarError` base)
- packages/core/src/testing/in-memory-repositories.ts (the `createInMemoryRepositories` return shape you must mirror; the invariants it enforces)
- packages/core/src/persistence/testing/db.ts and client.ts (W0 helpers you extend)
- packages/core/prisma/schema.prisma (column names, nullability, enums)
- docs/spec/02-data-model.md § "3. Invariants"

TASK
Create the shared foundation of the Prisma repositories: pure mappers (Prisma row/enum → domain, domain → Prisma input), a typed persistence error module, a Prisma error translator, the `createRepositories` factory skeleton (classes may be stubs that throw `new Error('not implemented')` for now — each later task fills its own), and the `@db` test helper extensions.

DELIVERABLES

1. `packages/core/src/persistence/repositories/errors.ts` — classes extending `AgentHangarError`:
   - `EntityNotFoundError(entity: string, id: string)` → `code = 'ENTITY_NOT_FOUND'`, message `"<entity> <id> not found"`.
   - `LiveWorkspaceConflictError(chatId: string)` → `code = 'LIVE_WORKSPACE_CONFLICT'`, message `"chat <chatId> already has a live workspace"`.
   - `UniqueViolationError(constraint: string)` → `code = 'UNIQUE_VIOLATION'`.
   - `PersistenceMappingError(detail: string)` → `code = 'PERSISTENCE_MAPPING'`.
   Each has a `readonly code` literal type and keeps `name` equal to the class name.
2. `mappers.ts` — no I/O, no Prisma client import (type-only imports from `../generated/client` are fine; never import the runtime):
   - Enum converters: for each Prisma enum, `as<Union>(value: string): <Union>` implemented with a `const` tuple of the allowed literals and `includes`, throwing `PersistenceMappingError` otherwise. The inverse direction is the identity (both sides share the literal strings) — expose it anyway as `toPrisma<Union>` so callers never write a cast.
   - Row mappers `toChat(row)`, `toMessage(row)`, `toTurn(row)`, `toWorkspace(row)`, `toScheduledJob(row)`, `toJobRun(row)`, `toToolCallLog(row)`, `toSecretEnvelope(row)` returning the exact domain types referenced by `ports.ts`. Rules: `null` → `undefined` for optional domain fields; `Date` stays `Date`; `Json` (`ToolCallLog.args`) is passed through as `unknown`; `Bytes` columns arrive as `Uint8Array` in Prisma 7 — keep `Uint8Array` in the envelope type (do not convert to Buffer).
   - Input helpers that the repositories share: `optionalToNull<T>(v: T | undefined): T | null` and `RESULT_HEAD_MAX_BYTES = 8 * 1024` with `truncateResultHead(text: string): string` (UTF-8 byte-aware truncation, no notice appended — the `resultBytes` column carries the full length).
3. `prisma-errors.ts` — `translatePrismaError(error: unknown, ctx: { entity: string; id?: string }): never`. Detect `PrismaClientKnownRequestError` by duck-typing (`typeof error === 'object' && 'code' in error && typeof code === 'string'` — do not `instanceof` the generated class so unit tests can pass plain objects). `P2002`: read `meta.target` (array or string) and the message; if either mentions `Workspace_one_live_per_chat` throw `LiveWorkspaceConflictError(ctx.id ?? 'unknown')`, else `UniqueViolationError(<target joined by ',' or 'unknown'>)`. `P2025` → `EntityNotFoundError(ctx.entity, ctx.id ?? 'unknown')`. Otherwise `throw error`. Write the `@db` test in Task 1E.3 first to observe the exact `meta` shape Postgres/Prisma produce for a raw partial index and pin the translator to it.
4. `index.ts` — `export interface Repositories { … }` with the SAME property names as `createInMemoryRepositories` returns (read it; if W0 already exports a `Repositories` type from `src/testing` or `ports.ts`, import and reuse it instead of redefining), `createRepositories(prisma: PrismaClient, redactor: Redactor): Repositories` constructing one instance per port class (`PrismaChatRepository`, `PrismaMessageRepository`, `PrismaTurnRepository`, `PrismaWorkspaceRepository`, `PrismaScheduledJobRepository`, `PrismaJobRunRepository`, `PrismaToolCallLogRepository`, `PrismaSecretRepository`), re-exports of the classes, errors and mappers. Stub classes in their own files now (`chat.repository.ts` etc.) with constructors `(prisma, redactor)` and methods throwing `new Error('not implemented: <method>')`; tasks 1E.2–1E.4 replace the bodies. The `PrismaClient` type is imported from `../generated/client` — it never appears in a public export signature other than `createRepositories`' parameter (document that this is the single allowed leak, mirroring `createPrismaClient`).
5. `persistence/testing/db.ts` — keep W0's `connectTestDb`, `truncateAll`, `withTestDb`; add:
   - `shouldRunDbSuite(env: NodeJS.ProcessEnv): { run: boolean; reason: string }` — `DATABASE_URL` set → run; unset and `CI` truthy → throw `ConfigError('DATABASE_URL is required in CI for @db suites')`; unset locally → `{ run: false, reason: 'DATABASE_URL not set — @db suite skipped (start compose with AH_INSTANCE=test)' }`.
   - `describeDb(title: string, fn: () => void): void` — `const d = shouldRunDbSuite(process.env); if (!d.run) { console.warn(d.reason); describe.skip(`@db ${title}`, fn); return; } describe(`@db ${title}`, fn);`
   - `seedChat(client, overrides?: Partial<{ title; repoUrl; baseBranch; status }>)` inserting a Chat directly via Prisma and returning its id (tests for Message/Turn/Workspace need a parent).
   - `rawSelect<T>(client, sql: TemplateStringsArray, ...values: unknown[]): Promise<T[]>` thin wrapper over `$queryRaw` (used to assert redaction by reading the raw column, bypassing mappers) and `countRows(client, table: 'Chat' | 'Message' | … )` using `$queryRawUnsafe` with a whitelisted table name only.
6. `packages/core/vitest.config.ts` — add `src/persistence/repositories/**` and `src/persistence/testing/**` to `coverage.include`. Implement the conditional described in the lane rules: `const hasDb = Boolean(process.env.DATABASE_URL)`; when `!hasDb`, add `**/*.integration.test.ts` to `exclude` and omit `src/persistence/repositories/**` from `coverage.include` (keep `mappers.ts`, `errors.ts`, `prisma-errors.ts` covered by listing them explicitly). Leave every other W0 entry untouched.
7. Tests (`*.test.ts` next to each file, unit, no DB):
   - `errors.test.ts`: each class — `code`, `message`, `instanceof AgentHangarError`, `name`.
   - `mappers.test.ts`: every enum converter accepts all literals and throws `PersistenceMappingError` on `'BOGUS'`; each row mapper maps a fully populated row and a row with every nullable column `null` (assert `undefined`, not `null`, in the output); `truncateResultHead` on ASCII under/over the limit and on multi-byte text (no split code point); `optionalToNull`.
   - `prisma-errors.test.ts`: P2002 with `meta.target = ['chatId']` + message containing the partial index name → `LiveWorkspaceConflictError`; P2002 with `meta.target = ['workspaceId']` → `UniqueViolationError('workspaceId')`; P2025 → `EntityNotFoundError`; unknown code → rethrown same reference; non-object → rethrown.
   - `db.test.ts` (unit): `shouldRunDbSuite` three branches.

Constraints:
- Follow /bymax-workflow:standards: TS strict, JSDoc on every export + file header, English, no `enum`, no suppression comments, test headers and a block comment on every it().
- Owned paths only; no new dependencies; no changes to ports.ts/schema/migrations.
- No Prisma runtime import in mappers; type-only imports use `import type`.

Verification:
- `pnpm --filter @agent-hangar/core db:generate && pnpm --filter @agent-hangar/core test -- --coverage` (without DATABASE_URL) — green; 100 % on mappers/errors/prisma-errors/db decision function
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-1e-persistence.md (task index row and task block)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/5 tasks`)
4. Append a completion log entry at the end of the file: `- 1E.1 ✅ <YYYY-MM-DD> — <one-line summary>`
5. Commit: `feat(core): add persistence mappers, repository errors and factory skeleton`
````

---

## Task 1E.2 — `ChatRepository`, `MessageRepository` (gap-free `seq` transaction), `TurnRepository` + `@db` suites

**Status:** ✅ Done · **Priority:** P0 · **Size:** L · **Depends on:** 1E.1

**Description.** Implement the three conversation repositories. The critical piece is `MessageRepository.append`, which must assign a gap-free, per-chat `seq` under concurrency using an interactive transaction that locks the parent `Chat` row (`SELECT … FOR UPDATE`) before computing `COALESCE(MAX(seq),0)+1`. Every write of agent-visible text goes through the injected `Redactor`.

**Acceptance criteria**
- [x] `PrismaChatRepository` implements every `ChatRepository` method: `create`, `getById` (null when missing), `list(status?)` ordered by `updatedAt` desc, `setStatus` (sets/clears `archivedAt` for `ARCHIVED`/`ACTIVE`), `updateRestoreHints({ workBranch?, lastPushedSha? })` (only provided fields change), `touch` (bumps `updatedAt`), `delete` (cascade)
- [x] `PrismaMessageRepository.append(chatId, role, content, turnId?)` runs in `prisma.$transaction(async tx => …)`: `SELECT id FROM "Chat" WHERE id = $1 FOR UPDATE` (throws `EntityNotFoundError('Chat', id)` when no row), `SELECT COALESCE(MAX(seq),0)+1 AS next FROM "Message" WHERE "chatId" = $1`, insert with `content = redactor.redact(content)`; `listByChat(chatId, { limit?, before? })` returns ascending `seq`, `before` meaning `seq < before`, `limit` applied to the **latest** messages before the cursor (query desc + reverse)
- [x] `PrismaTurnRepository`: `create` (QUEUED, `model`, optional `queueJobId`), `get`, `setStatus(id, status, { error? })` sets `startedAt` on first `PREPARING`/`RUNNING`, `finishedAt` on terminal statuses, redacts `error`; `finish(id, { status, usage, stepCount, error? })`; `listByChat` ordered by `queuedAt` asc; `attachWorkspace(id, workspaceId)` if declared in the port
- [x] `@db` suites cover every method above, including: 20 concurrent `append` via `Promise.all` yield `seq` 1..20 with no gaps or duplicates; `append` to a missing chat throws `EntityNotFoundError`; `content` containing `GITHUB_CANARY` is stored as `[REDACTED]` (asserted with `rawSelect`, not through the mapper); `list('ARCHIVED')` filters; `delete` removes messages and turns (counted via `countRows`)
- [x] 100 % coverage on the three repository files when run with `DATABASE_URL`

**Files to create/modify**
`packages/core/src/persistence/repositories/{chat.repository,chat.repository.integration.test,message.repository,message.repository.integration.test,turn.repository,turn.repository.integration.test}.ts`.

**Agent prompt**

````
You are a senior backend engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Postgres 18 · Prisma 7.9 (`prisma-client` generator, `@prisma/adapter-pg`; interactive transactions via `prisma.$transaction(async (tx) => …)`; raw SQL via tagged `$queryRaw`/`$executeRaw`) · Vitest 4.
Branch feat/w1e-persistence (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-E — Task 1E.2 of 5 (MIDDLE)

PRECONDITIONS
- Task 1E.1 done: mappers, errors, `translatePrismaError`, `createRepositories` skeleton, `describeDb`/`seedChat`/`rawSelect`/`countRows` exist.
- Compose Postgres for `AH_INSTANCE=test` is up and migrated; `DATABASE_URL` exported in your shell.

REQUIRED READING (only these):
- packages/core/src/persistence/ports.ts (`ChatRepository`, `MessageRepository`, `TurnRepository` JSDoc — implement exactly those signatures)
- packages/core/src/persistence/repositories/{mappers,errors,prisma-errors,index}.ts (Task 1E.1 output)
- packages/core/src/persistence/testing/db.ts
- packages/core/src/testing/in-memory-repositories.ts (behavioural parity: same ordering, same null/throw decisions)
- packages/core/src/testing/canaries.ts
- docs/spec/02-data-model.md § "2. Prisma schema draft" (Chat, Message, Turn), § "3. Invariants" items 1 and 5

TASK
Implement `PrismaChatRepository`, `PrismaMessageRepository` and `PrismaTurnRepository` with redact-on-write and a gap-free message sequence under concurrency, each with a `@db` integration suite proving every method and invariant.

DELIVERABLES

1. `chat.repository.ts` — `export class PrismaChatRepository implements ChatRepository` with constructor `(private readonly prisma: PrismaClient)` (no redaction needed in Chat columns — title/repoUrl/branches are user-controlled identifiers; do NOT redact them). Methods:
   - `create(input)` → `prisma.chat.create` with `status: 'ACTIVE'`, returns `toChat(row)`.
   - `getById(id)` → `findUnique` → `toChat` or `null`.
   - `list(status?)` → `findMany({ where: status ? { status: toPrismaChatStatus(status) } : {}, orderBy: { updatedAt: 'desc' } })`.
   - `setStatus(id, status)` → `update` with `archivedAt: status === 'ARCHIVED' ? new Date() : null`; translate `P2025` via `translatePrismaError(e, { entity: 'Chat', id })`.
   - `updateRestoreHints(id, { workBranch?, lastPushedSha? })` → build `data` only from defined keys (use `optionalToNull` only for keys explicitly present).
   - `touch(id)` → `update({ data: { updatedAt: new Date() } })`.
   - `delete(id)` → `prisma.chat.delete`; P2025 → `EntityNotFoundError`.
2. `message.repository.ts` — `PrismaMessageRepository(prisma, redactor)`:
   - `append(chatId, role, content, turnId?)`:
     ```ts
     return this.prisma.$transaction(async (tx) => {
       const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Chat" WHERE id = ${chatId} FOR UPDATE`;
       if (locked.length === 0) throw new EntityNotFoundError('Chat', chatId);
       const [next] = await tx.$queryRaw<{ next: number }[]>`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM "Message" WHERE "chatId" = ${chatId}`;
       const row = await tx.message.create({ data: { chatId, seq: next?.next ?? 1, role: toPrismaMessageRole(role), content: this.redactor.redact(content), turnId: turnId ?? null } });
       return toMessage(row);
     });
     ```
     Postgres may return `next` as a `number` (int4). Assert the type in the test rather than guessing; if it comes back as `bigint`, convert with `Number(...)` at this single point. Use the default isolation level (READ COMMITTED is sufficient because the `FOR UPDATE` lock serialises appends per chat).
   - `listByChat(chatId, { limit?, before? })` → `findMany({ where: { chatId, ...(before !== undefined ? { seq: { lt: before } } : {}) }, orderBy: { seq: 'desc' }, take: limit })` then `.reverse()` so the result is ascending. Without `limit` return all ascending.
3. `turn.repository.ts` — `PrismaTurnRepository(prisma, redactor)`:
   - `create({ chatId, model, queueJobId? })` → status `QUEUED`, `queuedAt` default.
   - `get(id)` → `toTurn` or `null`.
   - `setStatus(id, status, opts?)` → data: `status`; if status ∈ {`PREPARING`,`RUNNING`} and the row has no `startedAt` → `startedAt: now` (read-then-update inside `$transaction` or use `updateMany` with `startedAt: null` condition followed by `update` — keep it to one round-trip where possible); if status ∈ {`SUCCEEDED`,`FAILED`,`CANCELLED`} → `finishedAt: now`; `error: redactor.redact(opts.error)` when provided. Also accept `workspaceId` and `queueJobId` if the port declares them on this method.
   - `finish(id, { status, usage: { inputTokens, outputTokens }, stepCount, error? })` → terminal update in one `update` call with redacted `error`.
   - `listByChat(chatId)` → ordered by `queuedAt` asc.
   - Any other method declared by the port (e.g. `attachWorkspace`) — implement faithfully to its JSDoc.
4. `@db` suites (`*.integration.test.ts`, wrapped in `describeDb(...)`, `beforeEach(truncateAll)`):
   - Chat: create → getById round-trip (fields equal, `status 'ACTIVE'`, `archivedAt undefined`); `list()` ordering by `updatedAt` desc (touch the older one and assert it moves first); `list('ARCHIVED')` after `setStatus`; `setStatus('ARCHIVED')` sets `archivedAt`, back to `ACTIVE` clears it; `updateRestoreHints` with only `lastPushedSha` leaves `workBranch` untouched; `delete` cascades Messages and Turns (`countRows` → 0) and sets `Workspace.chatId` to null for a workspace of that chat (create one directly with Prisma in the test); `setStatus`/`delete` on unknown id → `EntityNotFoundError`.
   - Message: `append` three messages → `seq` 1,2,3 and `listByChat` ascending; `listByChat(chatId, { limit: 2 })` → the last two; `{ before: 3 }` → 1,2; `{ before: 3, limit: 1 }` → [2]; `Promise.all` of 20 `append` calls → `seq` set equals `1..20` exactly and `@@unique([chatId, seq])` never fires; second chat has its own sequence; append to missing chat → `EntityNotFoundError` and no row written; content with `GITHUB_CANARY` and `OPENAI_CANARY` → `rawSelect` of `content` contains `[REDACTED]` and `assertNoCanary(content)` passes; `turnId` round-trips and becomes `undefined` when the turn is deleted (SetNull).
   - Turn: create → QUEUED, `stepCount 0`; `setStatus('PREPARING')` sets `startedAt`; a later `setStatus('RUNNING')` keeps the original `startedAt`; `finish` with SUCCEEDED sets `finishedAt`, tokens, `stepCount`; `finish` with FAILED and an error containing a canary → raw `error` column redacted; `listByChat` order; `get` unknown → null; `setStatus` unknown → `EntityNotFoundError`.

Constraints:
- Follow /bymax-workflow:standards (JSDoc + headers, English, no enum, no suppression, it() comments).
- Owned paths only; no new dependencies; no schema/migration changes.
- Redaction happens in the repository and only in the repository; callers pass plaintext. Never redact ids, URLs, branch names.
- Integration suites must be deterministic: truncate before each test; never depend on ordering of `Promise.all` resolution.

Verification:
- `DATABASE_URL=postgresql://ah:ah@127.0.0.1:3201/agent_hangar_test pnpm --filter @agent-hangar/core test -- --coverage` — `@db` suites green; 100 % on chat/message/turn repository files
- `pnpm --filter @agent-hangar/core test` without DATABASE_URL — still green (suites skipped with the warning, thresholds pass)
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1e-persistence.md; append `- 1E.2 ✅ <date> — <summary>`; commit `feat(core): implement chat, message and turn repositories with gap-free seq`.
````

---

## Task 1E.3 — `WorkspaceRepository` (partial-unique → typed error), `ScheduledJobRepository`, `JobRunRepository` + `@db` suites

**Status:** ✅ Done · **Priority:** P0 · **Size:** L · **Depends on:** 1E.1

**Description.** Implement the workspace and scheduling repositories. `WorkspaceRepository` must surface the "one live workspace per chat" partial unique index as `LiveWorkspaceConflictError`, expose `findLiveByChat` and the idle-TTL query `listIdle(before)`. `JobRunRepository` must surface the `workspaceId` unique constraint and provide `findRunningByJob` for the overlap policy.

**Acceptance criteria**
- [x] `PrismaWorkspaceRepository`: `create` (status `CREATING`, `lastActiveAt = now`) translating the partial-index violation into `LiveWorkspaceConflictError`; `get`; `findLiveByChat(chatId)` (status ∈ CREATING/READY/BUSY/STOPPING, null otherwise); `setStatus(id, status, { runnerRef?, failureReason? })` sets `readyAt` on READY (first time), `destroyedAt` on DESTROYED, redacts `failureReason`, always bumps `lastActiveAt` when entering READY from BUSY; `touch(id)` updates `lastActiveAt`; `listIdle(before)` (READY and `lastActiveAt < before`, ordered asc); `listLive()`
- [x] `PrismaScheduledJobRepository`: `create`, `update` (partial), `get`, `list` (ordered by `createdAt` asc), `delete` (cascades runs), `listEnabled`, `setRunTimes(id, { lastRunAt?, nextRunAt? })`
- [x] `PrismaJobRunRepository`: `create` (QUEUED, `trigger`, `model`, `scheduledFor`), `setStatus` (startedAt/finishedAt rules as Turn), `finish(id, { status, output?, error?, usage, stepCount })` redacting `output` and `error`, `attachWorkspace(id, workspaceId)` translating the unique violation to `UniqueViolationError('workspaceId')`, `listByJob` (queuedAt desc), `get`, `findRunningByJob(jobId)` (PREPARING or RUNNING)
- [x] `@db` suites: second live workspace for one chat → `LiveWorkspaceConflictError` (and the exact Prisma `meta` shape is pinned in `prisma-errors.test.ts`); after the first becomes `DESTROYED` a new one is accepted; two `JOB` workspaces with `chatId = null` coexist; `listIdle` returns only READY rows older than the cutoff; `failureReason` canary redacted (raw select); job delete cascades runs; `findRunningByJob` returns null once finished; two runs attaching the same workspace → `UniqueViolationError`
- [x] 100 % coverage on the three repository files with `DATABASE_URL`

**Files to create/modify**
`packages/core/src/persistence/repositories/{workspace.repository,workspace.repository.integration.test,scheduled-job.repository,scheduled-job.repository.integration.test,job-run.repository,job-run.repository.integration.test}.ts`, `prisma-errors.ts` + test (pin the observed `meta` shape).

**Agent prompt**

````
You are a senior backend engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Postgres 18 · Prisma 7.9 (adapter-pg) · Vitest 4.
Branch feat/w1e-persistence (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-E — Task 1E.3 of 5 (MIDDLE)

PRECONDITIONS
- Task 1E.1 done (1E.2 may be in progress in the same branch — it touches different files).
- Compose Postgres for `AH_INSTANCE=test` is up and migrated; `DATABASE_URL` exported.

REQUIRED READING (only these):
- packages/core/src/persistence/ports.ts (`WorkspaceRepository`, `ScheduledJobRepository`, `JobRunRepository`)
- packages/core/src/workspace/types.ts (`WorkspaceStatus`, `WorkspaceKind`, `JobRunStatus`, `JobRunTrigger`)
- packages/core/src/persistence/repositories/{mappers,errors,prisma-errors}.ts
- packages/core/prisma/migrations/0001_init/migration.sql (the partial unique index statement — its name is `Workspace_one_live_per_chat`)
- packages/core/src/testing/in-memory-repositories.ts (parity)
- docs/spec/02-data-model.md § "3. Invariants" items 2 and 3; § "5. Retention"
- docs/spec/04-flows.md (c) "Guarantees" (overlap policy needs `findRunningByJob`)

TASK
Implement `PrismaWorkspaceRepository`, `PrismaScheduledJobRepository` and `PrismaJobRunRepository` with typed errors for the two uniqueness invariants, plus their `@db` suites.

DELIVERABLES

1. `workspace.repository.ts` — `PrismaWorkspaceRepository(prisma, redactor)`:
   - `LIVE_WORKSPACE_STATUSES = ['CREATING','READY','BUSY','STOPPING'] as const` exported (W2-B's GC reuses it).
   - `create({ kind, chatId?, runnerKind, image, repoUrl, branch })` → `prisma.workspace.create` with `status 'CREATING'`; wrap in `try/catch` → `translatePrismaError(e, { entity: 'Workspace', id: chatId ?? 'none' })` so the partial-index P2002 becomes `LiveWorkspaceConflictError(chatId)`.
   - `get(id)`, `findLiveByChat(chatId)` → `findFirst({ where: { chatId, status: { in: LIVE_WORKSPACE_STATUSES } } })`.
   - `setStatus(id, status, opts?: { runnerRef?: string; failureReason?: string })` → single `update` with: `status`; `runnerRef` when given; `readyAt: now` when status is READY and `readyAt` is null (use `updateMany`-style guard or read first inside `$transaction`); `destroyedAt: now` when DESTROYED; `failureReason: redactor.redact(...)` when given; `lastActiveAt: now` whenever status is READY or BUSY. P2025 → `EntityNotFoundError`.
   - `touch(id)` → `lastActiveAt: now`.
   - `listIdle(before: Date)` → `findMany({ where: { status: 'READY', lastActiveAt: { lt: before } }, orderBy: { lastActiveAt: 'asc' } })`.
   - `listLive()` → all rows with status in `LIVE_WORKSPACE_STATUSES`, ordered by `createdAt` asc.
2. `scheduled-job.repository.ts` — `PrismaScheduledJobRepository(prisma)` (no redaction: `prompt` is user input shown back to the user; `name`, `cron`, `timezone`, `repoUrl`, `branch` are identifiers):
   - `create(input)`, `update(id, partial)` (only defined keys), `get`, `list` (createdAt asc), `delete` (P2025 → EntityNotFoundError), `listEnabled` (`enabled: true`, ordered by createdAt asc), `setRunTimes(id, { lastRunAt?, nextRunAt? })`.
3. `job-run.repository.ts` — `PrismaJobRunRepository(prisma, redactor)`:
   - `create({ jobId, trigger, model, scheduledFor })` → QUEUED.
   - `attachWorkspace(id, workspaceId)` → `update({ data: { workspaceId } })`; P2002 on `workspaceId` → `UniqueViolationError('workspaceId')`.
   - `setStatus(id, status, { error? })` with the same startedAt/finishedAt rules as Turn (1E.2) and redacted `error`.
   - `finish(id, { status, output?, error?, usage, stepCount })` → redact `output` and `error`.
   - `listByJob(jobId)` → `queuedAt` desc; `get`; `findRunningByJob(jobId)` → `findFirst({ where: { jobId, status: { in: ['PREPARING','RUNNING'] } }, orderBy: { queuedAt: 'desc' } })`.
   - If the port merges `create` + `attachWorkspace` or names them differently, follow the port.
4. Pin the Prisma error shape: in `workspace.repository.integration.test.ts` first write the test that inserts two live workspaces for one chat and log the caught error's `code`, `meta` and `message` once; then update `prisma-errors.ts`/`prisma-errors.test.ts` so the translator matches that exact shape (the partial index is created by raw SQL in the migration, so Prisma may report `meta.target` as undefined and only mention the index name in `message` — handle both). Remove the log before committing.
5. `@db` suites:
   - Workspace: create → CREATING, `lastActiveAt` set, `readyAt undefined`; `findLiveByChat` finds CREATING/READY/BUSY/STOPPING and not DESTROYED/FAILED (loop over statuses); second live create for the same chat → `LiveWorkspaceConflictError` with `chatId`; after `setStatus(first, 'DESTROYED')` a new create succeeds; two `JOB` workspaces with no chat coexist; `setStatus('READY', { runnerRef })` sets `readyAt` once and `runnerRef`; BUSY → READY bumps `lastActiveAt`; `setStatus('FAILED', { failureReason: OPENAI_CANARY })` → raw column `[REDACTED]`; `listIdle(cutoff)` returns only READY rows with `lastActiveAt < cutoff` in ascending order (set `lastActiveAt` directly with Prisma in the test); `listLive` excludes DESTROYED; unknown id → `EntityNotFoundError`/null per port.
   - ScheduledJob: CRUD round-trip; `update` partial keeps other fields; `listEnabled` excludes disabled; `setRunTimes`; `delete` cascades JobRuns (`countRows('JobRun')` → 0); unknown → error/null per port.
   - JobRun: create → QUEUED with `scheduledFor`; `attachWorkspace` twice with the same workspace on two runs → `UniqueViolationError('workspaceId')`; `setStatus('RUNNING')` sets `startedAt`; `finish` SUCCEEDED sets output/usage/finishedAt; `finish` FAILED with `error` and `output` containing canaries → both raw columns redacted; `findRunningByJob` → the RUNNING run, null after finish; `listByJob` newest first; deleting the workspace sets `workspaceId` to null (SetNull) — verify via Prisma delete in the test.

Constraints:
- Follow /bymax-workflow:standards (JSDoc + headers, English, no enum, no suppression, it() comments).
- Owned paths only; no new deps; no schema/migration changes (if you find the schema lacks an index you need, note it in the PR description).
- `LIVE_WORKSPACE_STATUSES` is the single definition of "live" in the persistence layer; do not duplicate the list in queries.

Verification:
- `DATABASE_URL=… pnpm --filter @agent-hangar/core test -- --coverage` — `@db` suites green; 100 % on workspace/scheduled-job/job-run repository files and on prisma-errors.ts
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1e-persistence.md; append `- 1E.3 ✅ <date> — <summary>`; commit `feat(core): implement workspace, scheduled-job and job-run repositories`.
````

---

## Task 1E.4 — `ToolCallLogRepository`, `SecretRepository`, cross-repository invariant suite

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 1E.2, 1E.3

**Description.** Implement the last two repositories and add one integration suite that exercises the data-model invariants across repositories: cascades end to end (Chat → Turn → ToolCallLog; ScheduledJob → JobRun → ToolCallLog; Workspace → ToolCallLog), the canary-never-stored guarantee for every redacted column in one place, and the factory `createRepositories` wiring.

**Acceptance criteria**
- [x] `PrismaToolCallLogRepository`: `start({ workspaceId, turnId? | jobRunId?, callId, seq, toolName, args })` with `args = redactor.redactJson(args)`; `finish(id | { turnId/jobRunId, callId }, { status, exitCode?, resultHead?, resultBytes?, durationMs })` with `resultHead` redacted and truncated to `RESULT_HEAD_MAX_BYTES`; `listByTurn(turnId)` and `listByJobRun(jobRunId)` ordered by `seq` asc
- [x] `PrismaSecretRepository`: `upsert(key, envelope)` (ciphertext/iv/authTag as `Uint8Array`, `keyVersion`, `last4`) creating or replacing the single row per key; `get(key)` → envelope or null; `remove(key)` idempotent (no throw when missing); `status()` → `Record<SecretKey, { set, last4?, updatedAt? }>` with both keys always present
- [x] `invariants.integration.test.ts`: canary matrix (each redacted column written via its repository with both canaries → raw select shows `[REDACTED]`, and a raw `SELECT` across all text columns of all tables finds no canary substring), cascade chains, `createRepositories(prisma, redactor)` returns working instances for all eight ports
- [x] 100 % coverage on `tool-call-log.repository.ts`, `secret.repository.ts`, `index.ts`; `persistence/testing/db.ts` fully covered by the combined runs

**Files to create/modify**
`packages/core/src/persistence/repositories/{tool-call-log.repository,tool-call-log.repository.integration.test,secret.repository,secret.repository.integration.test,invariants.integration.test}.ts`, `index.ts` (wire the real classes).

**Agent prompt**

````
You are a senior backend engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Postgres 18 · Prisma 7.9 (adapter-pg; `Bytes` ↔ `Uint8Array`; `Json` ↔ `InputJsonValue`) · Vitest 4.
Branch feat/w1e-persistence (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-E — Task 1E.4 of 5 (MIDDLE)

PRECONDITIONS
- Tasks 1E.1–1E.3 done: six repositories implemented and green against compose Postgres.

REQUIRED READING (only these):
- packages/core/src/persistence/ports.ts (`ToolCallLogRepository`, `SecretRepository`)
- packages/core/src/secrets/types.ts (`SecretKey`; the envelope fields the port expects)
- packages/core/src/persistence/repositories/{mappers,errors,index}.ts
- packages/core/src/testing/canaries.ts (`GITHUB_CANARY`, `OPENAI_CANARY`, `assertNoCanary`)
- docs/spec/02-data-model.md § "2" (ToolCallLog, Secret), § "3. Invariants" items 1 and 4, § "4" (what restore reads from ToolCallLog)

TASK
Implement the tool-call log and secret repositories, wire `createRepositories`, and add the cross-repository invariant suite that proves redaction and cascades for the whole persistence layer in one place.

DELIVERABLES

1. `tool-call-log.repository.ts` — `PrismaToolCallLogRepository(prisma, redactor)`:
   - `start(input)` → `create` with `status 'RUNNING'`, `args: toInputJson(redactor.redactJson(input.args))` where `toInputJson` is a small helper in `mappers.ts` that narrows `unknown` to Prisma's `InputJsonValue` (objects/arrays/strings/numbers/booleans/null; `undefined` inside objects is dropped via `JSON.parse(JSON.stringify(...))` — document the cost). Exactly one of `turnId`/`jobRunId` is set; throw `PersistenceMappingError` if both or neither (defensive; the port may already make this impossible via a union).
   - `finish(ref, result)` — `ref` is whatever the port declares (row id, or `{ turnId, callId }` / `{ jobRunId, callId }`); set `status`, `exitCode`, `resultBytes`, `durationMs`, `finishedAt: now`, `resultHead: truncateResultHead(redactor.redact(resultHead))` when provided. Missing row → `EntityNotFoundError('ToolCallLog', …)`.
   - `listByTurn(turnId)` / `listByJobRun(jobRunId)` → ordered by `seq` asc, mapped with `toToolCallLog`.
2. `secret.repository.ts` — `PrismaSecretRepository(prisma)` (no redactor: the repository stores only ciphertext envelopes; plaintext never reaches it — state this in the file header):
   - `upsert(key, envelope)` → `prisma.secret.upsert({ where: { key }, create: {...}, update: {...} })` where `ciphertext`, `iv`, `authTag` are `Uint8Array` (pass through; do not `Buffer.from`), `keyVersion`, `last4`.
   - `get(key)` → `toSecretEnvelope(row)` or `null`.
   - `remove(key)` → `deleteMany({ where: { key } })` (idempotent; no P2025).
   - `status()` → `findMany()` then build the record for BOTH keys (`GITHUB_PAT`, `OPENAI_API_KEY`) — missing → `{ set: false }`, present → `{ set: true, last4, updatedAt }`. Never include ciphertext or iv.
3. `index.ts` — replace the stubs: `createRepositories` now constructs the real classes; export `Repositories`. Add a smoke assertion in `invariants.integration.test.ts` that every property is an instance of its class.
4. `@db` suites:
   - ToolCallLog: `start` → RUNNING with `seq`, `args` stored redacted (write `{ command: `echo ${GITHUB_CANARY}` }` → raw JSON text contains `[REDACTED]`, not the canary); `finish` SUCCEEDED with `resultHead` of 20 KB → stored length ≤ 8 KB, `resultBytes` = original length; `resultHead` containing `OPENAI_CANARY` → redacted; `finish` TIMED_OUT with `exitCode null`; `listByTurn` ascending `seq`; a log attached to a job run appears in `listByJobRun` and not in `listByTurn`; `finish` on unknown → `EntityNotFoundError`.
   - Secret: `upsert` twice for the same key → `countRows('Secret')` stays 1 and `updatedAt` advances, bytes equal the second envelope (compare with `Buffer.compare` or element-wise); `get` missing → null; `remove` missing → resolves; `status()` with none/one/both set — shape has both keys and never a `ciphertext` property (assert `Object.keys`).
   - `invariants.integration.test.ts` (title `@db persistence invariants`):
     a. Canary matrix: through the repositories write `Message.content`, `Turn.error` (via `finish`), `Workspace.failureReason`, `JobRun.output` + `error`, `ToolCallLog.args` + `resultHead` each containing `${GITHUB_CANARY} and ${OPENAI_CANARY}`; then run ONE raw query per table selecting those columns as text and assert `assertNoCanary` passes on every value and each contains `[REDACTED]`.
     b. Cascade chain 1: Chat → Turn → ToolCallLog (+ Workspace of that chat): `chats.delete` → 0 Messages, 0 Turns, 0 ToolCallLogs for that turn; Workspace row remains with `chatId` null.
     c. Cascade chain 2: ScheduledJob → JobRun → ToolCallLog: `scheduledJobs.delete` → 0 JobRuns, 0 ToolCallLogs.
     d. Cascade chain 3: deleting a Workspace (via Prisma directly — no port deletes workspaces) removes its ToolCallLogs and nulls `Turn.workspaceId`/`JobRun.workspaceId`.
     e. Factory: `createRepositories(prisma, redactor)` has the same keys as `createInMemoryRepositories(new FakeClock())` (`Object.keys(...).sort()` equal) — this guards the swap in W2-A/W2-B.
   - Use a real `Redactor`: if W1-A's implementation is already on main import it from `src/redaction`; otherwise build a minimal inline `Redactor` in the test (`redact = s => s.replaceAll(GITHUB_CANARY, '[REDACTED]').replaceAll(OPENAI_CANARY, '[REDACTED]')`, `redactJson` via JSON round-trip) — the repositories must behave identically with either.

Constraints:
- Follow /bymax-workflow:standards (JSDoc + headers, English, no enum, no suppression, it() comments).
- Owned paths only; no new deps; no schema changes.
- `Bytes` stay `Uint8Array` end to end; `Json` never stores `undefined`.

Verification:
- `DATABASE_URL=… pnpm --filter @agent-hangar/core test -- --coverage` — all `@db` suites green; 100 % on `src/persistence/repositories/**` and `src/persistence/testing/**`
- `pnpm --filter @agent-hangar/core test -- --coverage` without DATABASE_URL — green (unit-only thresholds)
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1e-persistence.md; append `- 1E.4 ✅ <date> — <summary>`; commit `feat(core): implement tool-call-log and secret repositories; add persistence invariant suite`.
````

---

## Task 1E.5 — Close-out: gates, code review, dashboard, PR

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** S · **Depends on:** 1E.1–1E.4

**Description.** Run every gate with the database available, bring the code review to zero findings, update the plan dashboard and the tasks index, and open the PR with the structured summary the orchestrator expects.

**Acceptance criteria**
- [ ] `pnpm lint && pnpm format:check && pnpm typecheck` — exit 0
- [ ] `DATABASE_URL=… pnpm --filter @agent-hangar/core test -- --coverage` — green, 100/100/100/100 on `src/persistence/repositories/**` and `src/persistence/testing/**`; `pnpm test` without `DATABASE_URL` also green
- [ ] `/bymax-quality:code-review` on the branch → zero open findings (or each remaining finding justified in the PR body)
- [ ] `docs/plan.md` §12 row W1-E → 🟨 with branch and PR number; `docs/tasks/README.md` row for this lane updated
- [ ] PR opened against `main`; structured result returned to the orchestrator

**Files to create/modify**
`docs/plan.md` (§12 row only), `docs/tasks/README.md` (W1-E row only), this file (header Status/Progress, completion log).

**Agent prompt**

````
You are a senior engineer closing out lane W1-E of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 · Node 24 · Postgres 18 · Prisma 7.9 · Vitest 4 · GitHub CLI.
Branch feat/w1e-persistence (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-E — Task 1E.5 of 5 (LAST)

PRECONDITIONS
- Tasks 1E.1–1E.4 done and committed on this branch. Compose Postgres for `AH_INSTANCE=test` is up and migrated; `DATABASE_URL` exported.

REQUIRED READING (only these):
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard"
- docs/tasks/README.md
- CLAUDE.md "Gates before any PR"

TASK
Run all gates with the database available, run the code review to zero findings, update the dashboards, and open the PR with a structured summary. Do not wait for CI; do not merge.

DELIVERABLES

1. Gates, in order, all green: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `DATABASE_URL=… pnpm --filter @agent-hangar/core test -- --coverage` (100 % on all four metrics for `src/persistence/repositories/**` and `src/persistence/testing/**`; every `@db` suite executed, none skipped — assert by grepping the reporter output for the skip warning), then `pnpm --filter @agent-hangar/core test` with `DATABASE_URL` unset (unit-only run passes its thresholds).
2. Run `/bymax-quality:code-review` on the branch range `main..HEAD` and fix every finding (CRITICAL, HIGH, MEDIUM, LOW) — no suppression comments; re-run the gates after fixes. A finding you deliberately do not fix needs a one-line justification in the PR body.
3. Update `docs/plan.md` §12 row `W1-E` → `🟨` with `feat/w1e-persistence` / PR number (fill the number after step 5 in a follow-up commit `docs: record W1-E PR in dashboard`). Update `docs/tasks/README.md` row for `wave-1e-persistence.md` → 🟨. In this file set header Status → 🟨 PR open, Progress → 5/5.
4. Verify commit history: Conventional Commits, English, no attribution trailers (`git log --format=%B main..HEAD | grep -i -E 'co-authored-by|generated with' ` must be empty).
5. Open the PR: `gh pr create --base main --head feat/w1e-persistence --title "feat(core): Prisma repositories for every persistence port (W1-E)" --body-file <generated>`. Body sections: Summary · What is implemented (one bullet per repository, the seq transaction, redact-on-write columns) · Error mapping (`LiveWorkspaceConflictError`, `UniqueViolationError`, `EntityNotFoundError`) · How to run the `@db` suites locally (`eval "$(AH_INSTANCE=test AH_PORT_BASE=3200 bash infra/scripts/env.sh --print)"`, `docker compose -f infra/docker-compose.yml up -d --wait`, `pnpm --filter @agent-hangar/core db:migrate`) · Gate results · Coverage numbers · Notes for W2-A/W2-B (`createRepositories(prisma, redactor)` shape, `LIVE_WORKSPACE_STATUSES`) · Contract change requests (empty or list).
6. Return to the orchestrator exactly: `{ pr, branch, headSha, gates: { lint, format, typecheck, unit, integration }, coverage: { lines, branches, functions, statements }, contractChangeRequests: [] }`.

Constraints:
- English; Conventional Commits; no AI attribution anywhere; owned paths only (plus the two dashboard rows listed above).
- Do not wait for CI; do not merge; do not rebase onto other lanes' branches.

Verification:
- `gh pr view --json number,headRefOid,url` — PR exists and `headRefOid` equals `git rev-parse HEAD`

Completion Protocol: append `- 1E.5 ✅ <date> — PR #<n> opened`; commit `docs: close out W1-E lane` before opening the PR (and the dashboard follow-up commit after).
````

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)
- 1E.1 ✅ 2026-08-19 — mappers, persistence errors (reusing `src/errors.ts`'s `NotFoundError`/`LiveWorkspaceExistsError`/`UniqueViolationError` plus a new `PersistenceMappingError`), `translatePrismaError`, `db.ts` test helpers (`describeDb`, `shouldRunDbSuite`, `seedChat`, `rawSelect`, `countRows`); 100 % unit coverage.
- 1E.2 ✅ 2026-08-19 — `PrismaChatRepository`, `PrismaMessageRepository` (gap-free `seq` under a `SELECT … FOR UPDATE` transaction, proven with 20 concurrent appends), `PrismaTurnRepository`; unit + `@db` suites green.
- 1E.3 ✅ 2026-08-19 — `PrismaWorkspaceRepository` (partial-unique index → `LiveWorkspaceExistsError`, pinned against the real `@prisma/adapter-pg` P2002 shape), `PrismaScheduledJobRepository`, `PrismaJobRunRepository`; unit + `@db` suites green.
- 1E.4 ✅ 2026-08-19 — `PrismaToolCallLogRepository`, `PrismaSecretRepository`, `createRepositories` wired to the real classes, cross-repository invariant suite (canary matrix, three cascade chains, factory shape parity with `createInMemoryRepositories`); unit + `@db` suites green.
