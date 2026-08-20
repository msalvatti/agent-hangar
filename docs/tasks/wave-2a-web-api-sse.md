# Wave 2 — Lane W2-A — Web API route handlers, SSE, server DI

| | |
|---|---|
| **Lane** | W2-A (one agent; runs in parallel with W2-B 🐳 and W2-C) |
| **Status** | 🟦 running |
| **Progress** | 1/6 tasks |
| **Branch** | `feat/w2a-web-api-sse` |
| **Owned paths** | `apps/web/app/api/**`, `apps/web/src/server/**` · plus, by explicit exception: `apps/web/vitest.config.ts` (`coverage.include` + test `include` globs only), `apps/web/package.json` (`scripts.test:integration` only), and **additive** lines in `packages/core/src/queues/contracts.ts`, `packages/core/src/api/contracts.ts`, `packages/core/src/config/schema.ts` (listed in Task 2A.1; every such addition is reported under `contractChangeRequests`) |
| **Depends on** | W0, W1-A (secrets/redaction/logging), W1-E (persistence repositories), W1-F (scheduling, queues) — all merged to `main` |
| **Unblocks** | W3-A (end-to-end wiring), W3-B (docs refresh) |
| **Source** | [docs/plan.md §7 W2-A](../plan.md) · spec [03 §4–6](../spec/03-interfaces.md) [04 (a)(b)(c)(d)](../spec/04-flows.md) [06 §2–3](../spec/06-testing.md) |
| **Last updated** | 2026-08-19 |

## Context

Wave 1 delivered the domain modules in `packages/core` (secrets, redaction, logging, repositories, scheduling, queue factories) and the UI against MSW mocks. This lane gives the UI a **real backend**: every HTTP route of spec 03 §4 as a Next.js 16 App Router route handler, validated with the Zod contracts frozen in W0, backed by the Prisma repositories and BullMQ producers from core, plus the two **SSE** endpoints that replay and tail the Redis Stream the worker (W2-B) writes. A small server-side DI container wires everything once per process and is injectable in tests.

When this lane merges, `NEXT_PUBLIC_API_MOCK=0` chats/jobs/settings CRUD work end-to-end against Postgres/Redis; turns stay `QUEUED` until W2-B's worker consumes them (plan §7 W2-A "DONE").

Two decisions are taken here and must be stated in the PR description:

1. **GitHub PAT on the web side.** `/api/repos` and `/api/repos/branches` need the PAT to call `api.github.com`. Spec 03 §6 marks `SecretsService.reveal` as worker-only. For a local single-user app, routing the repo picker through the worker (BullMQ request/response) is not worth its complexity, so **`reveal('GITHUB_PAT')` is called in exactly one web module, `apps/web/src/server/github.ts`**, per request, held only in the local variable that builds the `Authorization` header, never stored on an object, never returned to the client, never logged (the logger is built with the core `Redactor`, and the GitHub error messages are passed through `redactor.redact` before leaving the module). No other file under `apps/web` may import or call `reveal`; Task 2A.1 adds a unit test that greps `apps/web/src` and `apps/web/app` for `.reveal(` and asserts the only hit is `src/server/github.ts`.
2. **Worker health over Redis.** `/api/health` reports Docker reachability and the workspace image without talking to Docker from the web process: the worker writes a heartbeat key `health:worker:<instance>` (TTL 90 s, every 30 s) with `{ at, dockerOk, imagePresent, containers }`. The key name, TTL, interval and payload schema are added **additively** to `packages/core/src/queues/contracts.ts` in this lane (Task 2A.1); W2-B implements the writer. Live-workspace counters come from the DB (`WorkspaceRepository.listLive`) so they are exact and do not lag behind the heartbeat.

## Rules of this lane

1. **Owned paths only** (table above). The three core files may receive **additive** exports only (new constants/schemas/optional fields); never rename or change existing exports. Every addition is listed in the final `contractChangeRequests` with the consumer lane named.
2. **No new dependencies.** Everything needed (`next`, `ioredis`, `bullmq`, `zod`, `pino`, `@agent-hangar/core`) was installed in W0. If something is missing, stop and report.
3. **`reveal` is web-forbidden except in `src/server/github.ts`** (decision 1 above). Settings routes use `status`/`set`/`remove` only.
4. **Handlers are pure functions of `(container, request, params)`** living in `apps/web/src/server/handlers/**`; files under `app/api/**` are ≤ 12-line wiring modules that call `getServerContainer()`. This is what makes 100 % coverage with injected fakes possible.
5. **Coverage:** extend `apps/web/vitest.config.ts` `coverage.include` with `'app/api/**'` and `'src/server/**'` (thresholds stay 100/100/100/100). Server tests run in the `node` environment via the `/** @vitest-environment node */` docblock on each test file (this is a documented Vitest directive, not a suppression comment).
6. **Tests are unit + `@redis` integration.** Unit tests use `createTestContainer()` (in-memory repositories from `@agent-hangar/core/testing`, `FakeQueue`, `FakeRedis`, `FakeSecretsService`, scripted GitHub fetch). The SSE integration suite runs against compose Redis (`REDIS_URL`), following the same gating convention W0 Task 0.5 established for `@db` tests: included in `pnpm test` when `REDIS_URL` is set, run by `pnpm test:integration` otherwise, **fails loudly** (never skips) when `CI=1` and Redis is unreachable.
7. Canaries only: any test that needs a secret-looking value uses `GITHUB_CANARY`/`OPENAI_CANARY` from `@agent-hangar/core/testing`, and settings tests assert with `assertNoCanary` that responses and logs never contain them.
8. Standards: TypeScript strict, no `enum`, no suppression comments (`eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`), JSDoc on every export + file header, test-file header + block comment on every `it()`, English only, Conventional Commits, no AI-attribution trailers. Branch `feat/w2a-web-api-sse`, one PR at the end (Task 2A.6).

## Reference docs

- [docs/plan.md](../plan.md) § "3. Parallelism rules", § "7. Wave 2" (W2-A), § "11. Orchestrator protocol", § "12. Status dashboard"
- [spec 03 — Interface contracts](../spec/03-interfaces.md) § "4. HTTP API" (routes, SSE framing), § "5. Queue contracts", § "6. Secrets service"
- [spec 04 — Sequence flows](../spec/04-flows.md) (a) steps 1–7 and "Edge cases" (cancel, reconnect), (b) archive/restore web steps, (c) job create/run web steps, (d) "SAVE" and "Controls, end to end" (Transport row)
- [spec 06 — Testing](../spec/06-testing.md) § "2. Unit tests" (`apps/web`), § "3. Integration tests" (SSE endpoint), § "7. Test doubles"
- [spec 02 — Data model](../spec/02-data-model.md) § "2. Prisma schema draft" (field names used in responses), § "3. Invariants"
- Code you implement against (read before writing): `packages/core/src/api/contracts.ts`, `packages/core/src/queues/contracts.ts`, `packages/core/src/queues/{queues,schedulers}.ts`, `packages/core/src/persistence/{ports.ts,repositories/index.ts,client.ts}`, `packages/core/src/secrets/index.ts`, `packages/core/src/redaction/index.ts`, `packages/core/src/logging/index.ts`, `packages/core/src/scheduling/index.ts`, `packages/core/src/restore/index.ts`, `packages/core/src/config/{schema,instance}.ts`, `packages/core/src/errors.ts`, `packages/core/src/testing/index.ts`, `apps/web/src/shared/api/client.ts`, `apps/web/src/mocks/**` (W1-G/H MSW handlers — the tie-breaker for response shapes the UI already consumes)

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 2A.1 | Server DI container, HTTP helpers, test container, GitHub client, additive core contracts | ✅ | P0 | M | — |
| 2A.2 | Chats, messages, archive/restore, delete, turn cancel routes | 📋 | P0 | M | 2A.1 |
| 2A.3 | Jobs CRUD + manual run, runs list/detail, repos + branches routes | 📋 | P0 | M | 2A.1 |
| 2A.4 | Settings (status/set/remove, no request logging) and health routes | 📋 | P0 | S | 2A.1 |
| 2A.5 | SSE: stream factory, `chats/[id]/events`, `runs/[id]/events`, `@redis` integration | 📋 | P0 | L | 2A.1, 2A.2 |
| 2A.6 | Close-out: gates, code review, dashboard, PR | 📋 | P0 | S | 2A.1–2A.5 |

---

## Task 2A.1 — Server DI container, HTTP helpers, test container, GitHub client, additive core contracts

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** Build the server-side foundation every route uses: a per-process DI container (`getServerContainer()`, HMR-safe), HTTP helpers (JSON responses, Zod body/query parsing, error → status mapping), the injectable test container with fakes, the GitHub client (single permitted `reveal` site), and the small **additive** core contract changes this lane depends on (worker heartbeat key/schema, cancel command schema, `ALLOWED_REPO_HOSTS` + `GITHUB_API_BASE_URL` config vars, response schemas the routes need).

**Acceptance criteria**
- [x] `apps/web/src/server/container.ts` exports `ServerContainer`, `createServerContainer(deps?)`, `getServerContainer()` (cached on `globalThis` under a symbol so Next dev HMR reuses one Prisma/Redis/BullMQ set), `disposeServerContainer()`
- [x] `apps/web/src/server/http.ts` exports `json`, `noContent`, `errorResponse`, `parseJsonBody`, `parseQuery`, `withErrorHandling`, `ApiHttpError`, `ResourceNotFoundError`, `ConflictError`, and maps core errors to status/code as specified
- [x] `apps/web/src/server/same-origin.ts` exports `assertSameOrigin(request)` (403 `FORBIDDEN_ORIGIN`), called by every state-changing handler
- [x] `apps/web/src/server/github.ts` exports `createGithubClient` with `listRepos(query)` / `listBranches(repo)`; PAT obtained via `secrets.reveal('GITHUB_PAT')` inside the call, never stored; errors are `GithubApiError { status }` with redacted messages; a test asserts no other web file calls `.reveal(`
- [x] `apps/web/src/server/testing/{test-container,fake-queue,fake-redis,fake-secrets}.ts` provide `createTestContainer(overrides?)` built on `@agent-hangar/core/testing`
- [x] Additive core changes: `workerHeartbeatKey(instance)`, `WORKER_HEARTBEAT_TTL_SEC = 90`, `WORKER_HEARTBEAT_INTERVAL_SEC = 30`, `workerHeartbeatSchema`, `TURN_EVENT_FIELD`, `parseTurnEventEntry` in `packages/core/src/queues/contracts.ts`; `ALLOWED_REPO_HOSTS` and `GITHUB_API_BASE_URL` in `packages/core/src/config/schema.ts`; `getJob` operation and `healthResponse.ports` in `packages/core/src/api/contracts.ts` — each with tests in core, 100 %
- [x] `apps/web/vitest.config.ts` `coverage.include` extended with `'app/api/**'`, `'src/server/**'`; unit tests green at 100 % for everything created here

**Files to create/modify**
`apps/web/src/server/{container,http,github,repo-url,index}.ts` + `*.test.ts`; `apps/web/src/server/testing/{test-container,fake-queue,fake-redis,fake-secrets,index}.ts` + tests; `apps/web/src/server/reveal-policy.test.ts`; `packages/core/src/queues/contracts.ts` (+ test), `packages/core/src/config/schema.ts` (+ test), `packages/core/src/api/contracts.ts` (+ test, only if schemas are missing); `apps/web/vitest.config.ts`.

**Agent prompt**

````
You are a senior full-stack TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — a local-first web app where AI agents answer questions and perform coding tasks against GitHub repositories inside isolated, disposable Docker workspaces; plus cron-scheduled jobs that run in fresh workspaces, and a settings page with encrypted credentials (GitHub PAT, OpenAI API key).
Stack: pnpm 11 workspaces · TypeScript ~6.0.3 strict · Node 24 LTS · Next.js 16.3 App Router (route handlers, `typedRoutes`) + React 19.2 · Postgres 18 + Prisma 7.9 (adapter-pg) · Redis 8 + BullMQ 6 + ioredis 6 · Zod 4 · pino · Vitest 4.
Specification lives in docs/spec/ (01–10); execution plan in docs/plan.md. You are in a git worktree on branch feat/w2a-web-api-sse, branched off the latest main.

CURRENT LANE: W2-A (Web API routes + SSE) — Task 2A.1 of 6 (FIRST)

PRECONDITIONS
- W0, W1-A, W1-E, W1-F are merged to main; your branch is off the latest main. Verify with `git log --oneline -5 main` that the merge commits of those lanes are present; if any is missing, stop and report.
- `pnpm install --frozen-lockfile`, `pnpm db:generate`, `pnpm typecheck` pass on your branch before you start.
- Read CLAUDE.md (ownership map, gates, rules).

REQUIRED READING (only these):
- docs/plan.md § "3. Parallelism rules", § "7. Wave 2" (W2-A)
- docs/spec/03-interfaces.md § "4. HTTP API", § "5. Queue contracts", § "6. Secrets service"
- docs/spec/04-flows.md (d) "Controls, end to end" table
- docs/spec/05-local-dev.md § "3. Environment model"
- packages/core/src/api/contracts.ts, packages/core/src/queues/contracts.ts, packages/core/src/queues/queues.ts, packages/core/src/queues/schedulers.ts
- packages/core/src/persistence/ports.ts, packages/core/src/persistence/repositories/index.ts (the `createRepositories(prisma, redactor)` factory), packages/core/src/persistence/client.ts
- packages/core/src/secrets/index.ts (the service factory and `MasterKeyFile`), packages/core/src/redaction/index.ts, packages/core/src/logging/index.ts
- packages/core/src/config/schema.ts, packages/core/src/config/instance.ts, packages/core/src/errors.ts
- packages/core/src/testing/index.ts (in-memory repositories, FakeClock, canaries, `assertNoCanary`)
- apps/web/vitest.config.ts, apps/web/src/shared/api/client.ts

TASK
Create the server-side foundation of apps/web: the DI container, HTTP helpers, the injectable test container, the GitHub client, and the small additive contract changes in packages/core that this lane's routes depend on. Everything 100 % unit-tested.

DELIVERABLES

1. Additive core contracts (the ONLY edits allowed outside apps/web; additive exports only, never modify existing ones; each gets a test next to it and keeps core at 100 %):
   a. `packages/core/src/queues/contracts.ts`:
      - `workerHeartbeatKey(instance: string): string` → `health:worker:${instance}`
      - `WORKER_HEARTBEAT_TTL_SEC = 90`, `WORKER_HEARTBEAT_INTERVAL_SEC = 30`
      - `workerHeartbeatSchema = z.object({ at: z.string().datetime(), dockerOk: z.boolean(), imagePresent: z.boolean(), containers: z.number().int().nonnegative() })` + `type WorkerHeartbeat = z.infer<…>`
      - `turnCommandSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('cancel'), requestedAt: z.string().datetime() })])` + `type TurnCommand` (published on `turnCommandChannel(turnId)` as JSON)
      - `TURN_EVENT_FIELD = 'event'` and `parseTurnEventEntry(fields: readonly string[]): AgentEvent | null` — a Redis Stream entry written by the worker has the flat field list `['event', '<JSON AgentEvent>']`; the parser finds the `event` field, `JSON.parse`s it and validates with `agentEventSchema` (`safeParse`; return `null` on any failure). W2-B's publisher writes this shape; say so in JSDoc.
   b. `packages/core/src/config/schema.ts`: `ALLOWED_REPO_HOSTS` (string, default `'github.com'`, comma-separated host list; expose a parsed `allowedRepoHosts: string[]` on the loaded config if the module already derives computed fields, else add a helper `parseAllowedRepoHosts(value)` next to the schema) and `GITHUB_API_BASE_URL` (URL string, default `'https://api.github.com'`). Update `.env.example` is NOT yours (W1-I) — list it under contractChangeRequests instead.
   c. `packages/core/src/api/contracts.ts`: verify these exist and add ONLY what is missing, as optional/additive fields or new schemas: `createChatResponse` (if absent, routes return `chatDetail`), `postMessageResponse` (if absent, `chatDetail`), `cancelTurnResponse = { turnId, status: 'CANCELLED' | 'CANCEL_REQUESTED' }`, `runJobResponse = { jobId, trigger: 'MANUAL' }`, `healthResponse` fields `ok, instance, db: { ok, latencyMs? }, redis: { ok, latencyMs? }, worker: { ok, lastSeenAt?, dockerOk?, imagePresent?, containers? }, liveWorkspaces: { chat, job }, image, ports: { web, postgres, redis }` (add missing ones as optional), `settingsStatus` (`githubPat`/`openaiKey` each `{ set, last4?, updatedAt? }`, `model`), `putSecretResponse = { set: true, last4 }`. Also add to the `routes` map any path template missing for: `GET /api/jobs/:id`, `GET /api/chats/:id/events`, `GET /api/runs/:id/events`, `GET /api/health`. Check apps/web/src/mocks/** first: if W1-G/H already consume a shape, match it rather than inventing one.
2. `apps/web/src/server/container.ts`:
   ```ts
   export interface ServerContainer {
     readonly config: AppConfig;              // loadConfig() result type from core
     readonly logger: Logger;                 // core logging factory type (pino)
     readonly prisma: PrismaClient;
     readonly repos: Repositories;            // return type of createRepositories
     readonly redis: Redis;                   // shared ioredis command connection (lazyConnect)
     readonly queues: { chatTurns: Queue; scheduledJobs: Queue; workspaceGc: Queue };
     readonly secrets: SecretsService;
     readonly redactor: Redactor;
     readonly github: GithubClient;
     readonly clock: Clock;                   // core Clock ({ now(): Date })
     readonly sse: { heartbeatMs: number; blockMs: number };   // defaults 15000 / 15000
     dispose(): Promise<void>;                // closes queues, redis, prisma (idempotent)
   }
   export interface ServerContainerDeps { /* every field above, all optional, for injection */ }
   export function createServerContainer(deps?: Partial<ServerContainerDeps>): ServerContainer
   export function getServerContainer(): ServerContainer
   export async function disposeServerContainer(): Promise<void>
   ```
   `createServerContainer` builds missing pieces from core: `loadConfig()`; `createLogger(...)` with the core redactor (use the exact W1-A factory names — read `packages/core/src/logging/index.ts`); `createPrismaClient({ connectionString: config.DATABASE_URL })`; `new Redis(config.REDIS_URL, { lazyConnect: true })` (construct ioredis BY URL STRING — the options-object constructor does not type-check under `exactOptionalPropertyTypes`); queues via core `createQueue(QUEUE_NAMES.<x>, { connection })` from W1-F (read its signature); repositories via `createRepositories(prisma, redactor)`; secrets via the W1-A factory with `MASTER_KEY_PATH` from config and `repos.secrets`; `github` via `createGithubClient({ secrets, redactor, logger, baseUrl: config.GITHUB_API_BASE_URL, fetch: globalThis.fetch })`; `clock = { now: () => new Date() }`. `getServerContainer()` caches on `globalThis[Symbol.for('agent-hangar.server-container')]` so Next dev HMR does not leak connections; `disposeServerContainer()` disposes and clears the cache. No connection is opened at construction time (lazy) — the first route call connects.
3. `apps/web/src/server/http.ts`:
   - `json<T>(body: T, init?: { status?: number; headers?: HeadersInit }): Response` (JSON + `Content-Type: application/json; charset=utf-8`), `noContent(): Response` (204), `errorResponse(status, code, message): Response` with body `{ error: { code, message } }` matching `apiError`.
   - `class ApiHttpError extends Error { status; code }`, `class NotFoundError extends ApiHttpError` (404 `NOT_FOUND`), `class ConflictError extends ApiHttpError` (409, code passed in), `class ValidationError extends ApiHttpError` (400 `VALIDATION_ERROR`).
   - `parseJsonBody<T>(request, schema: ZodType<T>): Promise<T>` — invalid JSON → `ApiHttpError(400, 'INVALID_JSON')`; schema failure → `ValidationError` whose message lists `path: message` pairs (max 5, joined by `; `).
   - `parseQuery<T>(url: URL | string, schema: ZodType<T>): T` — same error mapping (`VALIDATION_ERROR`).
   - `withErrorHandling(container, fn: () => Promise<Response>): Promise<Response>` — mapping table: `ApiHttpError` → its status/code; core `InvalidCronError` → 400 `INVALID_CRON`; core `IllegalTransitionError` → 409 `ILLEGAL_TRANSITION`; core `ConfigError` → 503 `CONFIG_ERROR`; `GithubApiError` 401/403 → 401 `GITHUB_AUTH`, other → 502 `GITHUB_ERROR`; `SecretIntegrityError` → 500 `SECRET_INTEGRITY`; anything else → 500 `INTERNAL` with the generic message "Internal error" (the real message is logged at error level through the redacting logger; never echoed to the client).
   - Every response from `errorResponse` carries `Cache-Control: no-store`.
4. `apps/web/src/server/repo-url.ts`: `assertRepoUrlAllowed(url: string, allowedHosts: readonly string[]): URL` — accepts `http:`/`https:` only, no credentials in the URL (`username`/`password` empty), hostname (case-insensitive) in the allow-list, path non-empty; throws `ValidationError` with code `REPO_URL_NOT_ALLOWED` otherwise. Used by chats and jobs handlers in later tasks.
5. `apps/web/src/server/github.ts`:
   ```ts
   export interface GithubClient {
     listRepos(query: string): Promise<RepoSummary[]>;       // core repoSummary type
     listBranches(repo: string): Promise<BranchSummary[]>;   // "owner/name"
   }
   export class GithubApiError extends Error { readonly status: number }
   export function createGithubClient(deps: { secrets: SecretsService; redactor: Redactor; logger: Logger; baseUrl: string; fetch: typeof fetch }): GithubClient
   ```
   Behaviour: each method calls `deps.secrets.reveal('GITHUB_PAT')` (THE ONLY PERMITTED WEB-SIDE REVEAL — write this sentence in the file header and the JSDoc); `null` → throw `ApiHttpError(409, 'SECRETS_MISSING', 'GitHub token is not configured')`. Headers: `Authorization: Bearer <pat>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: agent-hangar`. `listRepos`: `GET {baseUrl}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`, filter client-side by `full_name` containing `query` (case-insensitive, trimmed; empty query = all), map to `repoSummary` (`fullName`, `url` = `html_url`, `defaultBranch` = `default_branch`, `private`, `updatedAt` = `pushed_at` — match the core schema field names exactly). `listBranches(repo)`: validate `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$` (else `ValidationError`), then `GET /repos/{repo}` (default branch) and `GET /repos/{repo}/branches?per_page=100`, map to `branchSummary` (`name`, `sha` = `commit.sha`, `isDefault`). Non-2xx → `GithubApiError(status, redactor.redact(text.slice(0, 200)))`. The token variable must not outlive the request function; never put it in a log, error, or closure stored on the client object.
6. `apps/web/src/server/testing/`:
   - `fake-queue.ts` — `class FakeQueue` implementing the subset of BullMQ `Queue` the routes use: `add(name, data, opts?)` (records `{ name, data, opts }` in `added[]`, returns `{ id: opts?.jobId ?? randomUUID() }`), `getJob(id)` (returns a fake job with `getState()` → `'waiting'` for ids added and not removed, else `undefined`), `remove(id)`; plus `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers` recorders if core's `upsertJobScheduler(queue, …)` wrapper calls them (read W1-F's `schedulers.ts` to see which Queue methods it uses and fake exactly those). Expose `schedulers: Map<string, unknown>`.
   - `fake-redis.ts` — `class FakeRedis` with `ping()`, `get/set(key, value, 'EX', ttl)/del/exists`, `publish(channel, msg)` (records `published[]`), `xadd(key, '*' | id, ...fields)` (in-memory stream, ids `<ms>-<seq>` monotonic from an injected clock), `xrange(key, start, end)` (supports `(`-prefixed exclusive start and `-`/`+`), `xread('BLOCK', ms, 'STREAMS', key, id)` (returns entries after `id` or resolves `null` after `await Promise.resolve()` when empty — never really blocks), `duplicate()` (returns a new FakeRedis sharing the same store), `disconnect()`/`quit()` (sets `closed = true`; a pending `xread` rejects with `Error('Connection is closed.')`). Also `expire(key, sec)` as a no-op recorder.
   - `fake-secrets.ts` — `class FakeSecretsService implements SecretsService` (in-memory map; `status()` returns `{ set, last4, updatedAt }` per key; `reveal` returns the stored plaintext; records `revealCalls: SecretKey[]`).
   - `test-container.ts` — `createTestContainer(overrides?: Partial<ServerContainerDeps> & { secretsSet?: boolean; now?: Date })`: `FakeClock`, `createInMemoryRepositories(clock)`, `FakeQueue` ×3, `FakeRedis`, `FakeSecretsService` (pre-seeded with the canaries when `secretsSet !== false`), real `Redactor` from core, a pino logger at level `silent` wrapped so tests can read `logger.entries` (or use pino's `destination` with an in-memory sink), `config` from `loadConfig({ AH_INSTANCE: 'test', DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://127.0.0.1:1', MASTER_KEY_PATH: '/dev/null', ... })`, `github` = a stub client whose results are set via `overrides.github`, `sse: { heartbeatMs: 20, blockMs: 20 }`, `dispose` no-op.
   - `index.ts` barrel.
7. `apps/web/src/server/reveal-policy.test.ts` — reads every `*.ts`/`*.tsx` under `apps/web/src` and `apps/web/app` (sync `readdir` recursion, excluding `*.test.ts`), asserts the only file containing `.reveal(` is `src/server/github.ts`.
8. `apps/web/src/server/index.ts` barrel. Extend `apps/web/vitest.config.ts`: `coverage.include` += `'app/api/**'`, `'src/server/**'`; ensure the test `include` globs cover `app/api/**/*.test.ts` and `src/server/**/*.test.ts` (jsdom stays the default environment; server test files start with `/** @vitest-environment node */`).
9. Tests (100 % on everything above): container (`createServerContainer` with injected deps uses them; `getServerContainer` caches on globalThis and `disposeServerContainer` clears; `dispose` closes queues/redis/prisma once and is idempotent — use injected fakes with `close`/`quit`/`$disconnect` spies), http (every helper, every row of the error mapping table, Zod issue formatting cap at 5, `Cache-Control: no-store`), repo-url (https github ok, http allowed host ok, credentials rejected, host not allowed, `ftp:`, empty path, case-insensitive host), github (headers incl. Bearer built from the revealed canary and never logged — capture logger output and `assertNoCanary`; empty query lists all; query filter; branches mapping with `isDefault`; invalid repo slug → 400; 401 → `GithubApiError(401)`; 500 → `GithubApiError(500)` with a message that went through `redact`; missing PAT → 409 `SECRETS_MISSING`), fakes (each method, including `xrange` exclusive start, `xread` empty → null, closed connection rejects), core additions (key format, schema accept/reject, `parseTurnEventEntry` valid/invalid JSON/unknown type/missing field, config defaults and parsing of the host list).

Constraints:
- Follow /bymax-workflow:standards: TS strict, JSDoc + file headers, English, no `enum`, no suppression comments, test headers and a block comment on every it().
- No `any`; no `process.env` reads outside `loadConfig` (the container passes config down).
- Do not open network connections in unit tests (everything injected).

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green, core still 100 %
- `pnpm --filter web test -- --coverage` — green, 100 % on `src/server/**`
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-2a-web-api-sse.md (task index row and task heading line)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/6 tasks`)
4. Append a completion log entry at the end of the file: `- 2A.1 ✅ <YYYY-MM-DD> — <one-line summary>`
5. Commits (two): `feat(core): add worker heartbeat, turn command and repo-host contracts` and `feat(web): add server container, http helpers, github client and test doubles`
````

---

## Task 2A.2 — Chats, messages, archive/restore, delete, turn cancel routes

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** M · **Depends on:** 2A.1

**Description.** Implement the chat side of spec 03 §4: create chat (+ first message + first turn + enqueue), list, detail, post message, archive (+ enqueue workspace destroy), restore (+ system notice), delete, and turn cancel via the Redis command channel. Handlers in `src/server/handlers/{chats,turns}.ts`, thin route files under `app/api/**`.

**Acceptance criteria**
- [ ] `POST /api/chats` validates `createChatRequest`, enforces repo host allow-list and secrets presence, creates Chat (title = trimmed prompt ≤ 80 chars) + Message(USER, seq 1) + Turn(QUEUED, model from config, `queueJobId = turnId`), enqueues `chat-turns`/`run-turn` `{ turnId }` with `jobId: turnId`, returns 201
- [ ] `GET /api/chats?status=ACTIVE|ARCHIVED|ALL` (default `ACTIVE`) returns `chatSummary[]` sorted by `updatedAt` desc; `GET /api/chats/:id` returns `chatDetail` (messages by `seq`, turns by `queuedAt`, tool calls per turn) or 404
- [ ] `POST /api/chats/:id/messages` → 409 `CHAT_ARCHIVED` / 409 `TURN_IN_PROGRESS` / 409 `SECRETS_MISSING` guards, else Message(USER, next seq) + Turn(QUEUED) + enqueue, 201
- [ ] `PATCH /api/chats/:id` (`renameChatRequest { title }`, trimmed, 1–120 chars → 200 `chatSummary`; 400 `VALIDATION`; 404 unknown) — frozen contract route (spec 03 §4); route file `app/api/chats/[id]/route.ts` hosts GET/PATCH/DELETE
- [ ] `POST /api/chats/:id/archive` (ACTIVE only; 409 `TURN_IN_PROGRESS` if a turn is QUEUED/PREPARING/RUNNING) → ARCHIVED + enqueue `workspace-gc`/`destroy-chat-workspace` `{ chatId }` → 200 `chatDetail`; `POST /api/chats/:id/restore` (ARCHIVED only) → ACTIVE + SYSTEM message → 200 `chatDetail`; `?warm=1` accepted and documented as a no-op in v1
- [ ] `DELETE /api/chats/:id` → 409 `TURN_IN_PROGRESS` if a turn is live; else enqueue destroy job when a live workspace exists, then cascade delete → 204
- [ ] `POST /api/turns/:id/cancel` → 404; terminal turn → 409 `TURN_NOT_CANCELLABLE`; QUEUED with a removable BullMQ job → job removed + Turn CANCELLED + 200 `{ status: 'CANCELLED' }`; otherwise PUBLISH `turnCommandSchema` `{ type: 'cancel' }` on `turnCommandChannel(turnId)` → 202 `{ status: 'CANCEL_REQUESTED' }`
- [ ] 100 % coverage on `src/server/handlers/{chats,turns}.ts` and the route files

**Files to create**
`apps/web/src/server/handlers/{chats,turns}.ts` + `*.test.ts`; `apps/web/src/server/handlers/mappers.ts` (domain → `chatSummary`/`chatDetail`) + test; `apps/web/app/api/chats/route.ts`, `app/api/chats/[id]/route.ts`, `app/api/chats/[id]/messages/route.ts`, `app/api/chats/[id]/archive/route.ts`, `app/api/chats/[id]/restore/route.ts`, `app/api/turns/[id]/cancel/route.ts`; `apps/web/app/api/routes.test.ts` (wiring test, extended by later tasks).

**Agent prompt**

````
You are a senior full-stack TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Next.js 16.3 App Router route handlers (`params` is a Promise; `RouteContext<'/api/chats/[id]'>` helper type with `typedRoutes`) · Prisma 7.9 via core repositories · BullMQ 6 · ioredis 6 · Zod 4 · Vitest 4.
Branch feat/w2a-web-api-sse (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-A — Task 2A.2 of 6 (MIDDLE)

PRECONDITIONS
- Task 2A.1 done: `ServerContainer`, `createTestContainer`, http helpers, `assertRepoUrlAllowed`, additive contracts exist.

REQUIRED READING (only these):
- docs/spec/03-interfaces.md § "4. HTTP API" (chat rows), § "5. Queue contracts" (`chat-turns`, `workspace-gc`)
- docs/spec/04-flows.md (a) steps 1–5 and "Edge cases" (Cancel), (b) ARCHIVE/RESTORE web steps
- docs/spec/02-data-model.md § "2. Prisma schema draft" (Chat, Message, Turn fields), § "3. Invariants"
- packages/core/src/api/contracts.ts (`createChatRequest`, `chatSummary`, `chatDetail`, `postMessageRequest`, `cancelTurnResponse`, `routes`), packages/core/src/queues/contracts.ts (`QUEUE_NAMES`, `JOB_NAMES`, `runTurnPayload`, `destroyChatWorkspacePayload`, `turnCommandChannel`, `turnCommandSchema`)
- packages/core/src/persistence/ports.ts (Chat/Message/Turn/Workspace/ToolCallLog repositories), packages/core/src/restore/index.ts (look for a restoration-notice builder)
- apps/web/src/server/{container,http,repo-url}.ts and apps/web/src/server/testing/index.ts (from 2A.1)
- apps/web/src/mocks/** (W1-G handlers for chats — match the response shapes the UI consumes)

TASK
Implement the chat, message, archive/restore, delete and turn-cancel routes as pure handler functions over the container, wire them into thin Next route files, and test them to 100 % with the injected test container.

DELIVERABLES

1. `apps/web/src/server/handlers/mappers.ts` — `toChatSummary(chat, lastTurn?)`, `toChatDetail({ chat, messages, turns, toolCallsByTurn })` producing objects that PASS `chatSummary.parse` / `chatDetail.parse` (call `.parse` in the mapper so a drift fails loudly in tests). Dates serialised as ISO strings if the contract says string.
2. `apps/web/src/server/handlers/chats.ts` — exported handlers, every one `(c: ServerContainer, request: Request, params?: { id: string }) => Promise<Response>` wrapped in `withErrorHandling`:
   - `createChat`: `parseJsonBody(createChatRequest)`; `assertRepoUrlAllowed(body.repoUrl, allowedHosts(c.config))`; `requireSecrets(c)` (helper in this file: `secrets.status()`; if `GITHUB_PAT` or `OPENAI_API_KEY` is unset → `ConflictError('SECRETS_MISSING', 'Configure GitHub token and OpenAI key in Settings: <missing list>')`); `title = prompt.trim().replace(/\s+/g,' ').slice(0, 80)`; `repos.chats.create({ title, repoUrl, baseBranch })`; `repos.messages.append(chatId, 'USER', prompt)`; `repos.turns.create({ chatId, model: c.config.OPENAI_MODEL, queueJobId: <turnId> })` (set `queueJobId = turn.id` — if the port's `create` cannot set it, use the id-returning create then `setStatus`/update; read the port); `c.queues.chatTurns.add(JOB_NAMES.runTurn, runTurnPayload.parse({ turnId }), { jobId: turnId, removeOnComplete: { age: 3600 }, removeOnFail: { age: 86400 } })`; respond 201 with `createChatResponse` if the contract defines it, else `chatDetail`. Order matters: DB rows first, enqueue last; if enqueue throws, mark the turn FAILED with `error: 'enqueue failed'` (repo `setStatus`/`finish`) and rethrow (500).
   - `listChats`: `parseQuery(url, z.object({ status: z.enum(['ACTIVE','ARCHIVED','ALL']).default('ACTIVE') }))`; `repos.chats.list(status === 'ALL' ? undefined : status)`; for each chat attach the latest turn status if `chatSummary` has such a field (one `repos.turns.listByChat` per chat is acceptable for v1 — document; W3-A may optimise); sort by `updatedAt` desc; 200 `chatSummary[]`.
   - `getChat`: 404 `NotFoundError` when missing; load messages (`listByChat`, all, ascending `seq`), turns (`listByChat`), tool calls per turn (`toolCalls.listByTurn`); 200 `chatDetail`.
   - `postMessage`: 404; `status !== 'ACTIVE'` → `ConflictError('CHAT_ARCHIVED', 'Restore the chat before sending messages')`; any turn with status in `['QUEUED','PREPARING','RUNNING']` → `ConflictError('TURN_IN_PROGRESS', …)`; `requireSecrets`; `parseJsonBody(postMessageRequest)`; append USER message; create Turn; enqueue as in `createChat`; `repos.chats.touch(chatId)`; 201 (`postMessageResponse` or `chatDetail`).
   - `archiveChat`: 404; not ACTIVE → `ConflictError('ILLEGAL_TRANSITION', 'Chat is not active')`; turn in progress → 409 `TURN_IN_PROGRESS`; `repos.chats.setStatus(id, 'ARCHIVED')` (sets `archivedAt`; read the port); `c.queues.workspaceGc.add(JOB_NAMES.destroyChatWorkspace, destroyChatWorkspacePayload.parse({ chatId }))` — ALWAYS enqueue (the worker decides whether a live workspace exists; it also snapshots before destroy per flow (b)); 200 `chatDetail`.
   - `restoreChat`: 404; not ARCHIVED → 409 `ILLEGAL_TRANSITION`; `setStatus(id, 'ACTIVE')`; append `Message(SYSTEM)` with the restoration notice — use the builder exported by core's restore module if one exists (e.g. `restorationNotice()` / `RESTORE_NOTICE`); otherwise the constant `CHAT_RESTORED_NOTICE = 'Chat restored. A fresh workspace will be created on your next message; uncommitted changes from the previous workspace were discarded.'` defined in this file; parse `?warm=1` with `parseQuery` (`z.object({ warm: z.enum(['0','1']).optional() })`) and ignore it — JSDoc: "v1 has no warm-up job; the next message recreates the workspace (flow (b))"; 200 `chatDetail`.
   - `deleteChat`: 404; turn in progress → 409 `TURN_IN_PROGRESS`; `const live = await repos.workspaces.findLiveByChat(id)`; if live → enqueue `destroy-chat-workspace { chatId }` BEFORE deleting (note in JSDoc + contractChangeRequests: W2-B's destroy processor must fall back to `runner.list({ 'ah.chat': chatId })` when the chat row is gone, because the FK is `SetNull`); `repos.chats.delete(id)` (cascade); 204.
3. `apps/web/src/server/handlers/turns.ts` — `cancelTurn(c, request, { id })`: `repos.turns.get(id)` → 404; status in `['SUCCEEDED','FAILED','CANCELLED']` → `ConflictError('TURN_NOT_CANCELLABLE', …)`; if status `QUEUED`: `const job = await c.queues.chatTurns.getJob(turn.id)`; if job and `await job.getState()` is `'waiting'|'delayed'|'prioritized'` → `await job.remove()`, `repos.turns.setStatus(id, 'CANCELLED')` (and `finish` if the port requires), return 200 `cancelTurnResponse { turnId, status: 'CANCELLED' }`; in every other live case (QUEUED-but-active, PREPARING, RUNNING): `await c.redis.publish(turnCommandChannel(id), JSON.stringify(turnCommandSchema.parse({ type: 'cancel', requestedAt: c.clock.now().toISOString() })))` and return 202 `{ turnId, status: 'CANCEL_REQUESTED' }` (the worker signals INT and persists CANCELLED — flow (a) edge case "Cancel").
4. Route files (each ≤ 12 lines; `export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';`):
   ```ts
   // apps/web/app/api/chats/[id]/archive/route.ts
   import { getServerContainer } from '@/server/container';
   import { archiveChat } from '@/server/handlers/chats';
   export const runtime = 'nodejs';
   export const dynamic = 'force-dynamic';
   export const POST = async (request: Request, ctx: RouteContext<'/api/chats/[id]/archive'>) =>
     archiveChat(getServerContainer(), request, await ctx.params);
   ```
   Create: `app/api/chats/route.ts` (GET list, POST create), `app/api/chats/[id]/route.ts` (GET, DELETE), `app/api/chats/[id]/messages/route.ts` (POST), `app/api/chats/[id]/archive/route.ts` (POST), `app/api/chats/[id]/restore/route.ts` (POST), `app/api/turns/[id]/cancel/route.ts` (POST). If `RouteContext` is not exported by the installed Next version, type the second argument as `{ params: Promise<{ id: string }> }`.
5. Tests:
   - `chats.test.ts` / `turns.test.ts` (`/** @vitest-environment node */`): build `createTestContainer()` per test; call handlers with `new Request('http://localhost/api/chats', { method: 'POST', body: JSON.stringify(...), headers: { 'content-type': 'application/json' } })`. Cases: create → 201, rows exist (chat title trimmed/80 chars, USER message seq 1, turn QUEUED with `queueJobId`), `FakeQueue.added[0]` is `{ name: 'run-turn', data: { turnId }, opts.jobId === turnId }`; invalid body → 400 `VALIDATION_ERROR`; invalid JSON → 400 `INVALID_JSON`; disallowed host → 400 `REPO_URL_NOT_ALLOWED`; secrets missing (`createTestContainer({ secretsSet: false })`) → 409 `SECRETS_MISSING` and NO rows created; enqueue failure (FakeQueue `add` throws) → 500 and turn FAILED; list default/ARCHIVED/ALL + ordering; detail 404 and full shape (`chatDetail.parse` succeeds, messages ascending seq, tool calls grouped); postMessage happy path (seq 2, new turn, enqueue), archived → 409 `CHAT_ARCHIVED`, running turn → 409 `TURN_IN_PROGRESS`; archive happy → ARCHIVED + destroy job enqueued + 200; archive twice → 409 `ILLEGAL_TRANSITION`; archive with running turn → 409; restore happy → ACTIVE + SYSTEM message appended (content equals the notice) + 200; restore of active → 409; `?warm=1` accepted; delete: 404, running turn → 409, live workspace → destroy job enqueued then rows gone → 204, no workspace → no job; cancel: 404, terminal → 409 `TURN_NOT_CANCELLABLE`, QUEUED with waiting job → job removed + CANCELLED + 200, RUNNING → publish on `turnCommandChannel(id)` with a payload that `turnCommandSchema.parse`s + 202, QUEUED with no removable job → 202 publish path.
   - `apps/web/app/api/routes.test.ts` — `vi.mock('@/server/container', () => ({ getServerContainer: () => testContainer }))`, import each route module, assert `runtime === 'nodejs'`, `dynamic === 'force-dynamic'`, and that each exported method returns a `Response` with the expected status for a minimal call (e.g. `GET /api/chats` → 200, `POST /api/chats/[id]/archive` with unknown id → 404). Later tasks extend this file.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- Handlers never import `next/*`; they use the Fetch `Request`/`Response` only (testable without Next).
- No raw Prisma usage in handlers — repositories only.

Verification:
- `pnpm --filter web test -- --coverage` — green, 100 % on `src/server/**` and `app/api/**`
- `pnpm typecheck && pnpm lint` — exit 0
- Manual smoke (optional, needs compose up + `.env.local`): `curl -s -X POST localhost:$WEB_PORT/api/chats -H 'content-type: application/json' -d '{"repoUrl":"https://github.com/octocat/Hello-World","baseBranch":"master","prompt":"hi"}'` → 409 SECRETS_MISSING on a fresh DB (proves wiring)

Completion Protocol: update status/AC/progress in docs/tasks/wave-2a-web-api-sse.md; append `- 2A.2 ✅ <date> — <summary>`; commit `feat(web): add chat, message, archive/restore, delete and cancel routes`.
````

---

## Task 2A.3 — Jobs CRUD + manual run, runs list/detail, repos + branches routes

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** M · **Depends on:** 2A.1

**Description.** Implement the scheduled-jobs API (create/list/get/patch/delete with BullMQ Job Scheduler upsert/remove, manual run enqueue), run history and detail, and the GitHub repo/branch picker routes.

**Acceptance criteria**
- [ ] `POST /api/jobs` validates `jobUpsertRequest`, `validateCron(cron, timezone)` (400 `INVALID_CRON` on failure), computes `nextRunAt`, creates the row, upserts the scheduler when `enabled`, returns 201 `jobSummary`
- [ ] `GET /api/jobs` → `jobSummary[]` (createdAt desc); `GET /api/jobs/:id` → `jobSummary` or 404; `PATCH /api/jobs/:id` partial update with re-validation and scheduler upsert/remove according to `enabled`; `DELETE /api/jobs/:id` → remove scheduler + cascade delete → 204
- [ ] `POST /api/jobs/:id/run` → 404 / 409 `SECRETS_MISSING` guards; enqueues `scheduled-jobs`/`run-scheduled-job` `{ jobId, trigger: 'MANUAL' }` → 202 `runJobResponse`
- [ ] `GET /api/jobs/:id/runs?limit=` → `runSummary[]` newest first (default 50, max 200); `GET /api/runs/:id` → `runDetail` with tool calls or 404
- [ ] `GET /api/repos?query=` → `repoSummary[]`; `GET /api/repos/branches?repo=` → `branchSummary[]`; 409 `SECRETS_MISSING`, 401 `GITHUB_AUTH`, 502 `GITHUB_ERROR`, 400 on bad `repo`
- [ ] 100 % coverage on `src/server/handlers/{jobs,runs,repos}.ts` and route files

**Files to create**
`apps/web/src/server/handlers/{jobs,runs,repos}.ts` + tests; `mappers.ts` extended (`toJobSummary`, `toRunSummary`, `toRunDetail`); `apps/web/app/api/jobs/route.ts`, `app/api/jobs/[id]/route.ts`, `app/api/jobs/[id]/run/route.ts`, `app/api/jobs/[id]/runs/route.ts`, `app/api/runs/[id]/route.ts`, `app/api/repos/route.ts`, `app/api/repos/branches/route.ts`; `app/api/routes.test.ts` extended.

**Agent prompt**

````
You are a senior full-stack TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Next.js 16.3 route handlers · BullMQ 6 Job Schedulers via core wrappers · cron-parser via core scheduling · Zod 4 · Vitest 4.
Branch feat/w2a-web-api-sse (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-A — Task 2A.3 of 6 (MIDDLE)

PRECONDITIONS
- Task 2A.1 done (container, http helpers, github client, test container). 2A.2 may be done or in progress (independent).

REQUIRED READING (only these):
- docs/spec/03-interfaces.md § "4. HTTP API" (jobs/runs/repos rows), § "5. Queue contracts" (`scheduled-jobs`)
- docs/spec/04-flows.md (c) steps 1–6 and "Guarantees" (disable/enable/edit/delete/manual run)
- docs/spec/02-data-model.md § "2. Prisma schema draft" (ScheduledJob, JobRun, ToolCallLog)
- packages/core/src/api/contracts.ts (`jobUpsertRequest`, `jobSummary`, `runSummary`, `runDetail`, `runJobResponse`, `repoSummary`, `branchSummary`), packages/core/src/queues/contracts.ts (`runScheduledJobPayload`), packages/core/src/queues/schedulers.ts (`upsertJobScheduler`, `removeJobScheduler` signatures), packages/core/src/scheduling/index.ts (`validateCron`, `nextRunAt`, `describeCron`)
- packages/core/src/persistence/ports.ts (ScheduledJob, JobRun, ToolCallLog repositories)
- apps/web/src/server/{container,http,repo-url,github}.ts, apps/web/src/server/testing/index.ts
- apps/web/src/mocks/scheduled.ts (W1-H handlers — match shapes the UI consumes)

TASK
Implement the jobs, runs and repos routes as container-injected handlers + thin route files, 100 % tested.

DELIVERABLES

1. `mappers.ts` additions: `toJobSummary(job)` (include `nextRunAt`, `lastRunAt`, `enabled`, and a `scheduleText` = `describeCron(cron, timezone)` if the contract has such a field), `toRunSummary(run)`, `toRunDetail(run, toolCalls)`; each ends with the contract's `.parse`.
2. `apps/web/src/server/handlers/jobs.ts`:
   - `createJob`: `parseJsonBody(jobUpsertRequest)`; `assertRepoUrlAllowed`; `validateCron(body.cron, body.timezone)` (core throws `InvalidCronError` → 400 via the mapping); `nextRunAt = enabled ? computeNextRunAt(cron, timezone, c.clock.now()) : null` (use core's `nextRunAt`); `repos.scheduledJobs.create({...})`; if `enabled` → `upsertJobScheduler(c.queues.scheduledJobs, job.id, { pattern: cron, tz: timezone }, { name: JOB_NAMES.runScheduledJob, data: runScheduledJobPayload.parse({ jobId: job.id, trigger: 'SCHEDULE' }) })` (adapt to the exact wrapper signature from W1-F); 201 `jobSummary`. If the scheduler upsert throws, delete the row and rethrow (keep DB ↔ scheduler consistent; document).
   - `listJobs` (200, createdAt desc), `getJob` (404).
   - `patchJob`: body = `jobUpsertRequest.partial()`; 404; merge; if `cron`/`timezone` present → `validateCron`; recompute `nextRunAt` when cron/tz/enabled changed; `repos.scheduledJobs.update(id, patch)`; then `enabled === false` → `removeJobScheduler(queue, id)`; `enabled === true` (or cron/tz/prompt/repo changed while enabled) → `upsertJobScheduler` (idempotent by key); 200 `jobSummary`.
   - `deleteJob`: 404; `removeJobScheduler(queue, id)` (ignore "not found"); `repos.scheduledJobs.delete(id)` (cascade runs); 204.
   - `runJobNow`: 404; `requireSecrets` (reuse the helper from chats.ts — move it to `src/server/handlers/guards.ts` if 2A.2 is merged in your branch, else create it there now and let chats import it); `c.queues.scheduledJobs.add(JOB_NAMES.runScheduledJob, runScheduledJobPayload.parse({ jobId: id, trigger: 'MANUAL' }), { jobId: \`manual:${id}:${c.clock.now().getTime()}\`, removeOnComplete: { age: 3600 }, removeOnFail: { age: 86400 } })`; 202 `runJobResponse { jobId, trigger: 'MANUAL' }` (the worker creates the JobRun row — flow (c) step 9; the UI polls `GET /api/jobs/:id/runs`).
3. `apps/web/src/server/handlers/runs.ts`: `listRuns(c, request, { id })` — job 404; `parseQuery(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }))`; `repos.jobRuns.listByJob(id, { limit })` newest first; 200 `runSummary[]`. `getRun(c, request, { id })` — 404; `toolCalls.listByJobRun(id)`; 200 `runDetail`.
4. `apps/web/src/server/handlers/repos.ts`: `listRepos` — `parseQuery(z.object({ query: z.string().max(100).default('') }))`; `c.github.listRepos(query)`; 200 `repoSummary[]` with `Cache-Control: private, max-age=30`. `listBranches` — `parseQuery(z.object({ repo: z.string().min(3).max(200) }))`; `c.github.listBranches(repo)`; 200 `branchSummary[]`. Errors flow through `withErrorHandling` (409 `SECRETS_MISSING`, 401 `GITHUB_AUTH`, 502 `GITHUB_ERROR`, 400 `VALIDATION_ERROR`).
5. Route files (thin, `runtime`/`dynamic` exports): `app/api/jobs/route.ts` (GET, POST), `app/api/jobs/[id]/route.ts` (GET, PATCH, DELETE), `app/api/jobs/[id]/run/route.ts` (POST), `app/api/jobs/[id]/runs/route.ts` (GET), `app/api/runs/[id]/route.ts` (GET), `app/api/repos/route.ts` (GET), `app/api/repos/branches/route.ts` (GET). Extend `app/api/routes.test.ts`.
6. Tests (`/** @vitest-environment node */`, `createTestContainer`, `FakeClock` pinned to a fixed date so `nextRunAt` is deterministic):
   - jobs: create happy (row, `nextRunAt` equals core `nextRunAt(cron, tz, now)`, `FakeQueue.schedulers` has key = job id with pattern/tz, 201 parses as `jobSummary`); create disabled → no scheduler, `nextRunAt` null; invalid cron `"61 * * * *"` → 400 `INVALID_CRON`; invalid tz → 400; bad repo host → 400; scheduler upsert throws → row deleted + 500; list ordering; get 404; patch: cron change re-validates + upserts with new pattern, `enabled:false` removes scheduler, `enabled:true` re-adds, partial body without cron keeps scheduler; delete → scheduler removed + row gone + runs cascade (in-memory repo) + 204; run now: 404, secrets missing → 409, happy → 202 and `FakeQueue.added` has `run-scheduled-job` `{ jobId, trigger: 'MANUAL' }` with `jobId` starting `manual:<id>:`.
   - runs: list 404, default limit, `?limit=2` caps, newest first, `?limit=0` → 400; detail 404, tool calls included, parses as `runDetail`.
   - repos: stub github client per test; `?query=` empty → all; 409 when the stub throws `ApiHttpError(409, 'SECRETS_MISSING')`; `GithubApiError(401)` → 401 `GITHUB_AUTH`; `GithubApiError(503)` → 502 `GITHUB_ERROR`; branches missing `repo` → 400; `Cache-Control` header on repos.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- Use core's scheduling functions — never call `cron-parser` directly from apps/web.
- Scheduler keys are exactly `ScheduledJob.id` (spec 03 §5).

Verification:
- `pnpm --filter web test -- --coverage` — green, 100 %
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-2a-web-api-sse.md; append `- 2A.3 ✅ <date> — <summary>`; commit `feat(web): add jobs, runs and repos routes`.
````

---

## Task 2A.4 — Settings (status/set/remove, no request logging) and health routes

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** S · **Depends on:** 2A.1

**Description.** Implement `GET /api/settings`, `PUT`/`DELETE /api/settings/:key` using only `status`/`set`/`remove` of `SecretsService`, with request logging disabled and responses that never contain plaintext; and `GET /api/health` combining DB ping, Redis ping, the worker heartbeat key and DB-derived live-workspace counters.

**Acceptance criteria**
- [ ] `GET /api/settings` → `settingsStatus` (`githubPat`/`openaiKey` `{ set, last4?, updatedAt? }`, `model`), `Cache-Control: no-store`
- [ ] `PUT /api/settings/:key` (`key` ∈ `GITHUB_PAT | OPENAI_API_KEY`, else 404) with `putSecretRequest` → `secrets.set` → 200 `putSecretResponse { set: true, last4 }`; `DELETE` → `secrets.remove` → 204; handlers log only `{ key, action }`, never the body/value; `Cache-Control: no-store`
- [ ] A test captures all logger output and asserts with `assertNoCanary` that neither logs nor responses contain the canaries; a test asserts `reveal` is never called by settings handlers (`FakeSecretsService.revealCalls` empty)
- [ ] `GET /api/health` → 200 `healthResponse` with `db`, `redis`, `worker` (from `workerHeartbeatKey(instance)` parsed by `workerHeartbeatSchema`; `ok = false` when absent/invalid/older than TTL), `liveWorkspaces` (`repos.workspaces.listLive()` grouped by kind), `image`, `ports`, `instance`, `ok`; `?require=worker|all` → 503 until satisfied; each probe bounded by a 2 s timeout and never throws
- [ ] 100 % coverage

**Files to create**
`apps/web/src/server/handlers/{settings,health}.ts` + tests; `apps/web/app/api/settings/route.ts`, `app/api/settings/[key]/route.ts`, `app/api/health/route.ts`; `app/api/routes.test.ts` extended.

**Agent prompt**

````
You are a senior full-stack TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Next.js 16.3 route handlers · core `SecretsService` (AES-256-GCM, W1-A) · Prisma 7.9 · ioredis 6 · Zod 4 · Vitest 4.
Branch feat/w2a-web-api-sse (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-A — Task 2A.4 of 6 (MIDDLE)

PRECONDITIONS
- Task 2A.1 done (container with `secrets`, `redis`, `prisma`, `repos`; heartbeat contracts in core; `FakeSecretsService`, `FakeRedis`).

REQUIRED READING (only these):
- docs/spec/03-interfaces.md § "4. HTTP API" (settings + health rows), § "6. Secrets service"
- docs/spec/04-flows.md (d) SAVE steps 1–8 and "Controls, end to end" (UI, Transport, Logs rows)
- docs/spec/05-local-dev.md § "3. Environment model" (which values `health` reports), § "4. First-run experience" (doctor table — health is its API twin)
- packages/core/src/api/contracts.ts (`settingsStatus`, `putSecretRequest`, `putSecretResponse`, `healthResponse`), packages/core/src/queues/contracts.ts (`workerHeartbeatKey`, `workerHeartbeatSchema`, `WORKER_HEARTBEAT_TTL_SEC`), packages/core/src/secrets/types.ts (`SecretKey`, `SecretsService`)
- packages/core/src/persistence/ports.ts (`WorkspaceRepository.listLive`), packages/core/src/persistence/client.ts (`assertDatabaseReachable`)
- apps/web/src/server/{container,http}.ts, apps/web/src/server/testing/index.ts
- apps/web/src/mocks/settings.ts (W1-H handlers)

TASK
Implement settings and health routes. Settings must be the one place where plaintext enters the server and must leave no trace: no body logging, no plaintext in responses, no `reveal`.

DELIVERABLES

1. `apps/web/src/server/handlers/settings.ts`:
   - `const SECRET_KEYS = ['GITHUB_PAT', 'OPENAI_API_KEY'] as const` and `secretKeyParam = z.enum(SECRET_KEYS)`; unknown `key` → `NotFoundError` (404, not 400 — the resource does not exist).
   - `getSettings(c)`: `const s = await c.secrets.status()`; map `GITHUB_PAT → githubPat`, `OPENAI_API_KEY → openaiKey` (`{ set, last4?, updatedAt?: ISO }`), `model: c.config.OPENAI_MODEL`; 200 `settingsStatus` + `Cache-Control: no-store`.
   - `putSetting(c, request, { key })`: validate key; `parseJsonBody(putSecretRequest)` (the contract decides min length/trim; if it is bare `z.string()`, add `.trim().min(1)` locally and reject values containing whitespace/newlines with 400 `VALIDATION_ERROR`); `const { last4 } = await c.secrets.set(key, value)`; `c.logger.info({ key, action: 'set' }, 'secret updated')` — NOTHING else is logged in this handler (no request URL with query, no body, no value, no error message that could contain the value: wrap `set` errors as `ApiHttpError(500, 'SECRET_WRITE_FAILED', 'Could not store secret')` after logging only `err.name`); 200 `putSecretResponse { set: true, last4 }` + `Cache-Control: no-store`.
   - `deleteSetting(c, request, { key })`: validate; `await c.secrets.remove(key)`; log `{ key, action: 'remove' }`; 204.
   - File header states: "Request logging is disabled for this module by construction: handlers never pass the request or body to the logger." (there is no global request logger in apps/web; this sentence documents the invariant the test enforces).
2. `apps/web/src/server/handlers/health.ts`:
   - `getHealth(c, request)`: `parseQuery(z.object({ require: z.enum(['worker','all']).optional() }))`. Run in parallel with `Promise.allSettled` and a per-probe `withTimeout(promise, 2000)` helper (in `http.ts` or a new `timeout.ts`):
     `db`: `c.prisma.$queryRaw\`SELECT 1\`` (or `assertDatabaseReachable(c.prisma, 2000)`), `{ ok, latencyMs }`;
     `redis`: `c.redis.ping()` → `{ ok, latencyMs }`;
     `worker`: `c.redis.get(workerHeartbeatKey(c.config.AH_INSTANCE))` → parse JSON with `workerHeartbeatSchema.safeParse`; `ok = parsed.success && (now - at) <= WORKER_HEARTBEAT_TTL_SEC * 1000`; include `lastSeenAt`, `dockerOk`, `imagePresent`, `containers` when parsed;
     `liveWorkspaces`: `repos.workspaces.listLive()` → `{ chat: n, job: n }` by `kind` (on DB failure → `{ chat: 0, job: 0 }` and `db.ok=false`).
     Response: `healthResponse.parse({ ok: db.ok && redis.ok, instance, db, redis, worker, liveWorkspaces, image: c.config.WORKSPACE_IMAGE, ports: { web: WEB_PORT, postgres: POSTGRES_PORT, redis: REDIS_PORT } })`; status 200, or 503 when `require=worker` and `!worker.ok`, or `require=all` and `!(ok && worker.ok)`; `Cache-Control: no-store`. Never throws: a probe rejection becomes `ok: false` (error name logged at warn through the redacting logger).
3. Route files: `app/api/settings/route.ts` (GET), `app/api/settings/[key]/route.ts` (PUT, DELETE — `params: { key }`), `app/api/health/route.ts` (GET). Extend `app/api/routes.test.ts`.
4. Tests (`/** @vitest-environment node */`):
   - settings: GET with nothing set → both `set:false`, `model` present, `no-store`; GET after `FakeSecretsService` seeded with canaries → `last4` correct and response text passes `assertNoCanary`; PUT happy → 200 `{ set: true, last4 }` and the fake holds the value; PUT unknown key → 404; PUT empty/whitespace value → 400; PUT with `set` throwing → 500 `SECRET_WRITE_FAILED`; DELETE → 204 and status becomes `set:false`; DELETE unknown key → 404; logger capture across all settings tests → `assertNoCanary(allLogOutput)` and no log line contains `"value"`; `FakeSecretsService.revealCalls` is empty after every settings test.
   - health: all green (FakeRedis with a fresh heartbeat JSON set under `workerHeartbeatKey('test')`) → 200, `ok:true`, `worker.ok:true`, `liveWorkspaces` counts from in-memory workspaces (seed one live CHAT + one live JOB + one DESTROYED); heartbeat missing → `worker.ok:false`, still 200; heartbeat stale (at = now − 120 s) → `worker.ok:false`; heartbeat invalid JSON → `worker.ok:false`; `?require=worker` with no heartbeat → 503; `?require=all` all good → 200; redis ping rejects → `redis.ok:false`, `ok:false`, 200; db probe hangs → fake timers advance 2 s → `db.ok:false`; `?require=bogus` → 400.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- `reveal` must not appear in these files (the policy test from 2A.1 enforces it).
- Health must be cheap: no Docker calls, no `runner.list` — the worker heartbeat is the only Docker signal (decision 2 in the lane Context).

Verification:
- `pnpm --filter web test -- --coverage` — green, 100 %
- `pnpm typecheck && pnpm lint` — exit 0
- Optional smoke with compose up: `curl -s localhost:$WEB_PORT/api/health | jq` shows `db.ok`/`redis.ok` true and `worker.ok` false (worker writer lands in W2-B)

Completion Protocol: update status/AC/progress in docs/tasks/wave-2a-web-api-sse.md; append `- 2A.4 ✅ <date> — <summary>`; commit `feat(web): add settings and health routes`.
````

---

## Task 2A.5 — SSE: stream factory, `chats/[id]/events`, `runs/[id]/events`, `@redis` integration

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** L · **Depends on:** 2A.1, 2A.2

**Description.** Implement the Server-Sent Events endpoints over Redis Streams: replay via `XRANGE` from `Last-Event-ID`/`?from=`, tail via `XREAD BLOCK` on a dedicated duplicated ioredis connection, `: ping` heartbeat every 15 s, clean close on client abort, `event: expired` when the stream is gone and the turn/run is finished, terminal-event close. Unit-tested with `FakeRedis`, integration-tested `@redis` against compose Redis.

**Acceptance criteria**
- [ ] `apps/web/src/server/sse.ts` exports `formatSseFrame(frame: SseFrame): string`, `SSE_HEADERS`, `createSseResponse(opts)` building a `ReadableStream<Uint8Array>` with the behaviour below
- [ ] `GET /api/chats/:id/events?turnId=&from=` (default: latest turn of the chat; 404 chat/turn) and `GET /api/runs/:id/events?from=` (404 run) respond `200 text/event-stream` with headers `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`; `export const runtime = 'nodejs'`, `dynamic = 'force-dynamic'`
- [ ] Replay: with `Last-Event-ID` header (or `?from=`) → `XRANGE key (<id> +`; without → full stream from `0-0`; frames `id: <stream-id>\nevent: <AgentEvent.type>\ndata: <json>\n\n`
- [ ] Tail: `XREAD BLOCK <blockMs> STREAMS key <cursor>` loop on `redis.duplicate()`; closes after a terminal event (`turn.completed|turn.failed|turn.cancelled`), on `request.signal` abort, or on stream cancel; heartbeat comment `: ping\n\n` every `heartbeatMs` (15 000 default); the duplicated connection is always disconnected
- [ ] Expired: stream key missing and turn/run in a terminal status → single frame `event: expired` then close; stream key missing and turn not finished → wait (tail from `0-0`) — the worker has not started yet
- [ ] Unit tests (FakeRedis) + `@redis` integration tests (real Redis: XADD → frames, Last-Event-ID replay returns only later entries, heartbeat within 16 s using a short `heartbeatMs`, abort closes, expired path); 100 % coverage

**Files to create**
`apps/web/src/server/sse.ts` + `sse.test.ts` + `sse.integration.test.ts`; `apps/web/src/server/handlers/events.ts` + test; `apps/web/app/api/chats/[id]/events/route.ts`, `app/api/runs/[id]/events/route.ts`; `apps/web/package.json` (`test:integration` script); `app/api/routes.test.ts` extended.

**Agent prompt**

````
You are a senior full-stack TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Next.js 16.3 route handlers (Node runtime, Web Streams `ReadableStream`) · Redis 8 Streams via ioredis 6 (`xrange`, `xread` with `BLOCK`, `.duplicate()`) · Zod 4 · Vitest 4.
Branch feat/w2a-web-api-sse (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-A — Task 2A.5 of 6 (MIDDLE)

PRECONDITIONS
- Tasks 2A.1 and 2A.2 done (container with `redis`, `repos.turns`, `repos.jobRuns`; `FakeRedis` with xadd/xrange/xread/duplicate; `parseTurnEventEntry`, `TURN_EVENT_FIELD` in core).
- Compose Redis for the `test` instance reachable for the integration run (`AH_INSTANCE=test pnpm infra:up` or the CI service); `REDIS_URL` set in that shell.

REQUIRED READING (only these):
- docs/spec/03-interfaces.md § "4. HTTP API" (the two SSE rows + "SSE framing" paragraph)
- docs/spec/04-flows.md (a) steps 6–7, 32–35 and "Edge cases" (Browser reconnect)
- docs/spec/06-testing.md § "3. Integration tests" (SSE endpoint bullet)
- packages/core/src/api/contracts.ts (`SseFrame`), packages/core/src/queues/contracts.ts (`turnEventsStreamKey`, `TURN_EVENT_FIELD`, `parseTurnEventEntry`), packages/core/src/agent-protocol/schemas.ts (`agentEventSchema` — terminal event types)
- packages/core/src/persistence/ports.ts (`TurnRepository.get/listByChat`, `JobRunRepository.get`)
- apps/web/src/server/{container,http}.ts, apps/web/src/server/testing/fake-redis.ts
- apps/web/src/features/chats/**/useTurnEvents* (W1-G's client hook — confirm it closes the EventSource on terminal/expired events; if it does not, do NOT edit it: record a contractChangeRequest)
- packages/core/vitest.config.ts and packages/core/package.json (how `@db` integration tests are gated — replicate the same convention for `@redis` in apps/web)

TASK
Implement the SSE stream factory and the two events routes with replay, tail, heartbeat, abort and expiry semantics; test with FakeRedis and against real Redis.

DELIVERABLES

1. `apps/web/src/server/sse.ts`:
   ```ts
   export const SSE_HEADERS = {
     'Content-Type': 'text/event-stream; charset=utf-8',
     'Cache-Control': 'no-cache, no-transform',
     Connection: 'keep-alive',
     'X-Accel-Buffering': 'no',
   } as const;
   export const SSE_TERMINAL_EVENTS = ['turn.completed', 'turn.failed', 'turn.cancelled'] as const;
   export function formatSseFrame(frame: SseFrame): string;          // `id: ${id}\nevent: ${event}\ndata: ${data}\n\n` — data must not contain raw "\n" (JSON.stringify never emits one; assert in a test)
   export interface SseSourceOptions {
     redis: Redis;                        // the shared connection; the factory calls redis.duplicate() for blocking reads
     streamKey: string;
     lastEventId?: string;                // header or ?from=
     isFinished: () => Promise<boolean>;  // terminal turn/run status
     signal: AbortSignal;                 // request.signal
     heartbeatMs: number;
     blockMs: number;
     logger: Logger;
   }
   export function createSseResponse(opts: SseSourceOptions): Response;
   ```
   Implementation skeleton (adapt, keep the shape):
   ```ts
   const encoder = new TextEncoder();
   const conn = opts.redis.duplicate();
   let closed = false;
   const stream = new ReadableStream<Uint8Array>({
     start: (controller) => {
       const write = (s: string) => { if (!closed) controller.enqueue(encoder.encode(s)); };
       const ping = setInterval(() => write(': ping\n\n'), opts.heartbeatMs);
       const close = () => { if (closed) return; closed = true; clearInterval(ping); opts.signal.removeEventListener('abort', close); conn.disconnect(); try { controller.close(); } catch { /* already closed by consumer */ } };
       opts.signal.addEventListener('abort', close, { once: true });
       void pump(write, close);          // async; never throws out of start()
     },
     cancel: () => { /* consumer went away */ closeFromCancel(); },
   });
   return new Response(stream, { status: 200, headers: SSE_HEADERS });
   ```
   `pump`:
   a. `let cursor = opts.lastEventId ?? '0-0'`.
   b. `const exists = await conn.exists(streamKey)`. If `!exists && await opts.isFinished()` → `write(formatSseFrame({ id: cursor, event: 'expired', data: '{}' }))`, `close()`, return.
   c. If `opts.lastEventId` → `const entries = await conn.xrange(streamKey, \`(${lastEventId}\`, '+')`; emit each (see e), advance cursor. (Without `lastEventId` the first `xread` from `0-0` is the full replay.)
   d. Loop while `!closed`: `const res = await conn.xread('BLOCK', opts.blockMs, 'STREAMS', streamKey, cursor)`; `null` → if `await opts.isFinished()` and `cursor !== '0-0'` → close (the turn ended and everything was delivered — belt and braces in case the terminal event was never written), else continue; otherwise for each `[id, fields]`: `const ev = parseTurnEventEntry(fields)`; if `ev === null` → `write(formatSseFrame({ id, event: 'protocol.error', data: JSON.stringify({ type: 'protocol.error', reason: 'schema-violation', length: 0 }) }))`; else `write(formatSseFrame({ id, event: ev.type, data: JSON.stringify(ev) }))`; `cursor = id`; if `SSE_TERMINAL_EVENTS.includes(ev.type)` → close and return.
   e. Whole pump in try/catch: on error, if `!closed` log `warn` (`err.name` + message through the redacting logger) and close. A disconnect during `xread` rejects — that is the normal abort path, not an error (check `closed`/`signal.aborted` first).
   ioredis notes: `xread('BLOCK', ms, 'STREAMS', key, id)` returns `null` on timeout or `[[key, [[id, fields]]]]`; `xrange(key, '(id', '+')` exclusive start needs Redis ≥ 6.2 (we run 8). Never issue commands on the shared `opts.redis` from the pump — only on `conn`.
2. `apps/web/src/server/handlers/events.ts`:
   - `chatEvents(c, request, { id })`: 404 if chat missing; `parseQuery(z.object({ turnId: z.string().optional(), from: z.string().regex(/^\d+-\d+$/).optional() }))`; turn = `turnId` ? `repos.turns.get(turnId)` (404 and must belong to the chat, else 404) : latest of `repos.turns.listByChat(id)` by `queuedAt` (none → 404 `NOT_FOUND` "chat has no turns"); `lastEventId = request.headers.get('last-event-id') ?? query.from` (header wins, validated with the same regex; invalid header → ignore and start from `0-0`); `createSseResponse({ redis: c.redis, streamKey: turnEventsStreamKey(turn.id), lastEventId, isFinished: async () => isTerminal((await repos.turns.get(turn.id))?.status), signal: request.signal, heartbeatMs: c.sse.heartbeatMs, blockMs: c.sse.blockMs, logger })`.
   - `runEvents(c, request, { id })`: same over `repos.jobRuns.get(id)` and `turnEventsStreamKey(run.id)` (flow (c) step 17 uses the run id as the stream key).
3. Route files: `app/api/chats/[id]/events/route.ts`, `app/api/runs/[id]/events/route.ts` — `export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';` + GET wiring. Extend `app/api/routes.test.ts` (assert `Content-Type` starts with `text/event-stream` and abort the request to end the test).
4. Integration gating: add `"test:integration": "vitest run --config vitest.config.ts --testNamePattern @redis"` (or a separate `vitest.integration.config.ts` if core did it that way — replicate core's convention exactly) to apps/web/package.json; the integration file's `describe('@redis sse', …)` runs when `REDIS_URL` is set; when unset and `CI` is not `1` it logs "skipped: REDIS_URL not set" and `describe.skip`s; when `CI=1` and Redis is unreachable it `throw`s in `beforeAll` (fails loudly).
5. Tests:
   - `sse.test.ts` (`/** @vitest-environment node */`, FakeRedis, `vi.useFakeTimers()` where timers matter; read the stream with `response.body!.getReader()` + `TextDecoder`; helper `readUntil(reader, predicate)`): headers exact; `formatSseFrame` exact bytes; full replay from `0-0` emits all existing entries in order with stream ids; `lastEventId` replay emits only later entries (`(` exclusive); tail: xadd after connect → frame arrives; terminal event → stream closes (`reader.read()` → `done: true`) and the duplicated connection is disconnected (FakeRedis `closed === true`); heartbeat: advance `heartbeatMs` → `: ping\n\n` chunk; abort via `AbortController` → closes, no further writes, connection disconnected; `cancel()` (reader.cancel) → same; expired: key missing + `isFinished` true → one `event: expired` frame then done; key missing + not finished → no frame until xadd; unparseable entry → `protocol.error` frame, stream continues; `xread` rejects while not closed → warn logged, stream closed; `xread` rejects after abort → no warn.
   - `events.test.ts`: chat 404, no turns 404, `turnId` of another chat 404, `?from=bad` 400, header precedence over `?from`, invalid header ignored, run 404, both handlers produce `text/event-stream` and pass `lastEventId` through (assert via FakeRedis call recorder that `xrange` was called with `(<id>`).
   - `sse.integration.test.ts` (`@redis`): real `new Redis(process.env.REDIS_URL)`; unique key per test (`events:turn:test-<uuid>`), `EXPIRE 60` on each; (1) XADD three `assistant.delta` entries as `['event', JSON]` → GET (via `createSseResponse` directly AND via `chatEvents` with an in-memory turn) yields three frames with matching ids; (2) `lastEventId` = id of entry 1 → only entries 2–3; (3) connect first, then XADD from a second connection → frame arrives within 1 s; (4) `heartbeatMs: 200` → a `: ping` chunk within 1 s (16 s at the default — assert the default value constant separately, do not wait 16 s); (5) abort → `reader.read()` resolves `done` within 500 ms and `CLIENT LIST` no longer shows the duplicated connection (or simply assert the read completes); (6) key absent + `isFinished` true → `event: expired`; (7) XADD `turn.completed` → stream closes after the frame. `afterAll` deletes keys and quits.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- Never compress or buffer: no `Content-Encoding`, no `Content-Length`; `no-transform` + `X-Accel-Buffering: no` exactly as listed.
- No timers left running after close (assert with fake timers: `vi.getTimerCount() === 0` after close).
- The shared `c.redis` connection must never be used for blocking commands.

Verification:
- `pnpm --filter web test -- --coverage` — green, 100 % (unit)
- `REDIS_URL=redis://127.0.0.1:<test-redis-port> pnpm --filter web test:integration` — `@redis` suite green
- `pnpm typecheck && pnpm lint` — exit 0
- Manual (optional): with compose up, `curl -N localhost:$WEB_PORT/api/chats/<id>/events` prints `: ping` every 15 s and frames after `redis-cli XADD events:turn:<turnId> '*' event '{"type":"assistant.delta","text":"hi"}'`

Completion Protocol: update status/AC/progress in docs/tasks/wave-2a-web-api-sse.md; append `- 2A.5 ✅ <date> — <summary>`; commit `feat(web): add SSE event streams for chats and runs`.
````

---

## Task 2A.6 — Close-out: gates, code review, dashboard, PR

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** S · **Depends on:** 2A.1–2A.5

**Description.** Run every gate (lint, format, typecheck, unit 100 %, `@redis` integration), run `/bymax-quality:code-review` to zero findings, update the plan dashboard and the tasks index, open the PR with the structured summary including the two decisions and every additive contract change, and return the orchestrator payload.

**Acceptance criteria**
- [ ] `pnpm lint && pnpm format:check && pnpm typecheck` exit 0; `pnpm --filter web test -- --coverage` 100/100/100/100 on `app/api/**` + `src/server/**`; `pnpm --filter @agent-hangar/core test -- --coverage` still 100 %; `pnpm --filter web test:integration` green against compose Redis
- [ ] `/bymax-quality:code-review` run on the branch with zero open findings (no suppressions added to pass)
- [ ] `docs/plan.md` §12 row W2-A → 🟨 with branch and PR number; `docs/tasks/README.md` row for this lane updated
- [ ] PR opened against `main` with the structured body; returned payload `{ pr, branch, headSha, gates, coverage, contractChangeRequests }`

**Files to modify**
`docs/plan.md` (§12 row only), `docs/tasks/README.md` (lane row only), `docs/tasks/wave-2a-web-api-sse.md` (header status, log).

**Agent prompt**

````
You are a senior engineer closing out lane W2-A of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 · Node 24 · Next.js 16.3 · Prisma 7.9 · BullMQ 6 · ioredis 6 · Vitest 4 · GitHub Actions.
Branch feat/w2a-web-api-sse (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-A — Task 2A.6 of 6 (LAST)

PRECONDITIONS
- Tasks 2A.1–2A.5 done and committed on this branch; compose Redis for `AH_INSTANCE=test` reachable.

REQUIRED READING (only these):
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard"
- docs/tasks/README.md
- CLAUDE.md § Gates

TASK
Run all gates and a full code review, fix everything, update the dashboards, open the PR, and return the structured payload.

DELIVERABLES

1. Gates, in order, all green: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm --filter @agent-hangar/core test -- --coverage` (100 % incl. your additive contracts), `pnpm --filter web test -- --coverage` (100/100/100/100 on `app/api/**`, `src/server/**`), `REDIS_URL=<test redis> pnpm --filter web test:integration` (`@redis` green), `pnpm --filter web build` (Next build compiles every route; fix type errors in route signatures here).
2. Run `/bymax-quality:code-review` (full) on the branch range `main..HEAD`; resolve EVERY finding (CRITICAL/HIGH/MEDIUM/LOW) by changing code — never by suppression. Re-run the gates after fixes. Repeat until zero findings.
3. Update `docs/plan.md` §12 row `W2-A` → `🟨 PR open` with `feat/w2a-web-api-sse / #<n>` and coverage; update the W2-A row in `docs/tasks/README.md` (status 🟨, link). Update this file's header (`Status` → 🟨 PR open, `Progress` 6/6).
4. Commit docs: `docs(tasks): close out lane W2-A`.
5. Open the PR: `gh pr create --base main --title "feat(web): API route handlers, SSE streams and server container (W2-A)" --body-file <generated>`. Body sections: Summary · Routes implemented (table: method/path → handler → status codes) · Decisions (1. single web-side `reveal` in `src/server/github.ts` with the policy test; 2. worker heartbeat key for health, DB-derived live counters) · Additive contract changes (exact exports added to `packages/core/src/queues/contracts.ts`, `config/schema.ts`, `api/contracts.ts`) · How to run (`curl` examples for health, settings, chats, SSE) · Gate results · Coverage numbers · contractChangeRequests (see 6).
6. Return to the orchestrator: `{ pr, branch, headSha, gates: { lint, format, typecheck, unitWeb, unitCore, integrationRedis, build }, coverage: { web: {...}, core: {...} }, contractChangeRequests: [ … ] }` where `contractChangeRequests` lists at least: (a) W2-B — write `health:worker:<instance>` heartbeat (`workerHeartbeatKey`, TTL 90 s, every 30 s, `workerHeartbeatSchema` payload); (b) W2-B — stream entries are `['event', '<JSON AgentEvent>']` (`TURN_EVENT_FIELD`); (c) W2-B — subscribe to `turnCommandChannel(turnId)` and handle `turnCommandSchema` `cancel`; (d) W2-B — `destroy-chat-workspace` must fall back to `runner.list({ 'ah.chat': chatId })` when the chat row is gone (DELETE path); (e) W1-I/W3-B — document `ALLOWED_REPO_HOSTS`, `GITHUB_API_BASE_URL` in `.env.example`/README; (f) W1-G — `useTurnEvents` must close the EventSource on terminal/`expired` events (only if you found it does not); (g) anything else you added or discovered.

Constraints:
- English; Conventional Commits; no AI attribution anywhere (no `Co-Authored-By`, no "Generated with" lines).
- Do not wait for CI; do not merge; do not touch paths outside the lane (the two docs rows are the only exception).

Verification:
- `gh pr view --json number,headRefOid,url` — PR exists; `git status --porcelain` empty; `git log --format=%B main..HEAD | grep -ci "co-authored-by\|generated with"` → 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-2a-web-api-sse.md (lane header Status → 🟨 PR open); append `- 2A.6 ✅ <date> — PR #<n> opened`; the docs commit above precedes the PR.
````

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)

- 2A.1 ✅ 2026-08-19 — server container, HTTP helpers, same-origin guard, GitHub client, test doubles and the additive core contracts
