# Wave 2 — Lane B 🐳 — Worker processors, queues, events

| | |
|---|---|
| **Lane** | W2-B 🐳 (parallel with W2-A, W2-C; the only Docker-integration lane running at a time) |
| **Status** | 🟦 running |
| **Progress** | 4/6 tasks |
| **Branch** | `feat/w2b-worker` |
| **Owned paths** | `apps/worker/src/**` (incl. `apps/worker/src/testing/**`), `apps/worker/vitest.config.ts`, `apps/worker/package.json` scripts only (`test:integration`) |
| **Depends on** | W0, W1-A, W1-B, W1-C, W1-D, W1-E, W1-F merged to `main` |
| **Unblocks** | W3-A (end-to-end wiring), W3-B (docs) |
| **Source** | [docs/plan.md §7 W2-B](../plan.md) · spec [04](../spec/04-flows.md) (a)(b)(c) [03 §3 §5 §6](../spec/03-interfaces.md) [02 §3 §4](../spec/02-data-model.md) [06 §2 §3](../spec/06-testing.md) |
| **Last updated** | 2026-08-19 |

## Context

The worker is where every flow of spec 04 actually happens. W0 left `apps/worker` as a booting process (`boot.ts`: config, DB round-trip, Redis ping, graceful shutdown). Wave 1 delivered everything the processors orchestrate: `DockerWorkspaceRunner` (W1-B), the agent runtime bundled into the image (W1-D), `SecretsService` + `Redactor` + logger (W1-A), Prisma repositories (W1-E), scheduling/workspace/restore helpers and BullMQ queue factories (W1-F), and the OpenAI provider (W1-C — used **inside** the container by the runtime, not by the worker).

This lane adds the BullMQ consumers: `run-turn` (flow a and b: ensure workspace → build `TurnRequest` → `exec` the runtime → redact → publish to Redis Streams → persist), `run-scheduled-job` (flow c: fresh JOB workspace, overlap policy, destroy in `finally`), `reap-idle` + `destroy-chat-workspace` GC with orphan reconcile, the scheduler reconcile on boot, the cancel command channel, the DI container and the `main.ts` wiring with an image-present check. Unit tests run everything against `FakeWorkspaceRunner` (with a scripted "runtime" that emits NDJSON `AgentEvent`s on stdout) and in-memory repositories; the 🐳 integration suite runs a real container with `AGENT_MODEL_PROVIDER=fake`.

## Rules of this lane

1. Owned paths only: `apps/worker/src/**`, `apps/worker/vitest.config.ts`, the `test:integration` script of `apps/worker/package.json`. Nothing in `packages/**`, `apps/web/**`, `infra/**`. If a core helper you need is missing or has the wrong shape, stop and file a `contractChangeRequest` (additive) — do not copy core logic into the worker.
2. No new dependencies. Everything needed (`bullmq`, `ioredis`, `pino`, `zod`, `@agent-hangar/core`) is in `apps/worker/package.json` since W0.
3. The worker never imports `dockerode` or `openai`; it talks to Docker only through `WorkspaceRunner` and never instantiates a model provider (the runtime inside the container does, selected by the `AGENT_MODEL_PROVIDER` env the worker injects).
4. Secrets: `SecretsService.reveal` is allowed **only** in the worker (`container.ts` exposes it); plaintext is passed to `runner.create({ env })` and to `redactor.register(...)`, never stored on an object, never logged. Every `AgentEvent` is redacted (`redactor.redactJson`) **before** it is published or persisted — defence in depth on top of the runtime's shape redaction and the repositories' redact-on-write.
5. Processors throw only on infrastructure failures (DB/Redis down, runner transport error) so BullMQ retries; turn/run-level failures (image missing, secrets missing, runtime non-zero exit, model auth) are persisted as `FAILED` with a redacted error and a published `turn.failed` event, and the processor resolves.
6. No `enum`; no suppression comments; JSDoc on every export + file header; test header + block comment on every `it()`; English; Conventional Commits; no AI-attribution trailers; canaries from `@agent-hangar/core/testing`.
7. Coverage: `apps/worker/vitest.config.ts` keeps `coverage.include: ['src/**']`, thresholds 100/100/100/100; `coverage.exclude` may list `src/main.ts` only if it stays a ≤ 15-line wiring file and `src/**/*.integration.test.ts`. Integration files are named `*.integration.test.ts`, their `describe` is titled `@docker @db @redis …`, they run only when `DOCKER_AVAILABLE=1` (and `DATABASE_URL`/`REDIS_URL` set), and they **fail loudly** when `CI=1` and Docker is unavailable.
8. Branch `feat/w2b-worker`; one PR at the end (Task 2B.6). Use `AH_INSTANCE=w2b AH_PORT_BASE=3300` for the local stack of this lane so it never collides with another lane's compose project.

## Reference docs

- [docs/plan.md](../plan.md) § "7. Wave 2" (W2-B), § "3. Parallelism rules" (🐳 rule), § "11. Orchestrator protocol"
- [spec 04 — Flows](../spec/04-flows.md) (a) incl. edge cases, (b), (c) incl. guarantees, (d) INJECT/REDACT
- [spec 03 — Interfaces](../spec/03-interfaces.md) § "1" (`WorkspaceRunner`, Docker behaviour: labels, `exec` `started` event), § "3. Agent runtime protocol" (`TurnRequest`, `AgentEvent`, exit codes, cancellation = SIGINT), § "4" (SSE framing — what W2-A reads from the stream), § "5. Queue contracts", § "6. Secrets service"
- [spec 02 — Data model](../spec/02-data-model.md) § "3. Invariants", § "4. What workspace context must be persisted" (TOOL_SUMMARY text, restoration notice)
- [spec 06 — Testing](../spec/06-testing.md) § "2" (`apps/worker` bullet), § "3" ("Worker end-to-end with fake provider + real Docker"), § "7. Test doubles"
- Contract and implementation files you consume: `packages/core/src/persistence/ports.ts`, `persistence/repositories/index.ts` (`createRepositories`, `LIVE_WORKSPACE_STATUSES`), `persistence/client.ts`, `workspace/types.ts` + `workspace/**` (W1-F: lifecycle, `ensureWorkspaceDecision`, idle selection, orphan decision), `restore/**` (W1-F: `buildRestoreContext` / `TurnRequest` builder, `TOOL_SUMMARY` formatter), `scheduling/**` (W1-F: `reconcile`, `nextRunAt`), `queues/contracts.ts` + `queues/{queues,schedulers}.ts` (W1-F factories), `secrets/**` + `redaction/**` + `logging/**` (W1-A), `runner/types.ts` + `runner/docker/**` (W1-B), `agent-protocol/*` (schemas, `encodeLine`, `createNdjsonParser`, `parseNdjsonStream`), `model/types.ts`, `config/*`, `errors.ts`, `testing/*` (`FakeWorkspaceRunner`, `createInMemoryRepositories`, `FakeClock`, canaries), `packages/agent-runtime/src/**` (how the fake provider is selected/scripted inside the container — read only), `apps/worker/src/{boot,logger,main}.ts` (W0)

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 2B.1 | DI container, worker env, events publisher (XADD), cancel command listener, worker test utilities (`scriptedRuntime`) | ✅ | P0 | M | — |
| 2B.2 | `processors/run-turn.ts` — ensure workspace, exec runtime, event → redact → publish → persist, failures, stalled recovery, cancel | ✅ | P0 | L | 2B.1 |
| 2B.3 | `processors/run-scheduled-job.ts` + `scheduler-reconcile.ts` — overlap policy, JOB workspace, destroy in `finally`, boot reconcile | ✅ | P0 | L | 2B.2 |
| 2B.4 | `processors/gc.ts` (reap-idle, destroy-chat-workspace, orphan reconcile) + `main.ts` wiring, image check, graceful shutdown | ✅ | P0 | M | 2B.3 |
| 2B.5 | 🐳 Integration suite `@docker @db @redis` — full turn, GC idle + orphan, restore turn, scheduled run | 📋 | P0 | L | 2B.4 |
| 2B.6 | Close-out: gates, code review, dashboard, PR | 📋 | P0 | S | 2B.1–2B.5 |

---

## Task 2B.1 — DI container, worker env, events publisher, cancel command listener, test utilities

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** Build the seams every processor uses: a `WorkerContainer` assembled from core factories (config, logger, prisma + repositories, three Redis connections, `SecretsService` with `reveal`, `Redactor`, runner chosen by `WORKSPACE_RUNNER`, queues), the Redis Streams publisher (`XADD … MAXLEN ~ 5000` + `EXPIRE 3600`), the cancel command listener over pub/sub, and the worker test utilities: a scripted runtime for `FakeWorkspaceRunner`, in-memory publisher/listener, and a `createTestContainer()` that wires in-memory everything.

**Acceptance criteria**
- [x] `src/container.ts`: `createContainer(opts: { config, env?, overrides? }): Promise<WorkerContainer>` with `WorkerContainer = { config, workerEnv, logger, clock, prisma, repos, redis: { queue, worker, subscriber }, secrets, redactor, runner, publisher, commands, queues: { chatTurns, scheduledJobs, workspaceGc }, close(): Promise<void> }`; `workerEnv` parsed by a local Zod schema from `process.env` (`WORKSPACE_RUNNER: 'docker' | 'fake'` default `docker`); the `worker` Redis connection has `maxRetriesPerRequest: null`; `subscriber` is `queue.duplicate()`; `close()` closes queues, Redis connections (`quit`), Prisma
- [x] `src/events.ts`: `TurnEventPublisher` interface `{ publish(turnId, event): Promise<string> }` and `createTurnEventPublisher(redis)` issuing `XADD <turnEventsStreamKey(turnId)> MAXLEN ~ 5000 * type <event.type> data <JSON>` and `EXPIRE <key> 3600` in one `multi()`; returns the stream id; constants `EVENT_STREAM_MAXLEN = 5000`, `EVENT_STREAM_TTL_SECONDS = 3600` exported
- [x] `src/commands.ts`: `CommandListener` interface `{ subscribe(turnId, handlers: { onCancel(): void }): Promise<() => Promise<void>> }` and `createCommandListener(subscriberRedis, logger)` sharing ONE subscriber connection: `SUBSCRIBE <turnCommandChannel(turnId)>`, routes messages by channel through a `Map`, accepts payload `cancel` or JSON `{ "type": "cancel" }`, ignores anything else with a warn log; the returned function unsubscribes and removes the handler
- [x] `src/testing/{scripted-runtime,in-memory-publisher,in-memory-commands,test-container,fake-secrets}.ts`: `scriptedRuntime(events, opts?)` → `ExecScript` for `FakeWorkspaceRunner` matching `cmd[0] === 'node' && cmd.at(-1) === 'turn'` (the `started` event comes from `FakeWorkspaceRunner` itself), emitting stdout chunks of `encodeLine(event)` (optionally split mid-line and coalesced across lines to exercise the parser), optional stderr noise, `exit { code }`; `opts.holdUntilSignal` makes it emit the first N events then await the abort signal and emit `turn.cancelled` + exit 0; `InMemoryTurnEventPublisher` records `{ turnId, event }[]`; `InMemoryCommandListener` with `emitCancel(turnId)`; `FakeSecretsService` backed by a Map with `reveal`; `createTestContainer(overrides?)` returning the `WorkerContainer` shape with in-memory repos (`createInMemoryRepositories(clock)`), `FakeClock`, `FakeWorkspaceRunner`, real `Redactor` (W1-A), `FakeSecretsService` seeded with the canaries, in-memory publisher/listener, a no-op queue stub typed to the subset processors use
- [x] Unit tests 100 %: container env schema (default/`fake`/invalid), `createContainer` with injected factories (Redis options incl. `maxRetriesPerRequest: null` on the worker connection, `duplicate()` for the subscriber, runner selection, `close()` ordering); publisher with an ioredis mock asserting exact `xadd`/`expire` args and the key from `turnEventsStreamKey`; listener routing two turns on one connection, cancel payload variants, unsubscribe, unknown payload warn; test utilities (scripted runtime ordering and split chunks, hold-until-signal)

**Files to create/modify**
`apps/worker/src/{container,container.test,events,events.test,commands,commands.test,env,env.test}.ts`, `apps/worker/src/testing/{scripted-runtime,in-memory-publisher,in-memory-commands,fake-secrets,test-container,index}.ts` (+ tests), `apps/worker/vitest.config.ts` (exclude `*.integration.test.ts` unless `DOCKER_AVAILABLE=1`).

**Agent prompt**

````
You are a senior backend engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · BullMQ 6 + ioredis 6 (Redis 8) · Prisma 7.9 via `@agent-hangar/core` · pino · Vitest 4. The worker runs on the host and talks to Docker only through `WorkspaceRunner`.
Branch feat/w2b-worker (worktree, branched off latest main). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-B 🐳 (Worker processors) — Task 2B.1 of 6 (FIRST)

PRECONDITIONS
- W0, W1-A, W1-B, W1-C, W1-D, W1-E, W1-F merged to main; you branched off latest main. `pnpm install --frozen-lockfile`, `pnpm db:generate`, `pnpm typecheck` green.
- Local stack for this lane: `eval "$(AH_INSTANCE=w2b AH_PORT_BASE=3300 bash infra/scripts/env.sh --print)"`, `docker compose -f infra/docker-compose.yml up -d --wait`, `pnpm --filter @agent-hangar/core db:migrate`, `pnpm infra:image` (workspace image with the runtime bundle).

REQUIRED READING (only these):
- apps/worker/src/{boot,logger,main}.ts and apps/worker/vitest.config.ts (W0 — you extend, not replace)
- packages/core/src/config/schema.ts (`loadConfig`, variable names), packages/core/src/queues/contracts.ts (`QUEUE_NAMES`, `JOB_NAMES`, payload schemas, `turnEventsStreamKey`, `turnCommandChannel`), packages/core/src/queues/{queues,schedulers}.ts (W1-F factories — use them; do not `new Queue()` directly if a factory exists)
- packages/core/src/persistence/{client.ts,repositories/index.ts}, packages/core/src/secrets/index.ts (service factory, `reveal`), packages/core/src/redaction/index.ts (`Redactor` with live-value registration), packages/core/src/logging/index.ts
- packages/core/src/runner/types.ts, packages/core/src/runner/docker/index.ts (constructor of `DockerWorkspaceRunner`), packages/core/src/testing/index.ts (`FakeWorkspaceRunner` + `ExecScript`, `createInMemoryRepositories`, `FakeClock`, canaries)
- packages/core/src/agent-protocol/{schemas,ndjson}.ts (`AgentEvent`, `encodeLine`)
- docs/spec/03-interfaces.md § "4" (SSE framing paragraph) and § "5. Queue contracts"

TASK
Create the worker's dependency container, the Redis Streams event publisher, the cancel command listener, and the test utilities that let every processor be unit-tested without Docker, Postgres or Redis.

DELIVERABLES

1. `apps/worker/src/env.ts` — `workerEnvSchema = z.object({ WORKSPACE_RUNNER: z.enum(['docker','fake']).default('docker') })`, `parseWorkerEnv(env = process.env): WorkerEnv` throwing `ConfigError` with the Zod issues on failure. (This variable is worker-local; it is intentionally not in core's config schema. Mention it in the PR; if the orchestrator prefers it in core, that is an additive `contractChangeRequest`.)
2. `apps/worker/src/container.ts` — `createContainer({ config, env?, factories? })`. `factories` (all optional, default to the real core functions — this is how tests inject) = `{ createPrismaClient, createRepositories, createRedis: (url, opts) => Redis, createSecretsService, createRedactor, createLogger, createRunner: (kind, deps) => WorkspaceRunner, createQueues, now }`. Wiring:
   - `logger = createLogger(config.LOG_LEVEL)` (W1-A factory with redaction serializer); `clock = { now }`.
   - `prisma = createPrismaClient({ connectionString: config.DATABASE_URL })`; `redactor = createRedactor()` (W1-A; exposes live-value registration — read its API, e.g. `register(values: string[])`); `repos = createRepositories(prisma, redactor)`.
   - Redis: `queue = createRedis(config.REDIS_URL)` (producer defaults), `worker = createRedis(config.REDIS_URL, { maxRetriesPerRequest: null })` (BullMQ Worker requirement), `subscriber = queue.duplicate()`.
   - `secrets = createSecretsService({ repository: repos.secrets, masterKeyPath: config.MASTER_KEY_PATH })` (adapt to W1-A's factory signature). Document in JSDoc that `reveal` is legal here and nowhere else.
   - `runner`: `workerEnv.WORKSPACE_RUNNER === 'docker'` → `new DockerWorkspaceRunner({ dockerHost: config.DOCKER_HOST, … })` (read W1-B's constructor); `'fake'` → `new FakeWorkspaceRunner()` (from `@agent-hangar/core/testing` — a runtime import of the testing subpath is acceptable only in this branch of `container.ts`; document why: it enables `WORKSPACE_RUNNER=fake` for local UI work and for W2-C's harness).
   - `queues = createQueues(worker/queue connections)` per W1-F's factory (`chatTurns`, `scheduledJobs`, `workspaceGc`).
   - `publisher = createTurnEventPublisher(queue)`, `commands = createCommandListener(subscriber, logger)`.
   - `close()`: close queues → `commands`' subscriber `quit()` → `worker.quit()` → `queue.quit()` → `disconnectPrisma(prisma)`; idempotent.
3. `apps/worker/src/events.ts`:
   ```ts
   export const EVENT_STREAM_MAXLEN = 5000;
   export const EVENT_STREAM_TTL_SECONDS = 3600;
   export interface TurnEventPublisher { publish(turnId: string, event: AgentEvent): Promise<string>; }
   export function createTurnEventPublisher(redis: Redis): TurnEventPublisher {
     return {
       async publish(turnId, event) {
         const key = turnEventsStreamKey(turnId);
         const [xadd] = await redis.multi()
           .xadd(key, 'MAXLEN', '~', String(EVENT_STREAM_MAXLEN), '*', 'type', event.type, 'data', JSON.stringify(event))
           .expire(key, EVENT_STREAM_TTL_SECONDS)
           .exec() ?? [];
         // unwrap ioredis [err, result] tuple; throw err if present; return the id string
       },
     };
   }
   ```
   Stream entry fields are `type` (the `AgentEvent.type`) and `data` (full event JSON) — W2-A's SSE route maps them to `event:`/`data:`. State this in the file header and in the PR body so both lanes agree.
4. `apps/worker/src/commands.ts` — `createCommandListener(subscriber, logger): CommandListener`. One `subscriber.on('message', (channel, payload) => …)` handler installed lazily on first subscribe; `Map<channel, handlers>`; `subscribe(turnId, handlers)` → `await subscriber.subscribe(turnCommandChannel(turnId))`, store handlers, return `async () => { map.delete(channel); await subscriber.unsubscribe(channel); }`. Payload accepted as cancel: exact string `cancel`, or JSON with `type === 'cancel'`; anything else → `logger.warn({ channel }, 'ignored unknown command')`. Never throws from the message handler (wrap in try/catch → warn).
5. `apps/worker/src/testing/` (exported via `index.ts`; counted in coverage; the worker's own test doubles — core's doubles stay in core):
   - `scripted-runtime.ts`: `scriptedRuntime(events: AgentEvent[], opts: { exitCode?: number; splitChunks?: boolean; stderr?: string[]; holdUntilSignal?: { afterEvent: number } } = {}): ExecScript` — `match: cmd => cmd[0] === 'node' && cmd[cmd.length - 1] === 'turn'`; `events: async function* (spec) { /* `FakeWorkspaceRunner` yields the `started` event itself per W0 Task 0.4 — verify in its source and do not duplicate it */ for each event: bytes = encodeLine(event); if splitChunks: yield first half, then second half joined with the start of the next line; else yield whole; if holdUntilSignal and index === afterEvent: await abort (spec.signal or the runner's per-exec AbortController — use whatever `FakeWorkspaceRunner.signal` triggers) then yield encodeLine({ type: 'turn.cancelled' }) and exit 0 and return; after all events yield `exit { code: exitCode ?? 0 }` }`. Also export `stdinOf(spec: ExecSpec): Promise<string>` to read the `TurnRequest` the processor wrote (tests assert `prepare.clone`, `items`, `repo.workBranch`).
   - `in-memory-publisher.ts`: `InMemoryTurnEventPublisher implements TurnEventPublisher` with `records: { turnId; event }[]`, `eventsFor(turnId)`.
   - `in-memory-commands.ts`: `InMemoryCommandListener implements CommandListener` with `emitCancel(turnId)`, `subscriptions` count.
   - `fake-secrets.ts`: `FakeSecretsService implements SecretsService` over a `Map<SecretKey, string>`; `reveal` returns the value or null; `status()` derived; `set/remove` simple.
   - `test-container.ts`: `createTestContainer(overrides?: Partial<TestContainer>): TestContainer` — `clock = new FakeClock()`, `repos = createInMemoryRepositories(clock)`, `runner = new FakeWorkspaceRunner()`, `redactor = createRedactor()` (W1-A real), `secrets = new FakeSecretsService({ GITHUB_PAT: GITHUB_CANARY, OPENAI_API_KEY: OPENAI_CANARY })`, `publisher`, `commands`, `logger` (pino with `level: 'silent'`), `config = loadConfig({ ...minimal env… })`, `queues` = a tiny recording `FakeQueue` class (no `vitest` import in `src/**`; fleshed out in Task 2B.3 as `testing/fake-queues.ts`). The shape is a structural subset of `WorkerContainer` that processors accept (`ProcessorDeps`), so production and tests share the same type.
6. `apps/worker/vitest.config.ts` — keep `coverage.include: ['src/**']`, thresholds 100×4; `exclude` gains `src/**/*.integration.test.ts` when `process.env.DOCKER_AVAILABLE !== '1'`; add `test.testTimeout` 20 s for integration files (or a separate `projects` entry `integration`). Add `"test:integration": "DOCKER_AVAILABLE=1 vitest run --project integration"` (or equivalent) to `apps/worker/package.json` scripts.
7. Tests (unit, 100 %): `env.test.ts` (default docker, fake, invalid → ConfigError listing the issue); `container.test.ts` (injected factories: assert `createRedis` called twice with the right options, `duplicate()` once, runner selection both branches, secrets factory receives the repo and key path, `close()` calls in order and is idempotent); `events.test.ts` (ioredis mock with `multi().xadd().expire().exec()` chain — assert argument arrays exactly, returned id, error tuple → throws); `commands.test.ts` (two turns on one connection routed independently, `cancel` string and JSON, unknown payload → warn and no handler call, unsubscribe removes, handler exception swallowed with warn); `testing/*.test.ts` (scripted runtime yields in order with/without split chunks and the `TurnRequest` read back via `stdinOf`; hold-until-signal resumes on `runner.signal(..., 'INT')`; publisher/listener/fake-secrets/test-container basics).

Constraints:
- Follow /bymax-workflow:standards: TS strict, JSDoc + headers, English, no `enum`, no suppression comments, test headers and it() comments.
- Owned paths only; no new dependencies; no `dockerode`/`openai` imports in the worker.
- Production code never imports from `vitest`; test doubles in `src/testing/**` are plain classes.

Verification:
- `pnpm --filter worker test -- --coverage` — green, 100 % on `src/**` (integration files excluded without DOCKER_AVAILABLE)
- `pnpm typecheck && pnpm lint` — exit 0
- `WORKSPACE_RUNNER=fake pnpm --filter worker dev` — boots against the w2b stack and logs "worker ready" (processors not yet registered)

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-2b-worker.md (task index row and task block)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/6 tasks`)
4. Append a completion log entry at the end of the file: `- 2B.1 ✅ <YYYY-MM-DD> — <one-line summary>`
5. Commit: `feat(worker): add DI container, event publisher, cancel listener and test utilities`
````

---

## Task 2B.2 — `processors/run-turn.ts`

**Status:** ✅ Done · **Priority:** P0 · **Size:** L · **Depends on:** 2B.1

**Description.** Implement flow (a) and (b) of spec 04 as the `run-turn` consumer: load Turn/Chat, recover from a stalled previous attempt, decide reuse-vs-create through core's `ensureWorkspaceDecision`, create the workspace with revealed secrets (registered in the redactor), build the `TurnRequest` with core's restore builder, `exec` the runtime with the request on stdin, parse NDJSON `AgentEvent`s, and for each event redact → publish → persist; handle every failure path, the cancel channel, and the terminal bookkeeping (Turn status/usage/steps, Workspace READY + `lastActiveAt`, Chat restore hints on `git.pushed`, `TOOL_SUMMARY` and `ASSISTANT` messages).

**Acceptance criteria**
- [x] `createRunTurnProcessor(deps: ProcessorDeps): (job: Job<RunTurnPayload>) => Promise<void>` exported; payload validated with `runTurnPayloadSchema`; unknown/terminal turn → log + return
- [x] Stalled recovery: if the chat's live workspace is `BUSY` at pickup (or `job.attemptsMade > 0` and a live workspace exists), the workspace is destroyed (`runner.destroy`, ignore errors), marked `DESTROYED` with `failureReason 'stalled turn recovery'`, a `SYSTEM` message is appended ("Previous workspace was lost while a turn was running; a fresh workspace was created."), and the turn continues with a new workspace
- [x] Create path: Workspace `CREATING` (kind CHAT, image, runnerKind, repoUrl, branch) → `secrets.reveal` both keys (missing → Turn `FAILED` `secrets_missing`, Workspace `FAILED`, `turn.failed` published, return) → `redactor.register([pat, key])` → `runner.create({ workspaceId, kind: 'CHAT', image, env: { GITHUB_TOKEN, OPENAI_API_KEY, GIT_ASKPASS: '/opt/agent-runtime/askpass.sh', OPENAI_MODEL, AGENT_MODEL_PROVIDER, OPENAI_BASE_URL? }, limits: WORKSPACE_LIMITS, labels: { 'ah.instance', 'ah.workspace', 'ah.kind': 'CHAT', 'ah.chat' } })` → `WorkspaceImageMissing` → Workspace `FAILED`, Turn `FAILED` (`workspace_image_missing`, message includes `pnpm infra:image`), `turn.failed` published → else Workspace `READY` with `runnerRef`, `readyAt`
- [x] Reuse path: `runner.health(handle)`; `gone`/`unhealthy` → mark old `DESTROYED`/`FAILED` and fall through to create; otherwise `prepare.clone = false`
- [x] `TurnRequest` built by core's restore builder (W1-F) with `turnId`, `model = config.OPENAI_MODEL`, history window from `messages.listByChat`, `repo { url, baseBranch, workBranch (chat.workBranch ?? 'agent/<chatId first 8>' — persisted via `updateRestoreHints` when first assigned), expectedHeadSha: chat.lastPushedSha }`, `TURN_LIMITS` (40 steps / 20 min / 5 min tool / 32 KB), `prepare.clone` per decision; Workspace → `BUSY`; Turn → `RUNNING` on `turn.started`
- [x] Exec: cancel subscription installed before `runner.exec(handle, ['node','/opt/agent-runtime/cli.js','turn'], { stdin: encodeLine(request), timeoutMs: maxTurnMs + 60_000 })`; `started` event captured for `execRef`; on cancel → `runner.signal(handle, execRef, 'INT')`, and `'KILL'` if no terminal event within `CANCEL_GRACE_MS = 10_000` (fake timers in tests)
- [x] Event handling (stdout → `createNdjsonParser(agentEventSchema)`; stderr → `logger.debug` redacted; every event `redactor.redactJson` → `publisher.publish` → persist): `tool.call` → `toolCallLogs.start`; `tool.output.delta` → accumulate per `callId` up to 8 KB; `tool.result` → `toolCallLogs.finish` with accumulated head; `git.pushed` → `chats.updateRestoreHints({ workBranch, lastPushedSha })`; `turn.completed` → `TOOL_SUMMARY` messages (one per tool call, seq order, text from core's formatter), `ASSISTANT` message `finalMessage`, `turns.finish(SUCCEEDED, usage, steps)`, Workspace `READY` + `lastActiveAt`, `chats.touch`; `turn.failed` → `turns.finish(FAILED, error '<code>: <message>')`, Workspace `READY`; `turn.cancelled` → `CANCELLED`, Workspace `READY`; `protocol.error` → warn + counter; non-zero exit without terminal event → `FAILED 'runtime exited with code N'` + synthesized `turn.failed` published; exit `signal: 'TIMEOUT'` → `FAILED 'turn timed out'`; runner transport exception → Workspace `FAILED`, Turn `FAILED`, rethrow only if it is a connectivity error to Docker (so BullMQ retries) — otherwise resolve
- [x] `finally`: unsubscribe cancel; if Turn still non-terminal → `FAILED 'worker error: …'`; if Workspace still `BUSY` → `READY`; canary never appears in any persisted row or published event (tests assert with `assertNoCanary` over the in-memory repos and publisher records)
- [x] 100 % coverage with `createTestContainer()` + `scriptedRuntime`

**Files to create/modify**
`apps/worker/src/processors/{run-turn,run-turn.test,turn-executor,turn-executor.test,constants}.ts`, `apps/worker/src/processors/types.ts` (`ProcessorDeps`).

**Agent prompt**

````
You are a senior backend engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · BullMQ 6 · `@agent-hangar/core` (runner, repositories, restore builder, workspace lifecycle, redaction, agent protocol codec) · Vitest 4 with fake timers.
Branch feat/w2b-worker (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-B 🐳 — Task 2B.2 of 6 (MIDDLE)

PRECONDITIONS
- Task 2B.1 done: `WorkerContainer`, `TurnEventPublisher`, `CommandListener`, `createTestContainer`, `scriptedRuntime` exist.

REQUIRED READING (only these):
- docs/spec/04-flows.md (a) diagram + "Edge cases" + "Second and later messages"; (b) RESTORE half
- docs/spec/03-interfaces.md § "3. Agent runtime protocol" (`TurnRequest`, every `AgentEvent`, exit code semantics, cancellation), § "1" DockerWorkspaceRunner behaviour (labels)
- docs/spec/02-data-model.md § "3. Invariants" 1–2, § "4" (TOOL_SUMMARY, restoration notice)
- packages/core/src/workspace/** (W1-F: `ensureWorkspaceDecision` signature and the decision union from workspace/types.ts; lifecycle transition helper if any), packages/core/src/restore/** (W1-F: the `TurnRequest`/history-window builder and the TOOL_SUMMARY formatter — use their exact names), packages/core/src/persistence/ports.ts (repo methods), packages/core/src/agent-protocol/{schemas,ndjson,types}.ts, packages/core/src/runner/types.ts, packages/core/src/errors.ts (`WorkspaceImageMissing`), packages/core/src/queues/contracts.ts (`runTurnPayloadSchema`)
- apps/worker/src/{container,events,commands}.ts and apps/worker/src/testing/index.ts

TASK
Implement the `run-turn` processor end to end — workspace ensure/create/reuse with stalled recovery, runtime exec over `WorkspaceRunner`, NDJSON event handling with redact → publish → persist, every failure path, cancellation — against the test container, to 100 % coverage.

DELIVERABLES

1. `apps/worker/src/processors/types.ts` — `ProcessorDeps` = the structural subset of `WorkerContainer` processors need: `{ config, logger, clock, repos, runner, secrets, redactor, publisher, commands, queues? }`. `createTestContainer()` satisfies it.
2. `apps/worker/src/processors/constants.ts` — `WORKSPACE_LIMITS = { cpus: 2, memoryBytes: 2 * 1024 ** 3, pids: 512 }`, `TURN_LIMITS = { maxSteps: 40, maxTurnMs: 20 * 60_000, toolTimeoutMs: 5 * 60_000, maxToolOutputBytes: 32 * 1024 }`, `JOB_LIMITS = { ...TURN_LIMITS, maxTurnMs: 30 * 60_000 }`, `RUNTIME_CMD = ['node', '/opt/agent-runtime/cli.js', 'turn'] as const`, `ASKPASS_PATH = '/opt/agent-runtime/askpass.sh'`, `EXEC_GRACE_MS = 60_000`, `CANCEL_GRACE_MS = 10_000`, `TOOL_OUTPUT_HEAD_BYTES = 8 * 1024`, `STALLED_RECOVERY_NOTE`, `DEFAULT_WORK_BRANCH_PREFIX = 'agent/'`. All exported with JSDoc (no magic numbers elsewhere).
3. `apps/worker/src/processors/turn-executor.ts` — the part shared with scheduled jobs (Task 2B.3): `executeRuntimeTurn(deps, { handle, request, sink, cancelKey }): Promise<ExecOutcome>` where `sink: TurnSink = { onEvent(event: AgentEvent): Promise<void> }` receives ALREADY-REDACTED events (this function redacts and publishes, then calls the sink for persistence), `cancelKey` is the id whose command channel is subscribed (`turnId` or `jobRunId`), and `ExecOutcome = { terminal: 'completed' | 'failed' | 'cancelled' | 'exited' | 'timeout' | 'transport-error'; exitCode: number | null; error?: { code: string; message: string }; protocolErrors: number }`. Internals: subscribe cancel → `runner.exec(handle, RUNTIME_CMD, { stdin: encodeLine(request), timeoutMs: request.limits.maxTurnMs + EXEC_GRACE_MS })` → loop over `ExecEvent`s: `started` → store `execRef`; `stdout` → `parser.push(data)` → for each parsed event: `safe = redactor.redactJson(ev)` → `publisher.publish(cancelKey, safe)` → `sink.onEvent(safe)`; remember the last terminal type; `stderr` → `logger.debug({ line: redactor.redact(text) })`; `exit` → stop. Cancel handler: `runner.signal(handle, execRef, 'INT')`, then a timer (`setTimeout`, unref'd) of `CANCEL_GRACE_MS` that sends `'KILL'` if no terminal event arrived; clear it in `finally`. After the loop: `parser.flush()` remaining events; classify the outcome (terminal event seen → that; else exit code 0 → `'exited'` treated as failed with `runtime ended without terminal event`; non-zero → `'exited'` with `runtime exited with code N`; `signal 'TIMEOUT'` → `'timeout'`). Transport exceptions from `runner.exec` → `'transport-error'` with the error message (redacted). Always unsubscribe in `finally`.
4. `apps/worker/src/processors/run-turn.ts` — `createRunTurnProcessor(deps)`:
   a. `const { turnId } = runTurnPayloadSchema.parse(job.data)`; `turn = await repos.turns.get(turnId)`; missing or terminal status → `logger.warn` and return.
   b. `chat = await repos.chats.getById(turn.chatId)`; missing → `turns.finish(FAILED, 'chat not found')`, return. `await turns.setStatus(turnId, 'PREPARING')`.
   c. `live = await repos.workspaces.findLiveByChat(chat.id)`. Stalled recovery: if `live && (live.status === 'BUSY' || job.attemptsMade > 0)` → `try { await runner.destroy({ workspaceId: live.id, runnerRef: live.runnerRef ?? '' }) } catch { /* log */ }`; `workspaces.setStatus(live.id, 'DESTROYED', { failureReason: 'stalled turn recovery' })`; `messages.append(chat.id, 'SYSTEM', STALLED_RECOVERY_NOTE)`; `live = null`.
   d. If `live` → `health = await runner.health(handle)`; `gone` → `setStatus(DESTROYED)`, `live = null`; `unhealthy` → `setStatus(FAILED, { failureReason })`, `live = null`.
   e. `decision = ensureWorkspaceDecision(…)` from core (pass whatever it needs: chat, live workspace, restore hints — read the signature). If `action === 'reuse'` → `handle = { workspaceId: live.id, runnerRef: live.runnerRef }`, `clone = false`. If `create` → step f.
   f. Create: `ws = workspaces.create({ kind: 'CHAT', chatId, runnerKind: runner.kind, image: config.WORKSPACE_IMAGE, repoUrl: chat.repoUrl, branch: chat.workBranch ?? chat.baseBranch })` (catch `LiveWorkspaceConflictError` → reload `findLiveByChat` and reuse it — a race with another attempt); reveal: `pat = await secrets.reveal('GITHUB_PAT')`, `key = await secrets.reveal('OPENAI_API_KEY')`; any null → `workspaces.setStatus(ws.id, 'FAILED', { failureReason: 'secrets missing' })`, `fail(turn, 'secrets_missing', 'Configure the GitHub PAT and OpenAI API key in Settings')`, return; `redactor.register([pat, key])` (W1-A API name); `env = { GITHUB_TOKEN: pat, OPENAI_API_KEY: key, GIT_ASKPASS: ASKPASS_PATH, OPENAI_MODEL: config.OPENAI_MODEL, AGENT_MODEL_PROVIDER: config.AGENT_MODEL_PROVIDER, ...(config.OPENAI_BASE_URL ? { OPENAI_BASE_URL } : {}) }`; labels `{ 'ah.instance': config.AH_INSTANCE, 'ah.workspace': ws.id, 'ah.kind': 'CHAT', 'ah.chat': chat.id }`; `handle = await runner.create(spec)`; catch `WorkspaceImageMissing` → `setStatus(FAILED, { failureReason: e.message })`, `fail(turn, 'workspace_image_missing', e.message)`, return; other errors → `setStatus(FAILED)`, `fail(turn, 'workspace_create_failed', redacted message)`, and rethrow if `isTransportError(e)` (a Docker connectivity failure — detect by error `code` in `ECONNREFUSED|ENOENT|EACCES` on the socket; keep the predicate in `constants.ts`/`errors.ts` of the worker). Success → `setStatus(ws.id, 'READY', { runnerRef: handle.runnerRef })`, `turns.attachWorkspace?(turnId, ws.id)` if the port has it. `clone = true`.
   g. `workBranch = chat.workBranch ?? `${DEFAULT_WORK_BRANCH_PREFIX}${chat.id.slice(0, 8)}``; if newly assigned → `chats.updateRestoreHints(chat.id, { workBranch })`. Build the request with core's builder: history = `messages.listByChat(chat.id)`; `request = buildTurnRequest({ turnId, model: config.OPENAI_MODEL, chat, messages: history, toolCalls?, workBranch, expectedHeadSha: chat.lastPushedSha, limits: TURN_LIMITS, clone })` — use W1-F's exact function and fields; if W1-F's builder already derives `workBranch`/`expectedHeadSha`, do not duplicate.
   h. `workspaces.setStatus(ws.id, 'BUSY')`; `outcome = await executeRuntimeTurn(deps, { handle, request, cancelKey: turnId, sink })` where the sink persists:
      - `turn.started` → `turns.setStatus(turnId, 'RUNNING')`.
      - `tool.call` → `toolCallLogs.start({ workspaceId, turnId, callId, seq, toolName: name, args })`; init head buffer.
      - `tool.output.delta` → append `text` to the head buffer of `callId` until `TOOL_OUTPUT_HEAD_BYTES`.
      - `tool.result` → `toolCallLogs.finish(<ref per port>, { status, exitCode, resultBytes: bytes, durationMs, resultHead: buffer })`.
      - `git.pushed` → `chats.updateRestoreHints(chat.id, { workBranch: branch, lastPushedSha: sha })`.
      - `turn.completed` → for each finished tool call in `seq` order: `messages.append(chat.id, 'TOOL_SUMMARY', formatToolSummary(log), turnId)` (core formatter); `messages.append(chat.id, 'ASSISTANT', finalMessage, turnId)`; `turns.finish(turnId, { status: 'SUCCEEDED', usage, stepCount: steps })`.
      - `turn.failed` → `turns.finish(turnId, { status: 'FAILED', error: `${code}: ${message}`, usage: zero, stepCount })`.
      - `turn.cancelled` → `turns.finish(turnId, { status: 'CANCELLED', … })`.
      - other events (`prepare.*`, `step.started`, `assistant.*`, `heartbeat`, `protocol.error`) → no persistence (they are published; `protocol.error` also `logger.warn`).
   i. After the outcome: `'exited'`/`'timeout'`/`'transport-error'` without a terminal event → `turns.finish(FAILED, error)` + `publisher.publish(turnId, { type: 'turn.failed', error: { code: outcome.terminal, message } })`; `transport-error` additionally `workspaces.setStatus(FAILED)` and rethrow. Otherwise `workspaces.setStatus(ws.id, 'READY')` (bumps `lastActiveAt`), `chats.touch(chat.id)`.
   j. `finally`: if the turn is still non-terminal (re-read) → `turns.finish(FAILED, 'worker error: <redacted>')`; if the workspace is still `BUSY` → `READY`.
   Keep `run-turn.ts` readable: split into `ensureWorkspace(deps, ctx)`, `createWorkspace(deps, ctx)`, `buildRequest(deps, ctx)`, `makeTurnSink(deps, ctx)`, `finalizeTurn(deps, ctx, outcome)`; each under 60 lines; the processor function composes them.
5. Tests — `run-turn.test.ts` with `createTestContainer()`, seeded Chat + USER message + Turn (QUEUED), `runner.scripts = [scriptedRuntime([...])]`, `job = { data: { turnId }, attemptsMade: 0 }` (structural, typed as `Pick<Job<RunTurnPayload>, 'data' | 'attemptsMade' | 'id'>`):
   - happy path (new chat): events `turn.started, prepare.progress, prepare.done, step.started, assistant.delta, tool.call(write_file seq 1), tool.output.delta ×2, tool.result(SUCCEEDED), git.pushed, assistant.message, turn.completed{usage, steps:2, finalMessage}` → asserts: Workspace created `kind CHAT` with labels `ah.instance`/`ah.workspace`/`ah.kind`/`ah.chat`, env has `GITHUB_TOKEN=GITHUB_CANARY`, `OPENAI_API_KEY=OPENAI_CANARY`, `GIT_ASKPASS`, `AGENT_MODEL_PROVIDER`; the `TurnRequest` read via `stdinOf` has `prepare.clone true`, `repo.workBranch 'agent/<8>'`, `items` containing the user message, `limits` = TURN_LIMITS; published events equal the script in order (redacted); ToolCallLog start+finish with `resultHead` = joined deltas; Messages appended in order `TOOL_SUMMARY`, `ASSISTANT` with `seq` continuing after the USER message; Turn SUCCEEDED with usage/stepCount/startedAt/finishedAt; Workspace READY, `lastActiveAt` advanced; Chat `workBranch`/`lastPushedSha` updated from `git.pushed`.
   - second message (live READY workspace) → `prepare.clone false`, no `runner.create` call, same workspace id on the turn.
   - reuse with `health` gone → old DESTROYED, new created, `clone true`.
   - stalled recovery: live workspace BUSY → `runner.destroy` called, DESTROYED with `failureReason 'stalled turn recovery'`, SYSTEM note appended, new workspace created.
   - secrets missing (FakeSecretsService without OPENAI key) → Turn FAILED `secrets_missing: …`, Workspace FAILED, `turn.failed` published, no `runner.create`.
   - image missing (FakeWorkspaceRunner configured to throw `WorkspaceImageMissing` on create — check the fake's option; else override `create` via a subclass in the test) → Turn FAILED `workspace_image_missing`, message contains `pnpm infra:image`.
   - runtime `turn.failed {code:'auth'}` → Turn FAILED `auth: …`, Workspace READY.
   - non-zero exit without terminal → FAILED `runtime exited with code 2`, synthesized `turn.failed` published last.
   - timeout (`exit { code: null, signal: 'TIMEOUT' }`) → FAILED `turn timed out`.
   - cancel: script `holdUntilSignal after event 3`; test calls `commands.emitCancel(turnId)` → `runner.calls` contains `signal(…, 'INT')`, script emits `turn.cancelled`, Turn CANCELLED, Workspace READY; variant where the script never answers → after `CANCEL_GRACE_MS` (fake timers) a `'KILL'` signal is sent.
   - redaction: script events contain `OPENAI_CANARY` inside `tool.call.args.command`, `tool.output.delta.text`, `assistant.message.text`, `turn.failed.error.message` → every published event and every persisted row passes `assertNoCanary`; `[REDACTED]` present.
   - split chunks / protocol error line → events still parsed; `protocol.error` published and counted, turn still SUCCEEDED.
   - transport error (runner `exec` throws `ECONNREFUSED`) → Turn FAILED, Workspace FAILED, processor rejects (BullMQ retry).
   - unknown turn / terminal turn → returns without side effects.
   - `LiveWorkspaceConflictError` race on create → reuses the existing live workspace.
   `turn-executor.test.ts` covers the executor in isolation for ordering guarantees (publish before sink; unsubscribe in finally even when the sink throws; stderr debug logging redacted).

Constraints:
- Follow /bymax-workflow:standards (JSDoc + headers, English, no enum, no suppression, it() comments; functions ≤ 60 lines).
- Owned paths only; no new deps; nothing from `packages/**` modified — missing helpers → `contractChangeRequests`.
- Plaintext secrets exist only in local variables inside `createWorkspace`; never in `ctx`, never logged, never in errors.
- Use fake timers for grace periods; never real sleeps in tests.

Verification:
- `pnpm --filter worker test -- --coverage` — green, 100 % on `src/processors/**`, `src/testing/**`
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-2b-worker.md; append `- 2B.2 ✅ <date> — <summary>`; commit `feat(worker): implement run-turn processor with workspace ensure, streaming persistence and cancel`.
````

---

## Task 2B.3 — `processors/run-scheduled-job.ts` + `scheduler-reconcile.ts`

**Status:** ✅ Done · **Priority:** P0 · **Size:** L · **Depends on:** 2B.2

**Description.** Implement flow (c): the `run-scheduled-job` consumer (enabled check, overlap policy via `findRunningByJob`, `JobRun` + fresh `JOB` workspace, same executor with `items = [user prompt]` and `JOB_LIMITS`, output = `finalMessage`, destroy in `finally`, `ScheduledJob.lastRunAt/nextRunAt`) and the boot-time reconcile of BullMQ Job Schedulers against enabled jobs plus the `reap-idle` scheduler.

**Acceptance criteria**
- [x] `createRunScheduledJobProcessor(deps)`; payload `runScheduledJobPayloadSchema` (`jobId`, `trigger` default `SCHEDULE`); job missing or `enabled === false` → log + return (ack)
- [x] Overlap: `jobRuns.findRunningByJob(jobId)` non-null → create a `JobRun` with `trigger`, `scheduledFor = now`, immediately `finish(FAILED, error 'previous run still running')`; no workspace, no exec; return
- [x] Normal: `JobRun` create (QUEUED) → `PREPARING`; Workspace `kind JOB`, `chatId` null, `branch = job.branch`; reveal + register + `runner.create` (labels `ah.instance`, `ah.workspace`, `ah.kind: 'JOB'`, `ah.jobRun`); `jobRuns.attachWorkspace`; `READY` → `RUNNING`; request via core builder with `turnId = jobRun.id`, `items = [{ role: 'user', content: job.prompt }]`, `repo { url: job.repoUrl, baseBranch: job.branch, workBranch: 'job/<runId first 8>' }`, `limits: JOB_LIMITS`, `prepare.clone true`; sink persists `ToolCallLog` with `jobRunId`, `turn.completed` → `jobRuns.finish(SUCCEEDED, output: finalMessage, usage, stepCount)`, `turn.failed` → `FAILED`, `turn.cancelled` → `CANCELLED`; events published under the run id (`events:turn:<runId>`)
- [x] `finally` (always, also on throw): `runner.destroy(handle)` (errors logged, not thrown) → Workspace `DESTROYED`; `scheduledJobs.setRunTimes(jobId, { lastRunAt: now, nextRunAt: computeNextRunAt(job.cron, job.timezone, now) })` via core scheduling; JobRun never left non-terminal
- [x] `scheduler-reconcile.ts`: `reconcileSchedulers(deps): Promise<{ upserted: number; removed: number }>` — `jobs = scheduledJobs.listEnabled()`, `existing = queues.scheduledJobs.getJobSchedulers()` (ids), `plan = reconcile(jobs, existing)` (core W1-F), `upsertJobScheduler(job.id, { pattern: job.cron, tz: job.timezone }, { name: 'run-scheduled-job', data: { jobId, trigger: 'SCHEDULE' } })` for each upsert, `removeJobScheduler(id)` for each removal, then `workspaceGc.upsertJobScheduler('reap-idle', { every: REAP_IDLE_EVERY_MS = 5 * 60_000 }, { name: 'reap-idle', data: {} })`; uses W1-F wrappers when they exist
- [x] Unit tests 100 %: disabled/missing job, overlap FAILED record, happy path (workspace created with JOB labels, request read back: items/limits/workBranch/clone, ToolCallLog rows carry `jobRunId`, JobRun SUCCEEDED with output, workspace destroyed and DESTROYED, run times updated with the cron's next tick), failure path (`turn.failed` → FAILED + destroyed), exec throws → JobRun FAILED + destroyed + rethrow on transport error, cancel path → CANCELLED + destroyed, image missing → FAILED without exec, secrets missing → FAILED; reconcile with a fake queue (upsert/remove sets from the plan, reap-idle scheduler always upserted, counts)

**Files to create/modify**
`apps/worker/src/processors/{run-scheduled-job,run-scheduled-job.test}.ts`, `apps/worker/src/{scheduler-reconcile,scheduler-reconcile.test}.ts`, `apps/worker/src/testing/fake-queues.ts` (recording queue with `getJobSchedulers`/`upsertJobScheduler`/`removeJobScheduler`/`add`).

**Agent prompt**

````
You are a senior backend engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · BullMQ 6 Job Schedulers (`upsertJobScheduler`, `removeJobScheduler`, `getJobSchedulers`) · `@agent-hangar/core` scheduling (cron validation, `nextRunAt` with tz, `reconcile`) · Vitest 4.
Branch feat/w2b-worker (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-B 🐳 — Task 2B.3 of 6 (MIDDLE)

PRECONDITIONS
- Tasks 2B.1–2B.2 done: `executeRuntimeTurn`, `createWorkspace`-style helpers, `ProcessorDeps`, test container.

REQUIRED READING (only these):
- docs/spec/04-flows.md (c) diagram + "Guarantees"
- docs/spec/03-interfaces.md § "5. Queue contracts"
- docs/spec/02-data-model.md § "3. Invariants" item 3
- packages/core/src/scheduling/** (W1-F: `computeNextRunAt`/`nextRunAt`, `reconcile(dbJobs, schedulers)` → `ReconcilePlan`, `OverlapPolicy`), packages/core/src/queues/{contracts,queues,schedulers}.ts (W1-F wrappers), packages/core/src/persistence/ports.ts (`ScheduledJobRepository`, `JobRunRepository`, `WorkspaceRepository`)
- apps/worker/src/processors/{run-turn,turn-executor,constants,types}.ts (reuse `createWorkspace`-like helper — extract a shared `provisionWorkspace(deps, { kind, chatId?, jobRunId?, repoUrl, branch })` into `processors/provision-workspace.ts` if not already shared)

TASK
Implement the scheduled-job consumer with the overlap policy, fresh-workspace-per-run and destroy-in-finally guarantees, and the boot reconcile of job schedulers (plus the `reap-idle` scheduler).

DELIVERABLES

1. `apps/worker/src/processors/provision-workspace.ts` (refactor from 2B.2 if needed; both processors use it): `provisionWorkspace(deps, input: { kind: 'CHAT' | 'JOB'; chatId?: string; jobRunId?: string; repoUrl: string; branch: string }): Promise<ProvisionResult>` where `ProvisionResult = { ok: true; workspace; handle } | { ok: false; reason: 'secrets_missing' | 'workspace_image_missing' | 'workspace_create_failed'; message: string; workspaceId?: string }`; labels include `ah.chat` or `ah.jobRun` accordingly; rethrows transport errors. `run-turn.ts` must call this helper (update its tests only where the refactor changes names, not behaviour).
2. `apps/worker/src/processors/run-scheduled-job.ts` — `createRunScheduledJobProcessor(deps)`:
   a. `{ jobId, trigger } = runScheduledJobPayloadSchema.parse(job.data)` (trigger default `'SCHEDULE'`); `sj = scheduledJobs.get(jobId)`; missing → warn + return; `!sj.enabled` → info + return.
   b. `running = jobRuns.findRunningByJob(jobId)`; if running → `run = jobRuns.create({ jobId, trigger, model: config.OPENAI_MODEL, scheduledFor: now })`; `jobRuns.finish(run.id, { status: 'FAILED', error: OVERLAP_ERROR = 'previous run still running', usage: zero, stepCount: 0 })`; `logger.info`; return.
   c. `run = jobRuns.create({ jobId, trigger, model, scheduledFor: scheduledFor(job) })` where `scheduledFor` = `new Date(job.timestamp)` for BullMQ jobs (the tick time) or `now`; `jobRuns.setStatus(run.id, 'PREPARING')`.
   d. `prov = provisionWorkspace(deps, { kind: 'JOB', jobRunId: run.id, repoUrl: sj.repoUrl, branch: sj.branch })`; `!ok` → `jobRuns.finish(FAILED, error: `${reason}: ${message}`)`, publish `turn.failed` under `run.id`, `setRunTimes`, return. ok → `jobRuns.attachWorkspace(run.id, ws.id)` (or pass `workspaceId` at create if the port does so), `jobRuns.setStatus(run.id, 'RUNNING')`, `workspaces.setStatus(ws.id, 'BUSY')`.
   e. `request = buildTurnRequest(… { turnId: run.id, model, items: [{ role: 'user', content: sj.prompt }], repo: { url: sj.repoUrl, baseBranch: sj.branch, workBranch: `${JOB_WORK_BRANCH_PREFIX}${run.id.slice(0, 8)}` }, limits: JOB_LIMITS, clone: true })` — if W1-F's builder is chat-shaped, use its lower-level `TurnRequest` assembly function or build the object directly with `turnRequestSchema.parse(...)` (it is a frozen Zod contract) — never leave the schema unvalidated.
   f. `outcome = executeRuntimeTurn(deps, { handle, request, cancelKey: run.id, sink })` with a sink persisting `ToolCallLog` rows with `jobRunId: run.id` (start/finish identical to the turn sink — extract `makeToolCallRecorder(deps, { workspaceId, turnId? | jobRunId? })` shared by both sinks), `turn.completed` → `jobRuns.finish(run.id, { status: 'SUCCEEDED', output: finalMessage, usage, stepCount: steps })`, `turn.failed` → FAILED with `${code}: ${message}`, `turn.cancelled` → CANCELLED. After the outcome, non-terminal outcomes (`exited`/`timeout`/`transport-error`) → FAILED + synthesized `turn.failed`, rethrow transport errors.
   g. `finally` (wrap d–f): if a handle exists → `try { await runner.destroy(handle) } catch (e) { logger.error(...) }`; `workspaces.setStatus(ws.id, 'DESTROYED')`; if the run is still non-terminal → `finish(FAILED, 'worker error: …')`; `scheduledJobs.setRunTimes(jobId, { lastRunAt: now, nextRunAt: computeNextRunAt({ cron: sj.cron, timezone: sj.timezone }, now) })` (core; invalid cron → `nextRunAt` omitted + warn — it cannot happen for rows validated by the API, but the worker must not crash).
3. `apps/worker/src/scheduler-reconcile.ts` — `reconcileSchedulers(deps: { repos, queues, logger }): Promise<{ upserted: number; removed: number }>` as in the acceptance criteria; `REAP_IDLE_EVERY_MS = 5 * 60_000` in `processors/constants.ts`; scheduler ids equal `ScheduledJob.id`; the `reap-idle` scheduler id is the constant `'reap-idle'` on the `workspace-gc` queue. Use W1-F's `upsertJobScheduler`/`removeJobScheduler` wrappers if present (they hide BullMQ's argument order); otherwise call BullMQ directly with `{ pattern, tz }` / `{ every }`.
4. `apps/worker/src/testing/fake-queues.ts` — `FakeQueue` recording `add(name, data, opts)`, `upsertJobScheduler(id, repeat, template)`, `removeJobScheduler(id)`, `getJobSchedulers()` (returns stored ids/patterns), `close()`; `createFakeQueues()` → `{ chatTurns, scheduledJobs, workspaceGc }` typed to the subset the worker uses (`QueueLike`). `createTestContainer` uses it.
5. Tests:
   - `run-scheduled-job.test.ts`: missing job → no JobRun; disabled → no JobRun; overlap → JobRun FAILED `previous run still running`, no `runner.create`, `setRunTimes` NOT called (the running run will update it); happy path → Workspace `kind JOB`, `chatId` undefined, labels `ah.jobRun`, request `items` = user prompt only, `limits` = JOB_LIMITS, `workBranch` `job/<8>`, `clone true`, ToolCallLog rows with `jobRunId` and no `turnId`, JobRun SUCCEEDED `output === finalMessage`, usage, `stepCount`; Workspace DESTROYED and `runner.destroy` called once; `setRunTimes` with `lastRunAt = clock.now()` and `nextRunAt` = next tick of the cron (use `'*/5 * * * *'` and a fixed `FakeClock` time; compare with core's function output); MANUAL trigger recorded; `turn.failed` → FAILED + destroyed; `turn.cancelled` via `commands.emitCancel(run.id)` → CANCELLED + destroyed; exec throws transport error → FAILED + destroyed + rejects; image missing → FAILED `workspace_image_missing`, no exec, `setRunTimes` called; secrets missing → FAILED; `runner.destroy` throwing → logged, run still terminal, workspace DESTROYED; canary in events → nothing persisted/published contains it.
   - `scheduler-reconcile.test.ts`: enabled jobs A,B + existing schedulers B,C → upsert A,B (pattern/tz/template data `{ jobId, trigger: 'SCHEDULE' }`, name `run-scheduled-job`), remove C, `reap-idle` upserted with `every: 300000`; zero jobs → only reap-idle; counts returned; idempotent second call produces the same calls (upsert is idempotent by key).

Constraints:
- Follow /bymax-workflow:standards (JSDoc + headers, English, no enum, no suppression, it() comments; functions ≤ 60 lines).
- Owned paths only; no new deps; `finally` semantics are non-negotiable (spec 04 (c) guarantee 1).
- No real timers; `FakeClock` drives `now`.

Verification:
- `pnpm --filter worker test -- --coverage` — green, 100 %
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-2b-worker.md; append `- 2B.3 ✅ <date> — <summary>`; commit `feat(worker): implement scheduled-job processor and scheduler reconcile`.
````

---

## Task 2B.4 — `processors/gc.ts` + `main.ts` wiring, image check, graceful shutdown

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 2B.3

**Description.** Implement the `workspace-gc` consumer (`reap-idle`: idle READY chat workspaces past `WORKSPACE_IDLE_TTL_MIN` are snapshotted → restore hints + SYSTEM note → destroyed; `destroy-chat-workspace`: immediate teardown on archive; orphan reconcile via `runner.list({ 'ah.instance' })` vs DB live rows, and DB-live-but-container-gone rows), and the `main.ts` wiring: boot → container → image-present check (actionable log, keep running) → reconcile schedulers → three BullMQ Workers → graceful shutdown closing workers then the container.

**Acceptance criteria**
- [x] `createGcProcessor(deps)` dispatches on `job.name`: `reap-idle` (`{}`) and `destroy-chat-workspace` (`{ chatId }`); unknown name → warn + return
- [x] reap-idle: `cutoff = now − WORKSPACE_IDLE_TTL_MIN`; for each `workspaces.listIdle(cutoff)` (READY only): `teardownWorkspace(deps, ws, { reason: 'idle', note })`; then orphan reconcile: `handles = runner.list({ 'ah.instance': config.AH_INSTANCE })`, `live = workspaces.listLive()`; handles whose `workspaceId` is not live → `runner.destroy` (log `orphan destroyed`); live rows whose `runner.health` is `gone` → `setStatus(DESTROYED, { failureReason: 'container missing' })` (BUSY rows are left alone — the turn processor handles stalled recovery); returns `{ reaped, orphansDestroyed, goneMarked }`
- [x] `teardownWorkspace`: `setStatus(STOPPING)` → `snapshot` (errors → skip hints, keep going) → for CHAT workspaces: if `snapshot.git.ahead === 0 && headSha && branch` → `chats.updateRestoreHints({ workBranch: branch, lastPushedSha: headSha })`; `messages.append(chatId, 'SYSTEM', note)` where note is `"Workspace reclaimed after <N> min idle; <M> uncommitted change(s) discarded"` or `"Workspace archived; <M> uncommitted changes discarded"` (M from `snapshot.summary` lines or `dirty ? 'some' : 0` — use core's helper if W1-F exposes one) → `runner.destroy` → `setStatus(DESTROYED)`; errors in destroy → `FAILED` with reason, never throws out of the loop (one bad workspace must not block the others)
- [x] destroy-chat-workspace: `findLiveByChat(chatId)`; none → return; else `teardownWorkspace(... reason 'archive')`
- [x] `src/app.ts`: `startWorker(container, factories): Promise<{ shutdown(): Promise<void> }>` — image check (`runner.imageExists?.(config.WORKSPACE_IMAGE)` if W1-B exposes it, else `assertWorkspaceImage` helper from W1-B; on missing → `logger.error` with `pnpm infra:image` and continue — the UI shows the banner from `/api/health`), `reconcileSchedulers`, create three BullMQ `Worker`s via W1-F factory (`chat-turns` concurrency `WORKER_TURN_CONCURRENCY`, `scheduled-jobs` 1, `workspace-gc` 1; `lockDuration 60_000`, `stalledInterval 30_000`, `maxStalledCount 1`; `connection` = the worker Redis), log `worker ready (instance=…, runner=…, concurrency=…)`; `shutdown()` closes workers (`close()` with a `SHUTDOWN_GRACE_MS = 30_000` race then `close(true)`), then `container.close()`
- [x] `src/main.ts` ≤ 15 lines: `boot` (W0) → `createContainer` → `startWorker` → SIGINT/SIGTERM → `shutdown` → exit 0; boot/start failure → log + exit 1
- [x] Unit tests 100 %: gc (idle selection honours cutoff and READY-only, hints only when `ahead === 0`, SYSTEM note text for idle/archive, destroy failure isolates, orphan destroy by label, gone-marking skips BUSY, unknown job name), app (image missing logs error and still starts; workers created with the right names/concurrency/options via an injected `createWorker`; shutdown order and forced close after grace with fake timers)

**Files to create/modify**
`apps/worker/src/processors/{gc,gc.test,teardown-workspace,teardown-workspace.test}.ts`, `apps/worker/src/{app,app.test,main}.ts`, `apps/worker/src/testing/fake-worker-factory.ts`.

**Agent prompt**

````
You are a senior backend engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · BullMQ 6 `Worker` (lock renewal, stalled detection) · `@agent-hangar/core` (runner `list`/`health`/`snapshot`/`destroy`, workspace idle/orphan helpers, queue/worker factories) · Vitest 4 fake timers.
Branch feat/w2b-worker (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-B 🐳 — Task 2B.4 of 6 (MIDDLE)

PRECONDITIONS
- Tasks 2B.1–2B.3 done.

REQUIRED READING (only these):
- docs/spec/04-flows.md (b) ARCHIVE half + the paragraph after the diagram (idle-TTL GC exercises the restore path), (a) edge case "Worker crash mid-turn"
- docs/spec/03-interfaces.md § "5" (`workspace-gc` row), § "1" (`list`, `snapshot`, `destroy` idempotent, `health` gone)
- docs/spec/02-data-model.md § "4" (hints persisted on teardown)
- packages/core/src/workspace/** (W1-F: idle-TTL selection helper, orphan reconcile decision — use them for the pure decisions), packages/core/src/queues/{queues,contracts}.ts (W1-F `createWorker`-style factory, `JOB_NAMES`, `destroyChatWorkspacePayload`), packages/core/src/runner/docker/index.ts (does it export an image-presence check? use it if so), packages/core/src/config/schema.ts (`WORKSPACE_IDLE_TTL_MIN`, `WORKER_TURN_CONCURRENCY`)
- apps/worker/src/{boot,main,logger}.ts (W0), apps/worker/src/{container,scheduler-reconcile}.ts, apps/worker/src/processors/{types,constants}.ts

TASK
Implement the workspace GC processor (idle reaping with restore hints, archive teardown, orphan reconcile) and the worker application wiring with the image-present check and graceful shutdown; keep `main.ts` a trivial entry.

DELIVERABLES

1. `apps/worker/src/processors/teardown-workspace.ts` — `teardownWorkspace(deps, ws: Workspace, opts: { reason: 'idle' | 'archive'; idleMinutes?: number }): Promise<'destroyed' | 'failed'>`:
   - `workspaces.setStatus(ws.id, 'STOPPING')`; `handle = { workspaceId: ws.id, runnerRef: ws.runnerRef ?? '' }`.
   - `snap = await runner.snapshot(handle)` in try/catch (failure → `snap = null`, `logger.warn`).
   - If `ws.kind === 'CHAT' && ws.chatId`: if `snap && snap.git.ahead === 0 && snap.git.headSha && snap.git.branch` → `chats.updateRestoreHints(ws.chatId, { workBranch: snap.git.branch, lastPushedSha: snap.git.headSha })`; `discarded = snap ? countDirtyEntries(snap) : 0` (count lines of the `git status --porcelain` part of `snap.summary`; put `countDirtyEntries` in this file, tested); `messages.append(ws.chatId, 'SYSTEM', formatTeardownNote(opts, discarded))` with texts: idle → `Workspace reclaimed after ${idleMinutes} min idle; ${discarded} uncommitted change(s) discarded. It will be recreated from history on the next message.`; archive → `Workspace archived; ${discarded} uncommitted change(s) discarded.`
   - `await runner.destroy(handle)`; `setStatus(ws.id, 'DESTROYED')`; return `'destroyed'`. On destroy error → `setStatus(ws.id, 'FAILED', { failureReason: redacted message })`, `logger.error`, return `'failed'`.
2. `apps/worker/src/processors/gc.ts` — `createGcProcessor(deps)` returning `async (job) => { switch (job.name) { case JOB_NAMES.reapIdle: return reapIdle(deps); case JOB_NAMES.destroyChatWorkspace: return destroyChatWorkspace(deps, destroyChatWorkspacePayloadSchema.parse(job.data)); default: logger.warn } }`.
   - `reapIdle(deps)`: `cutoff = new Date(clock.now().getTime() - config.WORKSPACE_IDLE_TTL_MIN * 60_000)`; `idle = await workspaces.listIdle(cutoff)` (if W1-F exposes `selectIdleWorkspaces(list, cutoff)` use it over `listLive()` instead — one source of truth); `for (const ws of idle) { await teardownWorkspace(deps, ws, { reason: 'idle', idleMinutes: config.WORKSPACE_IDLE_TTL_MIN }) }` — sequential, errors isolated per workspace (teardown never throws). Then `reconcileOrphans(deps)`: `handles = await runner.list({ 'ah.instance': config.AH_INSTANCE })`; `live = await workspaces.listLive()`; `liveIds = new Set(live.map(w => w.id))`; for handles with `!liveIds.has(h.workspaceId)` → `runner.destroy(h)` (+ `logger.warn({ workspaceId }, 'orphan workspace destroyed')`); for `live` rows with status `READY`/`STOPPING`/`CREATING` (not BUSY) and `runner.health(handle).status === 'gone'` → `setStatus(DESTROYED, { failureReason: 'container missing' })`. Return `{ reaped, orphansDestroyed, goneMarked }` and log it at info.
   - `destroyChatWorkspace(deps, { chatId })`: `ws = findLiveByChat(chatId)`; none → `logger.info` + return; else `teardownWorkspace(deps, ws, { reason: 'archive' })`.
3. `apps/worker/src/app.ts` — `startWorker(container: WorkerContainer, factories: { createWorker: (queueName, processor, opts) => WorkerLike; checkImage?: (image: string) => Promise<boolean> }): Promise<{ shutdown(): Promise<void> }>`:
   - Image check: `present = await (factories.checkImage ?? defaultCheckImage)(config.WORKSPACE_IMAGE)`; `defaultCheckImage` uses W1-B's exported helper if present (read `packages/core/src/runner/docker/index.ts`); if W1-B exposes none, `container.runner.list({ 'ah.instance': config.AH_INSTANCE })` proves Docker reachability and the image check is deferred to the first `create` (log that) — and file a `contractChangeRequest` asking W1-B for `imageExists(image)`. Missing image → `logger.error({ image }, 'workspace image missing — run: pnpm infra:image')`; do NOT exit (web shows the banner via `/api/health`).
   - `await reconcileSchedulers(container)`.
   - Workers: `createWorker(QUEUE_NAMES.chatTurns, createRunTurnProcessor(container), { concurrency: config.WORKER_TURN_CONCURRENCY, connection: container.redis.worker, lockDuration: 60_000, stalledInterval: 30_000, maxStalledCount: 1 })`, `scheduled-jobs` concurrency 1, `workspace-gc` concurrency 1 (same lock options); attach `worker.on('failed', (job, err) => logger.error(...))` and `'error'` handlers. `logger.info({ instance, runner: runner.kind, concurrency }, 'worker ready')`.
   - `shutdown()`: `await Promise.race([Promise.all(workers.map(w => w.close())), sleep(SHUTDOWN_GRACE_MS)])`; if the race timed out → `await Promise.all(workers.map(w => w.close(true)))`; then `await container.close()`; idempotent (second call no-op). `SHUTDOWN_GRACE_MS = 30_000` in constants.
   - `WorkerLike = Pick<Worker, 'close' | 'on'>`; the real `createWorker` default wraps W1-F's factory or `new Worker(name, processor, opts)`.
4. `apps/worker/src/main.ts` (≤ 15 lines; excluded from coverage with a comment in vitest.config explaining it is pure wiring): `const booted = await boot(realDeps); const container = await createContainer({ config: booted.config, … reuse booted.prisma/redis if boot created them (read W0 boot.ts; avoid double connections — if boot owns prisma/redis, pass them into createContainer via factories) }); const app = await startWorker(container, { createWorker }); for (const sig of ['SIGINT','SIGTERM']) process.on(sig, () => { void app.shutdown().then(() => process.exit(0)); });` and a top-level catch → `logger.error(e.message)`, `process.exit(1)`.
5. `apps/worker/src/testing/fake-worker-factory.ts` — `createFakeWorkerFactory()` returning `{ createWorker, workers: FakeWorker[] }` where `FakeWorker` records `name`, `processor`, `opts`, `close(force?)` (resolvable manually via `resolveClose()` to test the grace race), `on`.
6. Tests:
   - `teardown-workspace.test.ts`: hints written when `ahead === 0` with sha/branch; not written when `ahead > 0` or snapshot null; note texts (idle with minutes and count; archive); `countDirtyEntries` on a summary with 3 porcelain lines + diffstat; snapshot throws → still destroyed, no hints, note says `0`; destroy throws → FAILED with redacted reason, returns `'failed'`; JOB workspace → no message/hints.
   - `gc.test.ts`: reap-idle with three workspaces (READY old → reaped; READY fresh → kept; BUSY old → kept) and `config.WORKSPACE_IDLE_TTL_MIN = 30` with `FakeClock`; orphan: `runner` has a workspace created with label `ah.instance` but no DB row → destroyed; another instance's label → untouched; DB READY row whose container is gone (destroy it directly on the fake runner) → DESTROYED `container missing`; BUSY row gone → untouched; destroy-chat-workspace with/without live workspace; unknown job name → warn; return counters.
   - `app.test.ts`: image present/missing (`checkImage` injected) → error log only when missing, workers still created; three workers with names/concurrency/options; `'failed'` handler logs; `shutdown` closes all then container (order via call log); grace timeout → `close(true)` called (fake timers); second `shutdown` no-op; `reconcileSchedulers` invoked once.
   - `main.ts` is not unit-tested (excluded); it is exercised by the 🐳 suite and `pnpm dev`.

Constraints:
- Follow /bymax-workflow:standards (JSDoc + headers, English, no enum, no suppression, it() comments; functions ≤ 60 lines).
- Owned paths only; no new deps; GC scopes everything by `ah.instance` label — never destroy a container without that label matching.
- Fake timers for grace periods; no real sleeps.

Verification:
- `pnpm --filter worker test -- --coverage` — green, 100 % on `src/**` except `src/main.ts`
- `pnpm typecheck && pnpm lint` — exit 0
- `WORKSPACE_RUNNER=fake pnpm --filter worker dev` against the w2b stack — logs schedulers reconciled + `worker ready`; Ctrl+C shuts down within a second with no active jobs

Completion Protocol: update status/AC/progress in docs/tasks/wave-2b-worker.md; append `- 2B.4 ✅ <date> — <summary>`; commit `feat(worker): add workspace gc, orphan reconcile and application wiring`.
````

---

## Task 2B.5 — 🐳 Integration suite `@docker @db @redis`

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** L · **Depends on:** 2B.4

**Description.** Prove the worker against real infrastructure: Postgres (W1-E repositories), Redis (BullMQ + Streams), Docker (W1-B runner, W1-D runtime image) with `AGENT_MODEL_PROVIDER=fake` inside the container. Four scenarios from spec 06 §3: a full turn (container created, runtime runs scripted tool calls, rows and stream entries appear, Turn SUCCEEDED), GC reaps idle and orphan containers, a restore turn clones `workBranch` (prepare events), and a scheduled run creates and destroys its container. Runs only with `DOCKER_AVAILABLE=1`; fails loudly in CI when Docker is missing.

**Acceptance criteria**
- [ ] `apps/worker/src/integration/worker.integration.test.ts` (`describe('@docker @db @redis worker', …)`) guarded by a `describeDocker` helper: `DOCKER_AVAILABLE=1` + `DATABASE_URL` + `REDIS_URL` → run; missing locally → `describe.skip` with a console warning naming the env vars; missing with `CI=1` → throw
- [ ] Setup: real `createContainer` with `WORKSPACE_RUNNER=docker`, `AH_INSTANCE=<w2b-test>`, config from env; `truncateAll`; `FLUSHDB` on the test Redis; secrets stored through the real `SecretsService` with a temp master key (values = canaries); `afterAll`: destroy every container with label `ah.instance=<instance>`, close the container
- [ ] Scenario 1 — full turn: seed Chat (repo `TEST_REPO_URL`, default `https://github.com/octocat/Hello-World.git`) + USER message + Turn; process via a real BullMQ `Worker` from `startWorker` (or the processor directly — prefer the real worker for the queue path); wait until Turn terminal (poll ≤ 120 s); asserts: Turn `SUCCEEDED`, Workspace `READY` with `runnerRef`, `runner.list({ 'ah.instance' })` has exactly one handle with labels `ah.chat`, ToolCallLog rows for the fake provider's scripted tools, Message rows `TOOL_SUMMARY`/`ASSISTANT`, `XRANGE events:turn:<id> - +` contains `turn.started`, `prepare.done`, `tool.call`, `turn.completed` in order, stream TTL set (`TTL` > 0), no canary anywhere (`assertNoCanary` on all rows and stream entries; the container env contains the canaries but events must not)
- [ ] Scenario 2 — GC: set the workspace's `lastActiveAt` 2 h back; run `reap-idle` → Workspace `DESTROYED`, container gone (`runner.health` gone), SYSTEM note appended, `Chat.workBranch`/`lastPushedSha` hints updated when the snapshot reported `ahead 0` (assert presence of hint fields, not values); orphan: create a container with `ah.instance=<instance>` via `runner.create` for a workspaceId with no DB row → `reap-idle` destroys it
- [ ] Scenario 3 — restore turn: a new USER message + Turn on the same chat → Turn SUCCEEDED, a NEW workspace id, stream contains `prepare.progress` (Cloning…) and `prepare.done`; the request sent had `prepare.clone true` (assert through the persisted SYSTEM note from GC + the events; the stdin itself is not observable here)
- [ ] Scenario 4 — scheduled run: ScheduledJob (enabled, cron `* * * * *`) → `run-scheduled-job` with `trigger MANUAL` → JobRun `SUCCEEDED` with `output`, Workspace `kind JOB` `DESTROYED`, `runner.list` shows no handle with `ah.jobRun`; overlap: two concurrent deliveries → one SUCCEEDED, one FAILED `previous run still running`
- [ ] `apps/worker/package.json` `test:integration` runs the suite with `DOCKER_AVAILABLE=1`; CI `integration` job (W0) picks it up through `pnpm test:integration`

**Files to create/modify**
`apps/worker/src/integration/{worker.integration.test,describe-docker,describe-docker.test,harness}.ts`, `apps/worker/vitest.config.ts` (integration project), `apps/worker/package.json` (scripts only).

**Agent prompt**

````
You are a senior backend engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Docker Desktop · Postgres 18 + Redis 8 (compose instance `w2b-test`) · workspace image `agent-hangar/workspace:dev` with the W1-D runtime bundle · BullMQ 6 · Vitest 4.
Branch feat/w2b-worker (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-B 🐳 — Task 2B.5 of 6 (MIDDLE) — the only Docker-integration lane running now

PRECONDITIONS
- Tasks 2B.1–2B.4 done. Stack: `eval "$(AH_INSTANCE=w2b-test AH_PORT_BASE=3310 bash infra/scripts/env.sh --print)"`; `docker compose -f infra/docker-compose.yml up -d --wait`; `pnpm --filter @agent-hangar/core db:migrate`; `pnpm infra:image` (image must contain `/opt/agent-runtime/cli.js`; verify `docker run --rm agent-hangar/workspace:dev node /opt/agent-runtime/cli.js --version`).
- Export `DOCKER_AVAILABLE=1`, `DATABASE_URL`, `REDIS_URL`, `AH_INSTANCE=w2b-test`, `WORKSPACE_RUNNER=docker`, `AGENT_MODEL_PROVIDER=fake`, `MASTER_KEY_PATH=<temp file created by the test>`.

REQUIRED READING (only these):
- docs/spec/06-testing.md § "3. Integration tests" (worker bullet) and the guard rule (never silently green)
- packages/agent-runtime/src/** — ONLY to learn: how `AGENT_MODEL_PROVIDER=fake` selects the fake provider inside the container and what its default script does (which tools it calls, what final message it returns). If W1-D allows scripting via an env var (e.g. a JSON script), use it to make the scenarios deterministic; otherwise adapt assertions to the default script. Do NOT modify the runtime.
- packages/core/src/persistence/testing/db.ts (`truncateAll`, `connectTestDb`), packages/core/src/secrets/index.ts (service + master key file creation for the temp key), packages/core/src/runner/docker/index.ts (runner constructor, socket resolution), apps/worker/src/{container,app,scheduler-reconcile}.ts, apps/worker/src/processors/*.ts
- .github/workflows/ci.yml (integration job env: `DOCKER_AVAILABLE=1`, services) — read only

TASK
Write the 🐳 integration suite that runs the worker against real Docker, Postgres and Redis with the fake model provider inside the container, covering the four scenarios, with a guard that fails loudly in CI when Docker is unavailable.

DELIVERABLES

1. `apps/worker/src/integration/describe-docker.ts` — `shouldRunDockerSuite(env): { run: boolean; reason: string }` (needs `DOCKER_AVAILABLE === '1'`, `DATABASE_URL`, `REDIS_URL`; `CI` truthy and not runnable → throw `Error('@docker suite cannot run: <missing vars> — CI must provide Docker, Postgres and Redis')`) and `describeDocker(title, fn)` mirroring core's `describeDb` (skip with `console.warn(reason)` locally). Unit-tested (`describe-docker.test.ts`, counted in coverage).
2. `apps/worker/src/integration/harness.ts` — `createIntegrationHarness()`:
   - `config = loadConfig(process.env)` (instance `w2b-test`), temp master key via W1-A's key-file creator at `MASTER_KEY_PATH`, `container = await createContainer({ config })` (real everything), `await truncateAll(container.prisma)`, `await container.redis.queue.flushdb()`, store secrets: `await container.secrets.set('GITHUB_PAT', GITHUB_CANARY)`, `set('OPENAI_API_KEY', OPENAI_CANARY)` (the fake provider ignores the key; the PAT is unused because the test repo is public — if W1-D's prepare requires a token for https clone, it still works with a dummy since GitHub allows anonymous clone of public repos).
   - `app = await startWorker(container, { createWorker: realCreateWorker })`.
   - helpers: `waitFor(predicate, { timeoutMs: 120_000, intervalMs: 500 })`, `readStream(turnId)` → parsed `{ id, type, data }[]` via `XRANGE`, `listInstanceHandles()` → `container.runner.list({ 'ah.instance': config.AH_INSTANCE })`, `destroyAllInstanceContainers()`, `close()` (→ `app.shutdown()`, destroy leftovers, remove temp key).
   - `TEST_REPO_URL = process.env.TEST_REPO_URL ?? 'https://github.com/octocat/Hello-World.git'` (documented: network access required; CI runners have it).
3. `apps/worker/src/integration/worker.integration.test.ts` — `describeDocker('worker end-to-end', …)` with `beforeAll(harness)`, `afterAll(close)`, `testTimeout 180_000`; the four scenarios from the acceptance criteria, in order (they build on each other; use `test.sequential`):
   - S1 full turn: seed via repositories (`chats.create`, `messages.append(USER, 'List the files and create NOTES.md')` — align with the fake provider's script key if it is keyed by last user message; W1-D's default script may key on any text — read it), `turns.create`, `queues.chatTurns.add('run-turn', { turnId }, { jobId: turnId })`; `waitFor(turn terminal)`; assertions as in the criteria (SUCCEEDED, one handle with `ah.chat`, ToolCallLog rows ≥ 1, TOOL_SUMMARY + ASSISTANT messages, stream order, `TTL` > 0, `assertNoCanary` on every row's string columns and on every stream `data`). If the turn fails, print the stream entries and the Turn error before failing so the orchestrator can diagnose.
   - S2 GC: `prisma.workspace.update({ lastActiveAt: now − 2h })` (direct write allowed in tests), `queues.workspaceGc.add('reap-idle', {})` (or call `createGcProcessor(container)({ name: 'reap-idle', data: {} })` directly); assert DESTROYED + `health` gone + SYSTEM note; orphan: `container.runner.create({ workspaceId: 'orphan-' + random, kind: 'CHAT', image, env: {}, limits, labels: { 'ah.instance': instance, 'ah.workspace': id, 'ah.kind': 'CHAT' } })` → reap-idle → `listInstanceHandles()` does not contain it.
   - S3 restore turn: `messages.append(USER, …)`, new turn → SUCCEEDED; new workspace id ≠ old; stream has `prepare.progress` and `prepare.done`; chat has two `SYSTEM`/TOOL_SUMMARY history entries preserved (count messages ≥ previous + 3).
   - S4 scheduled run: `scheduledJobs.create({ name, cron: '* * * * *', timezone: 'UTC', prompt: 'print date', repoUrl: TEST_REPO_URL, branch: 'master', enabled: true })` (Hello-World's default branch is `master` — verify), `queues.scheduledJobs.add('run-scheduled-job', { jobId, trigger: 'MANUAL' })` → wait JobRun terminal → SUCCEEDED with non-empty `output`, Workspace DESTROYED, no `ah.jobRun` handle; overlap: the `scheduled-jobs` worker has concurrency 1, so two queued deliveries run sequentially and both would succeed — assert the policy deterministically instead: set an existing JobRun row of the job to `RUNNING` directly via Prisma, call `createRunScheduledJobProcessor(container)` with a `MANUAL` payload, and assert a new JobRun `FAILED` with `previous run still running`, no new workspace row and no new container; then reset the row.
4. `apps/worker/vitest.config.ts` — `projects`: `unit` (default, excludes `src/integration/**/*.integration.test.ts`) and `integration` (only those files, `testTimeout 180_000`, `hookTimeout 180_000`, no coverage thresholds — integration files are excluded from coverage; `describe-docker.ts`/`harness.ts` are covered by unit tests where pure, harness wiring excluded by name pattern `src/integration/harness.ts` with a comment). `apps/worker/package.json`: `"test:integration": "DOCKER_AVAILABLE=1 vitest run --project integration"`.

Constraints:
- Follow /bymax-workflow:standards (JSDoc + headers, English, no enum, no suppression, it() comments).
- Owned paths only; no new deps; never modify `packages/agent-runtime/**` or `packages/core/**` — if the runtime's fake mode cannot produce what a scenario needs, assert what it does produce and record the gap in the PR (`contractChangeRequests` for W1-D if a scripting hook is needed).
- Always clean up containers by `ah.instance` label in `afterAll`, even on failure; never touch other instances.

Verification:
- `DOCKER_AVAILABLE=1 … pnpm --filter worker test:integration` — four scenarios green locally (run twice; second run must also pass — idempotent cleanup)
- `CI=1 pnpm --filter worker test:integration` with `DOCKER_AVAILABLE` unset — fails with the loud message (then unset CI)
- `docker ps --filter label=ah.instance=w2b-test -q | wc -l` → 0 after the suite
- `pnpm --filter worker test -- --coverage` — unit project still 100 %; `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-2b-worker.md; append `- 2B.5 ✅ <date> — <summary>`; commit `test(worker): add docker integration suite for turns, gc, restore and scheduled runs`.
````

---

## Task 2B.6 — Close-out: gates, code review, dashboard, PR

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** S · **Depends on:** 2B.1–2B.5

**Description.** Run every gate (unit 100 %, 🐳 integration green locally), bring the code review to zero findings, update the plan dashboard and tasks index, open the PR with the structured summary, and record the end-to-end evidence (`AGENT_MODEL_PROVIDER=fake` round-trip) the orchestrator needs for W3-A.

**Acceptance criteria**
- [ ] `pnpm lint && pnpm format:check && pnpm typecheck` — exit 0
- [ ] `pnpm --filter worker test -- --coverage` — 100/100/100/100 on `src/**` (minus `main.ts`, integration files, harness); `pnpm --filter worker test:integration` green with Docker
- [ ] `/bymax-quality:code-review` → zero open findings (or justified)
- [ ] `docs/plan.md` §12 row W2-B → 🟨 with branch/PR; `docs/tasks/README.md` updated
- [ ] PR opened; structured result returned incl. `contractChangeRequests`

**Files to create/modify**
`docs/plan.md` (§12 row only), `docs/tasks/README.md` (W2-B row only), this file.

**Agent prompt**

````
You are a senior engineer closing out lane W2-B of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 · Node 24 · BullMQ 6 · Docker Desktop · Postgres 18 · Redis 8 · Vitest 4 · GitHub CLI.
Branch feat/w2b-worker (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-B 🐳 — Task 2B.6 of 6 (LAST)

PRECONDITIONS
- Tasks 2B.1–2B.5 done and committed. The `w2b-test` stack and the workspace image are available locally.

REQUIRED READING (only these):
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard", § "7" W2-B "DONE" line
- docs/tasks/README.md
- CLAUDE.md "Gates before any PR"

TASK
Run all gates including the 🐳 suite, run the code review to zero findings, update the dashboards, and open the PR with a structured summary and evidence. Do not wait for CI; do not merge.

DELIVERABLES

1. Gates: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm --filter worker test -- --coverage` (100 % all four metrics on the unit project's include set), `DOCKER_AVAILABLE=1 … pnpm --filter worker test:integration` (four scenarios green, twice in a row), then `docker ps --filter label=ah.instance=w2b-test -q` empty.
2. `/bymax-quality:code-review` on `main..HEAD`; fix every finding (CRITICAL/HIGH/MEDIUM/LOW) — no suppressions; re-run gates after fixes. Unfixed findings need a one-line justification in the PR body.
3. Evidence for the lane's DONE criterion ("with `AGENT_MODEL_PROVIDER=fake`, a chat turn round-trips UI → API → worker → container → SSE → UI"): the UI/API halves belong to W2-A and may not be merged — record what you verified: the S1 stream entries (`XRANGE` output, redacted) and the Turn row, plus the command lines used. Put it in the PR body under "Evidence".
4. Update `docs/plan.md` §12 row `W2-B 🐳` → `🟨` with `feat/w2b-worker` / PR number (number in a follow-up commit `docs: record W2-B PR in dashboard`); `docs/tasks/README.md` row → 🟨; this file's header Status → 🟨 PR open, Progress → 6/6.
5. Verify history: Conventional Commits, English, no attribution trailers (`git log --format=%B main..HEAD | grep -i -E 'co-authored-by|generated with'` empty).
6. `gh pr create --base main --head feat/w2b-worker --title "feat(worker): turn and scheduled-job processors, workspace gc, events and cancel (W2-B)" --body-file <generated>`. Body: Summary · Processors (run-turn, run-scheduled-job, gc, reconcile) with the persistence matrix (event → rows) · Redis Streams entry format (`type`, `data`) and command channel payload (`cancel`) for W2-A · `WORKSPACE_RUNNER` worker env · Failure semantics (what resolves vs what rethrows for BullMQ retry) · How to run the 🐳 suite · Evidence · Gate results · Coverage · Contract change requests (e.g. `imageExists` on the Docker runner, runtime fake-provider scripting hook, `WORKSPACE_RUNNER` in core config) — empty if none.
7. Return: `{ pr, branch, headSha, gates: { lint, format, typecheck, unit, integration }, coverage: { lines, branches, functions, statements }, contractChangeRequests: [...] }`.

Constraints:
- English; Conventional Commits; no AI attribution; owned paths only plus the two dashboard rows.
- Do not wait for CI; do not merge; leave the `w2b-test` stack down (`docker compose … down -v`) when finished to free the 🐳 slot.

Verification:
- `gh pr view --json number,headRefOid,url` — PR exists, `headRefOid` equals `git rev-parse HEAD`

Completion Protocol: append `- 2B.6 ✅ <date> — PR #<n> opened`; commit `docs: close out W2-B lane` before opening the PR (dashboard follow-up commit after).
````

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)
- 2B.1 ✅ 2026-08-19 — worker container, worker env, Redis Streams publisher, cancel listener and the in-memory test doubles
- 2B.2 ✅ 2026-08-19 — run-turn processor: workspace ensure and recovery, streaming redact/publish/persist, every failure path and cancellation
- 2B.3 ✅ 2026-08-19 — scheduled-job processor with the overlap policy and destroy-in-finally, plus the boot-time scheduler reconciliation
- 2B.4 ✅ 2026-08-19 — workspace collector with idle reaping and orphan reconciliation, plus the application wiring and graceful shutdown
