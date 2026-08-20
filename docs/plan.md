# Agent Hangar — Implementation Plan (orchestrator + parallel subagents)

| | |
|---|---|
| **Status** | ✅ Approved — 2026-08-19 · task files: [docs/tasks/](tasks/README.md) |
| **Source spec** | [docs/spec/](spec/README.md) (01–10) — this plan executes it; where they differ, this plan wins on *sequencing*, the spec wins on *behaviour* |
| **Execution model** | One orchestrator session; each workstream = one isolated subagent in its own git worktree = one PR. Workstreams in the same wave run **in parallel** |
| **Quality bar** | TS strict, zero suppressions, JSDoc on every export, **100 % coverage on all four metrics (lines / branches / functions / statements) per package**, gates green before every PR. Stryker 10 mutation testing is the **final wave** and is explicitly allowed to slip |
| **Last updated** | 2026-08-19 · §12 reflects Wave 1 in flight: seven lanes merged, three running |

---

## 1. Requirements restatement

Build the system in [docs/spec](spec/README.md) — chats backed by isolated Docker workspaces, scheduled jobs in fresh workspaces, encrypted settings, SSE streaming, Conductor-ready local setup — **as fast as wall-clock allows without lowering quality**, by:

1. Splitting the work into **workstreams that own disjoint paths**, so several subagents can implement concurrently in separate worktrees and their PRs merge without conflicts.
2. Freezing **all cross-workstream contracts first** (types, Prisma schema, Zod schemas, test doubles, dependency manifest, tooling) so parallel agents build against interfaces, never against each other's in-progress code.
3. Enforcing the same gates in every PR: lint, typecheck, unit tests with **100 % coverage on every metric**, integration tests where the workstream touches real infrastructure, JSDoc/test-comment policy, self code review to zero findings.
4. Running **Stryker 10** last, per package, as separate non-blocking PRs, with the CI mutation gate switched on only when the score holds.

Non-negotiables carried from the spec: scope exactly as the spec lists (nothing more), English-only artefacts, no secrets anywhere but encrypted Postgres rows, dockerode confined to `packages/core/src/runner/docker/**`.

## 2. Reuse scan (simplicity ladder §0)

- **Codebase:** empty repository (no commits) → every file is new by necessity; no per-file justification is repeated below.
- **Org libs / siblings:** `@bymax-one/*` are NestJS-oriented; this project is Next.js + plain Node worker, so nothing is imported. Proven *patterns* are reused from the knowledge vault: SSE (no compression, `Last-Event-ID` replay, same-origin route), BullMQ Job Schedulers (`upsertJobScheduler`, `maxRetriesPerRequest: null` only on workers), Prisma 7 driver adapter (`$connect()` is lazy → `SELECT 1` at boot), macOS `127.0.0.1` over `localhost`.
- **Platform / stdlib:** `node:crypto` (AES-256-GCM, `randomUUID`, `timingSafeEqual`), `fetch`, `AbortController`, `URL`, `Intl`, `structuredClone`.
- **Installed deps that cover needs (no custom code):** `openai` (Responses streaming), `bullmq`/`ioredis`, `dockerode`, `@prisma/client` + `@prisma/adapter-pg`, `zod`, `pino`, `cron-parser` (cron validation + next run), `react-markdown` + `rehype-highlight` (assistant Markdown), `shadcn` components, `lucide-react`, `msw` (test-mode GitHub API), `@testing-library/react`, `@vitest/coverage-v8`, `@playwright/test`, `@stryker-mutator/core` + `vitest-runner`.
- **Reusable units planned once:** `packages/core/src/testing/**` (fakes used by every workstream), `apps/web/src/shared/ui/**` (shadcn + project primitives, zero domain imports), `packages/core/src/agent-protocol/**` (shared by worker and runtime).

## 3. Parallelism rules (learned the hard way — do not skip)

1. **One agent per directory, one directory per agent.** Every workstream below has an **Owned paths** list; an agent may create/edit only there (plus its own test files). Reading anything is fine. Touching another stream's path = the PR is rejected by the orchestrator.
2. **No dependency additions inside waves.** Wave 0 installs the complete manifest (§5). A stream that truly needs a new package stops and reports; the orchestrator adds it in a tiny `chore(deps)` PR on `main` first. This is what keeps `pnpm-lock.yaml` conflict-free.
3. **Docker-running tests are a shared resource.** Only streams marked 🐳 run real-Docker integration tests, and the orchestrator runs **at most one 🐳 stream at a time** (OOM/port pressure on a laptop). Everyone else tests against `FakeWorkspaceRunner`.
4. **Concurrency cap: 5 subagents** at once (more buys little and risks OOM from five `next build`/`vitest` processes).
5. **Shared files are pre-split.** `packages/core/src/index.ts` re-exports one barrel per folder; a lane adds exports only to the barrel of the folder it owns. Each package's `vitest.config.ts` `coverage.include` is the one file several lanes append a line to — keep it one line per lane, appended at the end, to make rebases trivial. Root `package.json` scripts are owned by W1-I (merged first).
6. **Contracts are frozen after Wave 0.** A stream that needs a contract change opens a 1-file PR against `packages/core/src/**/types.ts` (+ Zod) and waits for the orchestrator to merge and notify dependants. Changes must be additive.
6. **Each subagent: `isolation: "worktree"`, branch `feat/<stream-id>-<slug>`, steps 0–4 only** (branch → implement → gates → self-review → commit/push/open PR → return PR number + summary). The orchestrator owns merge, CI watching, review-thread resolution, and chaining (see §8).
7. **Verify, don't trust:** orchestrator confirms every stream via `git`/`gh` (commits ahead, PR number, CI state) — never via the agent's narration.

## 4. Wave plan (critical path and parallel lanes)

```mermaid
flowchart TB
  subgraph wave0["Wave 0 - sequential, 1 agent"]
    W0["W0 Foundation and frozen contracts - 3h"]
  end

  subgraph wave1["Wave 1 - 9 lanes in parallel, cap 5"]
    W1A["W1-A core secrets, redaction, logging - 3h"]
    W1B["W1-B core DockerWorkspaceRunner + image (Docker) - 4h"]
    W1C["W1-C core OpenAIModelProvider - 3h"]
    W1D["W1-D agent-runtime - 4h"]
    W1E["W1-E core persistence repositories - 3h"]
    W1F["W1-F core scheduling, workspace, restore - 3h"]
    W1G["W1-G web UI shell + chats, mocked API - 4h"]
    W1H["W1-H web UI scheduled + settings - 3h"]
    W1I["W1-I infra scripts, doctor, Conductor - 2h"]
  end

  subgraph wave2["Wave 2 - 3 lanes in parallel"]
    W2A["W2-A web API routes + SSE - 4h"]
    W2B["W2-B worker processors + queues (Docker) - 4h"]
    W2C["W2-C E2E harness + specs authoring - 3h"]
  end

  subgraph wave3["Wave 3 - integration"]
    W3A["W3-A end-to-end wiring and stabilisation (Docker) - 4h"]
    W3B["W3-B README + docs refresh - 2h"]
  end

  subgraph wave4["Wave 4 - last, non-blocking"]
    W4A["W4-A Stryker core - 2h"]
    W4B["W4-B Stryker agent-runtime - 2h"]
  end

  W0 --> W1A & W1B & W1C & W1D & W1E & W1F & W1G & W1H & W1I
  W1A & W1E & W1F --> W2A
  W1A & W1B & W1C & W1D & W1E & W1F --> W2B
  W1G & W1H --> W2C
  W2A & W2B & W2C --> W3A
  W2A & W2B --> W3B
  W3A --> W4A & W4B
```

**Dependency graph (what each lane needs merged before it starts)**

| Lane | Needs merged | Why |
|---|---|---|
| W1-A … W1-H | W0 | contracts, tooling, deps |
| W1-I | W0 (+ W1-A, W1-C, W1-E for the doctor/rotate-key tasks) | runs in the second Wave 1 batch; merges first within that batch (root scripts block) |
| W2-A (web API) | W1-A, W1-E, W1-F | secrets status, repositories, scheduling validation |
| W2-B (worker) | W1-A, W1-B, W1-C, W1-D, W1-E, W1-F | everything the processors orchestrate |
| W2-C (E2E authoring) | W1-G, W1-H | UI selectors; specs run for real only in W3-A |
| W3-A | all W2 | wiring, real OpenAI smoke, E2E green |
| W3-B | W2 (can start on W1 and rebase) | docs |
| W4-A/B | W3-A | mutation on stable code |

Estimated wall-clock with cap 5: **≈ 3 h (W0) + ≈ 7 h (W1 in two batches) + ≈ 4 h (W2) + ≈ 4 h (W3) + ≈ 2 h (W4) ≈ 20 h** of agent time, versus ≈ 45 h sequential. Human time is review/merge decisions only.

## 5. Wave 0 — Foundation & frozen contracts (single agent, critical path)

**Goal.** After this PR merges, eight agents can start without asking questions.

**Scope.**

1. **Monorepo & tooling** — `pnpm-workspace.yaml` (`apps/*`, `packages/*`), root `package.json` (`packageManager: pnpm@11`, `engines.node: 24`), `tsconfig.base.json` (strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`), per-package `tsconfig.json` with project references, path alias `@/` per app, ESLint flat config (typescript-eslint, import-x order, security, `no-restricted-imports`: dockerode outside `packages/core/src/runner/docker/**`, `crypto` → `node:crypto`, no `enum` via `no-restricted-syntax`), Prettier + tailwind plugin, Husky + commitlint + lint-staged, `.editorconfig`, `.nvmrc`, `.gitignore` (`.env*`, `master.key`, coverage, reports), `CLAUDE.md` (project rules: ownership map, gates, no-secrets canaries).
   - **TypeScript pinned to `~6.0.3`** (decided — spec 01 R1): latest stable JS-line compiler; TS 7 (native, `latest` tag) is not used because its programmatic API is unstable until 7.1. `tsconfig` avoids options removed in TS 7 (`baseUrl`, legacy `moduleResolution`) so a later upgrade is a version bump. Record in README "Decisions".
2. **Complete dependency manifest** installed and locked (no stream adds deps later):
   - root dev: `typescript`, `eslint` + `typescript-eslint` + `eslint-plugin-import-x` + `eslint-plugin-security` + `eslint-plugin-react-hooks` + `@next/eslint-plugin-next`, `prettier` + `prettier-plugin-tailwindcss`, `husky`, `lint-staged`, `@commitlint/cli` + `config-conventional`, `vitest` + `@vitest/coverage-v8` + `@vitest/ui`, `tsx`, `esbuild`, `concurrently`, `@stryker-mutator/core` + `@stryker-mutator/vitest-runner` (10.x, configured in W4 only), `gitleaks` via CI action (not npm).
   - `packages/core`: `zod`, `pino`, `@prisma/client`, `@prisma/adapter-pg`, `pg`, `prisma` (dev), `bullmq`, `ioredis`, `dockerode` + `@types/dockerode`, `openai`, `cron-parser`, `tar-stream` (copy files into containers if needed by runner).
   - `packages/agent-runtime`: `zod`, `openai` (via core), `execa` **not** used — `node:child_process` suffices (stdlib rung).
   - `apps/web`: `next`, `react`, `react-dom`, `tailwindcss` + `@tailwindcss/postcss`, `shadcn` (dev) + generated components deps (`@base-ui-components/react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `sonner`, `cmdk`), `react-markdown`, `rehype-highlight`, `remark-gfm`, `@testing-library/react` + `jest-dom` + `user-event`, `jsdom`, `msw`, `@playwright/test`.
   - `apps/worker`: `pino-pretty` (dev).
3. **Frozen contracts in `packages/core`** (copied from [spec 03](spec/03-interfaces.md), with Zod schemas where data crosses a boundary): `src/runner/types.ts`, `src/model/types.ts`, `src/agent-protocol/{types,schemas,ndjson}.ts` (codec included — tiny and shared), `src/secrets/types.ts` (`SecretsService`, `Redactor`), `src/scheduling/types.ts`, `src/workspace/types.ts` (lifecycle states, `RestoreContext`), `src/persistence/ports.ts` (repository interfaces: `ChatRepository`, `MessageRepository`, `TurnRepository`, `WorkspaceRepository`, `ScheduledJobRepository`, `JobRunRepository`, `ToolCallLogRepository`, `SecretRepository`), `src/api/contracts.ts` (Zod request/response schemas for every route in spec 03 §4 + SSE frame type), `src/queues/contracts.ts` (queue names, job names, payload schemas), `src/config/{schema,instance}.ts` (env schema + instance/port derivation — implemented here because every app boots through it), `src/errors.ts` (typed error classes: `WorkspaceImageMissing`, `SecretIntegrityError`, `ProtocolError`, …).
4. **Test doubles** in `src/testing/**`: `FakeWorkspaceRunner` (in-memory FS per handle, scripted exec), `FakeAgentModelProvider` (script keyed by last user message, supports tool-call sequences and delays), `FakeClock`, `InMemory*Repository` for every port, `canaries.ts` (`GITHUB_CANARY = 'ghp_TESTCANARY…'`, `OPENAI_CANARY = 'sk-TESTCANARY…'`). Fully unit-tested (100 %).
5. **Prisma 7** — `prisma/schema.prisma` exactly as [spec 02](spec/02-data-model.md), `prisma.config.ts`, first migration incl. the partial unique index (one live workspace per chat), `src/persistence/client.ts` (adapter-pg, `SELECT 1` on boot helper).
6. **Infra skeleton** — `infra/docker-compose.yml` (postgres 18 / redis 8, parameterised), `infra/workspace/Dockerfile` (base only; runtime bundle COPY added by W1-D), `infra/scripts/env.sh` (instance/port derivation — mirrors `config/instance.ts`), `.env.example`, root scripts: `setup`, `dev`, `build`, `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, `infra:*`, `db:*`, `doctor` (stub that W1-I completes).
7. **Apps skeleton** — `apps/web`: Next 16 App Router, Tailwind v4 with the full token set from [spec 10 §2](spec/10-ui-design.md) in `app/globals.css` (`@theme`, light/dark), shadcn init (Base UI, new-york) + the component set from spec 10 §5 generated into `src/shared/ui/`, `next/font` Inter + JetBrains Mono, `(app)/layout.tsx` with an **empty** sidebar slot and routes `/chats/new`, `/chats/[id]`, `/scheduled`, `/scheduled/[id]`, `/settings` rendering placeholders, `src/shared/api/client.ts` (typed fetch over `api/contracts`), `vitest.config.ts` (jsdom, 100 % thresholds, `coverage.include: ['src/**']`), `playwright.config.ts`. `apps/worker`: `src/main.ts` boots config, Postgres `SELECT 1`, Redis ping, logs, graceful shutdown; `vitest.config.ts` 100 %.
8. **CI** — `.github/workflows/ci.yml` with jobs `lint`, `typecheck`, `unit` (coverage thresholds enforced by Vitest config), `integration` (services postgres/redis; runs `@docker`-tagged tests), `e2e`, `build`, `secret-scan` (gitleaks). `mutation` job added in W4. `pnpm/setup@v2` for pnpm 11 + Node 24.
9. **Plan hygiene** — `docs/plan.md` §9 status table initialised; `CLAUDE.md` includes the ownership map (§6) verbatim so every subagent sees it.

**Owned paths.** Everything (only agent in this wave).

**Gates / DONE.** `pnpm setup && pnpm dev` serves placeholder pages; `pnpm lint typecheck test` green with 100 % coverage on `packages/core/src/testing/**`, `config/**`, `agent-protocol/**`, `errors.ts`; CI green on the PR; TS 6 pin recorded in README "Decisions"; `CLAUDE.md` present. Complexity: **HIGH** (breadth), ~3 h.

## 6. Wave 1 — parallel workstreams (after W0 merges)

Each lane below is one subagent prompt. Common to all: read `CLAUDE.md`, the spec documents named, and the contract files; TDD (`/bymax-quality:tdd`) — tests first; JSDoc on exports; test-file headers + `it()` comments; 100 % coverage on **owned** `src/**` (the package's `vitest.config` `coverage.include` is scoped to owned paths until W3 widens it); no new deps; `/bymax-quality:code-review` to zero findings; open PR; return PR number.

### W1-A — Secrets, redaction, logging (core) — complexity MEDIUM, ~3 h

- **Reads:** spec 03 §6, 04 (d), 06 §2.
- **Owned:** `packages/core/src/secrets/**` (AES-256-GCM `SecretsService` impl over `SecretRepository` port, `MasterKeyFile` 0600 create/verify, `keyVersion`, `reveal` marked worker-only), `packages/core/src/redaction/**` (`Redactor`: exact values + shape patterns, `redactJson`, idempotent), `packages/core/src/logging/**` (pino factory with redact paths + `Redactor` serializer; no PII).
- **Tests:** unit suite from spec 06 §2 (roundtrip, iv uniqueness, tamper → `SecretIntegrityError`, wrong key, key-file perms, all shape patterns, deep JSON, idempotence, no false positive, logger never prints canaries).
- **DONE:** 100 % coverage; canaries never appear in any test output (`vitest` reporter grep assertion).

### W1-B 🐳 — DockerWorkspaceRunner + workspace image — complexity HIGH, ~4 h

- **Reads:** spec 03 §1, 05 §5, 06 §3.
- **Owned:** `packages/core/src/runner/docker/**` (socket resolution, container spec builder with labels/limits/security opts, `create/exec/signal/snapshot/destroy/health/list`, exec demux, timeout → KILL), `infra/workspace/**` (Dockerfile: node:24-bookworm-slim, git, rg, jq, python3, build-essential, user `agent`, `/workspace`, `askpass.sh`, git config; `ENTRYPOINT sleep infinity`), script `pnpm infra:image`.
- **Tests:** unit (pure parts with faked dockerode: socket order, spec builder, demux, timeout path); integration `@docker` (create/health/exec stdout+stdin/timeout/signal/snapshot on a real git repo/destroy/list, two-workspace isolation, limits applied, image missing → `WorkspaceImageMissing`). Integration runs only when `DOCKER_AVAILABLE=1`; otherwise the suite **fails loudly** with instructions (never silently skipped in CI).
- **DONE:** 100 % coverage on unit-testable modules; `@docker` suite green locally; image builds in < 3 min; `docker inspect` shows no secrets in image config.

### W1-C — OpenAIModelProvider — complexity MEDIUM, ~3 h

- **Reads:** spec 03 §2; official Responses API docs (verify event names at build time).
- **Owned:** `packages/core/src/model/openai/**` (provider over `openai` SDK `responses.stream`, tool mapping with `strict: true`, event mapping table, error mapping 401/429/400-context, `store:false`, `previousResponseId`, `listModels`), `packages/core/src/model/registry.ts` (`createModelProvider(name)` → openai | fake), `packages/core/fixtures/openai/*.ndjson` (recorded, redacted stream fixtures: text, tool call with args deltas, completed+usage, failed, refusal).
- **Tests:** unit with a fake SDK client replaying fixtures; every `ModelEvent` variant produced; error mapping; model id from input only.
- **DONE:** 100 % coverage; a `scripts/record-fixtures.ts` exists (manual, needs a real key, documented).

### W1-D — Agent runtime (inside the container) — complexity HIGH, ~4 h

- **Reads:** spec 03 §3, 04 (a), 06 §2 runtime section.
- **Owned:** `packages/agent-runtime/**` (`cli.ts` `turn`/`--version`, `protocol.ts` stdin reader/stdout writer using core NDJSON codec, `prepare.ts` clone/checkout/`expectedHeadSha` check, `loop.ts` step loop with limits + cancellation via SIGINT → `AbortController`, `tools/{run-shell,read-file,write-file,list-dir}.ts` with path confinement, truncation, timeout, env scrubbing, `GIT_ASKPASS`, `redact.ts` shape-only redaction, `git-events.ts` push detection, `esbuild.config.mjs` → `dist/cli.js`), and the two `COPY` lines in `infra/workspace/Dockerfile` **by instruction to the orchestrator** (W1-B owns the file; W1-D's PR description lists the exact lines; orchestrator applies them when merging the second of the two).
- **Tests:** unit for every tool against a temp dir (escape attempts, symlink, truncation notice, timeout, scrubbed env), loop with `FakeAgentModelProvider` (stops with no tool calls, `maxSteps`, cancel → `turn.cancelled`, event ordering), protocol framing, prepare against a local bare repo (`git init --bare` in tmp) incl. `workBranch` checkout and sha mismatch warning.
- **DONE:** 100 % coverage; `node dist/cli.js --version` works; bundle < 2 MB; no dependency on Postgres/Redis.

### W1-E — Persistence repositories (core) — complexity MEDIUM, ~3 h

- **Reads:** spec 02, 03 §6 (`Redactor` is injected), 06 §3 persistence.
- **Owned:** `packages/core/src/persistence/repositories/**` (Prisma implementations of every port; message `seq` in a transaction; redact-on-write via injected `Redactor`; mapping Prisma enums ↔ string-union domain types), `packages/core/src/persistence/testing/db.ts` (integration helper: truncate tables, connect to `AH_INSTANCE=test`).
- **Tests:** unit (mapping functions, redact-on-write with an in-memory fake Prisma client is **not** done — instead) integration against compose Postgres (`pnpm test:integration`, tag `@db`): CRUD per repo, cascade, partial unique index enforced, gap-free `seq` under `Promise.all`, canary never stored.
- **DONE:** 100 % coverage (integration counts toward coverage for this package — `vitest` run includes `@db` tests when DB available; CI always has DB).

### W1-F — Scheduling, workspace lifecycle, restore context (core) — complexity MEDIUM, ~3 h

- **Reads:** spec 02 §4, 03 §5, 04 (b)(c).
- **Owned:** `packages/core/src/scheduling/**` (cron validation via `cron-parser`, `nextRunAt` with tz/DST, overlap policy, `reconcile(dbJobs, schedulers)` diff, scheduler key helpers), `packages/core/src/workspace/**` (lifecycle state machine with illegal-transition errors, `ensureWorkspaceDecision`, idle-TTL selection, orphan reconcile decision), `packages/core/src/restore/**` (`buildRestoreContext` → `TurnRequest` fields: history window + `TOOL_SUMMARY` compaction + restoration notice + `expectedHeadSha`), `packages/core/src/queues/{queues,schedulers}.ts` (BullMQ queue/worker factories, `upsertJobScheduler`/`removeJobScheduler` wrappers, `maxRetriesPerRequest: null` on workers only).
- **Tests:** unit for all pure modules (DST boundaries, window budget, compaction text, notice text); integration `@redis` for queue factories and scheduler upsert/remove/list against compose Redis.
- **DONE:** 100 % coverage.

### W1-G — Web UI: shell + chats (mocked API) — complexity HIGH, ~4 h

- **Reads:** spec 10 (all), 03 §4 contracts, 04 (a)(b) for states.
- **Owned:** `apps/web/src/features/shell/**` (`AppSidebar`, `ChatList`, search ⌘K, env pill, theme toggle, keyboard shortcuts), `apps/web/src/features/chats/**` (`Composer` + `RepoPicker` + `BranchPicker`, `SuggestionCard`, `Transcript` + `UserMessage`/`AssistantMarkdown`/`ToolCallRow`/`SystemNotice`/`StreamCursor`, `StatusPill`, `ErrorCard`, archived banner, SSE client hook `useTurnEvents` with reconnect + `Last-Event-ID`, streaming reducer), pages `app/(app)/chats/new/page.tsx`, `app/(app)/chats/[id]/page.tsx`, `app/(app)/layout.tsx` (fills the sidebar slot), `apps/web/src/mocks/**` (MSW handlers implementing `api/contracts` for dev/test, incl. a scripted SSE stream).
- **Tests:** component tests (Testing Library) for every component and state in spec 10 §4.1–4.2 and §6; reducer tests; hook tests with a fake `EventSource`; a11y assertions (labels, roles, focus order) — 100 % coverage.
- **DONE:** `pnpm dev` with `NEXT_PUBLIC_API_MOCK=1` shows the home composition matching spec 10 §4.1 and a streaming chat from MSW; Lighthouse a11y ≥ 95 locally (screenshot in PR).

### W1-H — Web UI: scheduled + settings — complexity MEDIUM, ~3 h

- **Reads:** spec 10 §4.3–4.4, 03 §4.
- **Owned:** `apps/web/src/features/scheduled/**` (`JobsTable`, `JobDialog` + `CronField` + `CronPreview` + timezone combobox, `RunsTable`, `RunDrawer` reusing `Transcript` **by import from `features/chats` barrel? No — cross-feature import is banned**: `Transcript` is lifted by W1-G into `apps/web/src/shared/transcript/**` (zero domain imports) so both features use it; W1-H imports from `shared`), `apps/web/src/features/settings/**` (`SecretField` masked/replace/remove, `EnvSummary`, toasts), pages `app/(app)/scheduled/**`, `app/(app)/settings/page.tsx`, MSW handlers for jobs/runs/settings in `apps/web/src/mocks/scheduled.ts`, `settings.ts` (separate files from W1-G's).
- **Tests:** component tests for all states (empty, loading, error, validation, mask), cron preview text, 100 % coverage.
- **DONE:** both pages match spec 10 wireframes with MSW; a11y checks pass.

> Coordination note for W1-G/W1-H: W1-G creates `apps/web/src/shared/transcript/**` **first** (in its first commit) and the orchestrator merges W1-G before W1-H's final rebase; until then W1-H develops `RunDrawer` against a local stub and swaps the import at rebase. This is the only soft coupling in Wave 1.

### W1-I — Infra scripts, doctor, Conductor — complexity LOW, ~2 h

- **Reads:** spec 05 (all), 01 R2.
- **Owned:** `infra/scripts/{setup,run,archive,doctor,rotate-key}.sh`, `.conductor/settings.toml`, `infra/docker-compose.yml` (compose-profile `test` + healthchecks), `.env.example`, root `package.json` **scripts block only** (orchestrator-mediated: W1-I's PR is merged first in its batch to avoid `package.json` conflicts; other streams do not edit scripts).
- **Tests:** `bats`-free shell tests via Vitest spawning the scripts with env permutations (`AH_INSTANCE`/`CONDUCTOR_*` precedence, slugify, port math, idempotent setup, archive leaves no `ah-ws-<instance>-*`); `doctor` output snapshot.
- **DONE:** two instances (`default`, `feat-x`) start side by side with distinct ports/DBs; `doctor` table correct for both; Conductor file validates against its schema.

## 7. Wave 2 — integration lanes (after the listed W1 lanes merge)

### W2-A — Web API routes + SSE — complexity HIGH, ~4 h

- **Reads:** spec 03 §4–5, 04 (a)(d), vault SSE gotchas.
- **Owned:** `apps/web/app/api/**` (all routes from spec 03 §4, Zod-validated via `api/contracts`, repositories from core, queue producers, settings routes with request-logging disabled, `events` SSE routes: Redis Streams `XRANGE` replay + `XREAD BLOCK` tail, heartbeat, no compression, cancel via Redis pub/sub command channel), `apps/web/src/server/**` (DI container: prisma client, repos, queues, secrets service status-only, redactor, github client for `/api/repos`), `apps/web/proxy.ts` only if needed (none planned).
- **Tests:** route handler unit tests with in-memory repositories + fake queue (validation, status transitions, settings never leak plaintext); integration `@redis` for SSE replay/tail/heartbeat; 100 % coverage.
- **DONE:** UI runs against real API with `NEXT_PUBLIC_API_MOCK=0` for chats/jobs/settings CRUD (turns stay queued until W2-B).

### W2-B 🐳 — Worker processors — complexity HIGH, ~4 h

- **Reads:** spec 04 (a)(b)(c), 03 §5, 06 §3 worker e2e.
- **Owned:** `apps/worker/src/**` (`processors/run-turn.ts`, `processors/run-scheduled-job.ts`, `processors/gc.ts`, `scheduler-reconcile.ts`, `commands.ts` (cancel channel), `events.ts` (XADD publisher with MAXLEN/EXPIRE), `container.ts` (DI), `main.ts` wiring + graceful shutdown + image-present check at boot).
- **Tests:** unit with `FakeWorkspaceRunner` + `FakeAgentModelProvider` + in-memory repos (ordering of persisted events, statuses, `finally` destroy for jobs, overlap policy, stalled recovery, cancel); integration 🐳 `@docker @db @redis`: full turn with real container + fake provider, GC reaps idle + orphan, restore turn clones `workBranch`, scheduled run creates and destroys its container; 100 % coverage.
- **DONE:** with `AGENT_MODEL_PROVIDER=fake`, a chat turn round-trips UI → API → worker → container → SSE → UI.

### W2-C — E2E harness + specs (authoring) — complexity MEDIUM, ~3 h

- **Reads:** spec 06 §4.
- **Owned:** `apps/web/e2e/**` (fixtures: DB reset, local git server container `infra/test/gitserver/**` (owned too), MSW-in-server for GitHub API in test mode, helpers), the six specs from spec 06 §4, `playwright.config.ts` projects (chromium), `pnpm test:e2e` wiring, CI `e2e` job body.
- **Tests:** the specs themselves; run against W1-G/H + MSW to validate selectors; full runs only in W3-A.
- **DONE:** specs compile, selectors resolve against the mocked UI, harness boots/tears down cleanly.

## 8. Wave 3 — wiring, stabilisation, docs (2 lanes)

### W3-A 🐳 — End-to-end wiring & stabilisation — complexity HIGH, ~4 h (single agent; touches many paths, so nothing else runs in `apps/**` concurrently)

- Widen every `vitest.config` `coverage.include` to the whole package (`src/**`) and keep 100 %; wire remaining seams (worker image check banner in UI, `/api/health` ↔ env pill, cancel button, restore banner, settings-missing gate); run Playwright suite for real (Docker + Postgres + Redis + fake provider) until green 3× in a row; run **one real OpenAI smoke** with the user's key (documented script `pnpm smoke:openai`, not in CI); fix flakiness at the root; UI polish pass against spec 10 §10 checklist on real data; `pnpm doctor` final; CI all jobs green.
- **Owned:** any path, one agent. **DONE:** spec 01 §5 success criteria S1–S6, S8 verified and listed in the PR with evidence.

### W3-B — README + docs refresh — complexity LOW, ~2 h (parallel with W3-A; owns only `README.md`, `docs/**`)

- README per spec 05 §7 (quick start, config table, scripts, Conductor, testing, security notes, troubleshooting, known gaps, decisions, deployment appendix = spec 08 condensed with a link); refresh `docs/spec/*` to match reality (versions, names); this plan's §9 updated.

## 9. Wave 4 — Stryker 10 mutation testing (last, non-blocking, parallel per package)

Deliberately last: the code is stable, so mutants are meaningful, and if time runs out the product is complete without it (README "Known gaps" then states the mutation status and the plan — which is this section).

| Lane | Owned | Config | Gate |
|---|---|---|---|
| W4-A | `packages/core/stryker.config.mjs`, test improvements under `packages/core/**` | `@stryker-mutator/core@10` + `vitest-runner@10` (same version), `mutate: ['src/secrets/**','src/redaction/**','src/scheduling/**','src/workspace/**','src/restore/**','src/agent-protocol/**','src/model/openai/mapping.ts']`, `concurrency: 2`, `incremental` off for the first full run, `reporters: ['html','clear-text','progress']` | `break: 80` (target 90) |
| W4-B | `packages/agent-runtime/stryker.config.mjs`, tests under `packages/agent-runtime/**` | `mutate: ['src/tools/**','src/loop.ts','src/prepare.ts']` | `break: 80` |

Rules: kill survivors by **strengthening tests** (or simplifying code to the value that serves); no `// Stryker disable` without a one-line reason; equivalent mutants documented in the PR. When both lanes pass, a third tiny PR adds the `mutation` CI job (PR-scoped incremental, nightly full) and the README badge/section.

## 10. Risks

| Level | Risk | Mitigation in this plan |
|---|---|---|
| LOW | TypeScript toolchain incompatibility stalls W0 | Decided up front: `typescript@~6.0.3` (stable); TS 7 not used in v1 |
| HIGH | Contract drift discovered mid-Wave 1 | Contracts copied verbatim from spec 03 + Zod; additive-only change PRs; `FakeWorkspaceRunner`/`FakeAgentModelProvider` in W0 give every lane a working counterpart |
| MEDIUM | `pnpm-lock.yaml`/`package.json` merge conflicts | Full manifest in W0; scripts block owned by W1-I and merged first; no deps added in lanes |
| MEDIUM | OOM / port collisions from parallel Docker-heavy lanes | ≤ 1 🐳 lane at a time; `AH_INSTANCE` per worktree (`feat-*` ports) so even two local stacks never collide |
| MEDIUM | 100 % coverage on UI code slows W1-G/H | Components are small and state-driven; MSW + Testing Library; `coverage.include` scoped to owned paths during the wave; W3-A widens |
| MEDIUM | Subagent ends without PR (context exhaustion) | Orchestrator verifies via `git`; spawns a *finalize-agent* on the **same worktree path** to run gates, commit, push, open PR |
| LOW | Responses API event names differ from spec | W1-C verifies against official docs and fixtures; provider is the only place that changes |
| LOW | Stryker time budget | Last wave, parallel per package, explicitly allowed to slip; CI gate added only once green |

## 11. Orchestrator protocol (copy into the orchestrator session)

```text
ORCHESTRATION PROTOCOL — Agent Hangar (waves of parallel workstreams, one PR per workstream)

ROLES
- WORKSTREAM SUBAGENT (spawned per lane, isolation:"worktree", branch feat/<lane>-<slug>):
  steps 0–4 ONLY: branch off latest main → read CLAUDE.md + the lane's spec sections +
  contract files → TDD implement inside OWNED PATHS only → gates (lint, typecheck, unit
  100 % coverage all metrics, integration if tagged, code-review to zero findings) →
  commit (Conventional, English, no attribution trailers) → push → open PR → RETURN
  {pr, branch, headSha, gates, coverage, notes, contractChangeRequests[]}.
  Do NOT add dependencies, edit paths you don't own, wait for CI, merge, or chain.
- ORCHESTRATOR (this session): owns steps 5–9 per PR and the wave schedule:
  5. background poll until SIGNAL (CI fail | review posted | grace elapsed) — never fixed sleep.
  6. on findings: free the branch (remove the agent's worktree), spawn an isolated fix-agent
     with the exact findings; re-poll.
  7. MERGE only when: CI green (0 fail/0 pending) + 0 unresolved review threads +
     ≥ 4–5 min grace since last push. Re-fetch FRESH thread ids, reply+resolve one by one.
     `gh pr merge --squash --delete-branch`.
  8. sync main, remove worktree, verify no stale remote branch, update docs/plan.md §12.
  9. spawn the next lanes whose dependencies (plan §4 table) are all merged, respecting
     cap 5 and ≤ 1 🐳 lane; stop only when Wave 4 is merged or explicitly deferred.

MERGE ORDER INSIDE A WAVE: W1-I first (scripts block), then any lane as it turns green;
W1-G before W1-H's final rebase; W1-B and W1-D: apply W1-D's Dockerfile COPY lines when
merging the later of the two.

AUTONOMY BACKBONE: never end a turn without a pending tracked job OR an armed long
ScheduleWakeup (1200s+) whose prompt states the CURRENT wave/lane status.

VERIFY, DON'T TRUST: confirm every claim via git/gh (`git rev-list --count main..HEAD`,
`git status --porcelain`, `gh pr view`). Never Read an agent's transcript output file.

RESOURCE RULES: ≤ 5 concurrent subagents; ≤ 1 Docker-integration lane at a time;
each worktree uses AH_INSTANCE=<lane> so local stacks never collide.
```

## 12. Status dashboard (orchestrator keeps this current)

**Where the build stands** — read from `gh` and `git` on 2026-08-20, not from memory.

| | |
|---|---|
| Default branch | `main`; check its latest run with `gh run list --branch main --limit 1` rather than trusting a status recorded here, which ages the moment anything merges |
| Lanes merged | **10 of 17** — the foundation lane and **all nine first-wave lanes**; the first wave is complete |
| Lanes in review | **2** — the web API and the worker processors |
| Lanes in progress | **1** — end-to-end authoring, started the moment its gate cleared |
| Lanes not started | **4** — wiring and stabilisation, documentation, and both mutation-testing lanes |
| Tasks merged | **57 of 94** |
| Tasks written but not yet merged | **12** on the two open lane branches, so 69 of 94 exist as code |
| Routed findings still open | **23**, in §14 below, each naming one lane |
| Orchestrator fixes | **13 merged, 1 open** — defects found while shepherding, listed under the lane table |

Three tables in this section describe the same build and are updated together, because one of them
being stale is how a reader ends up with the wrong answer: the lane table, the orchestrator-fix
table beneath it, and the task-progress table at the end. The lane index in `docs/tasks/README.md`
mirrors the first of them and moves with it.

The task counts come from the per-lane task indexes in `docs/tasks/`. A lane's tasks only count as
merged once its pull request lands, so the gap between 57 and 69 is exactly the two lanes still in
review.

**What unblocks what.** The first wave is done, so the end-to-end lane's gate has cleared and it is
running. The third wave needs both remaining second-wave lanes merged, and the mutation lanes need
the third. So the critical path now runs through the two pull requests in review, and the
end-to-end lane proceeds alongside them rather than behind them.

| Lane | Status | Branch / PR | Coverage | Notes |
|---|---|---|---|---|
| W0 | 🟩 merged | PR #4 | core 100 / web 100 / worker 100 (all four metrics) | TypeScript pinned `~6.0.3` |
| W1-A | 🟩 merged | PR #6 | core 100 (all four metrics) | secret ciphertext bound to its key as GCM AAD; master-key file refuses symlink, FIFO and group/world-readable modes |
| W1-B 🐳 | 🟩 merged | PR #7 | 100/100/100/100 (runner/docker) | subpath export `@agent-hangar/core/runner/docker`; `/opt/agent-runtime` stays root-owned so the workspace cannot replace the askpass helper |
| W1-C | 🟩 merged | PR #10 | core 100 (all four metrics) | openai SDK 7.5.0 verified against its shipped types; no SDK or server text reaches a persisted event |
| W1-D | 🟩 merged | PR #11 | 100/100/100/100 (agent-runtime `src/**`) | three Dockerfile `COPY` lines (bundle, map, `{"type":"module"}` manifest) written in the PR body for the infra lane to apply, not in this diff; path confinement resolves symlinks |
| W1-E | 🟩 merged | PR #8 | core 100 (all four metrics) | status stamps are transactional; `ScheduledJob.prompt` and `Chat.title` redacted on write |
| W1-F | 🟩 merged | PR #12 | core 100 (all four metrics) | BullMQ 6 API read from the installed types |
| W1-G | 🟩 merged | PR #19 | web 100 (all four metrics) | chats list, composer and streaming detail; Lighthouse accessibility 100 on both routes |
| W1-H | 🟩 merged | PR #24 | web 100 (all four metrics) | 27 placeholder files removed and the screens adapted to the real modules; Lighthouse accessibility 100 on all three routes |
| W1-I | 🟩 merged | PR #18 | scripts 100 (all four metrics) | run, doctor, archive, prune and the Conductor wiring; the two-instance walkthrough was executed against real Docker, not simulated |
| W2-A | 🟨 PR open | PR #21 | web 100 · core 100 (all four metrics) | 19 routes and both SSE streams; found and fixed a path traversal in the forge slug pattern that would have sent the authorisation header to an unnamed path |
| W2-B 🐳 | 🟨 PR open | PR #22 | worker 100 (all four metrics) | three consumers, cancel channel, scheduler reconcile and graceful shutdown; Docker suite ran green six consecutive times with no leftover containers |
| W2-C | 🟦 running | `feat/w2c-e2e` | — | gate cleared: both interface lanes merged. Authors the Playwright harness and six specs in mock mode so the wiring lane only has to run and stabilise them |
| W3-A 🐳 | ⬜ | — | — | success criteria S1–S6, S8 |
| W3-B | ⬜ | — | — | |
| W4-A | ⬜ | — | — | may slip — documented |
| W4-B | ⬜ | — | — | may slip — documented |

**Orchestrator fixes alongside the lanes** (not lanes of the plan; each fixes a defect found while shepherding, and the Status column says whether that fix has landed):

| PR | Status | The defect |
|---|---|---|
| #1 · #2 · #3 | 🟩 merged | The launch decisions, the web security defaults and the container grouping were agreed in conversation and existed nowhere a lane could read them |
| #5 | 🟩 merged | `@agent-hangar/core` was unresolvable from source, so a fresh worktree could not run the worker; repository URLs hardened |
| #9 | 🟩 merged | The `e2e` job installed a browser to run an empty suite, taking 111–1367 s and gating every merge |
| #13 | 🟩 merged | A connection failure repeated the driver message and attached the driver error as `cause`, leaking the database password twice over |
| #14 | 🟩 merged | The destructive-test guard printed the password back when the connection URL had no authority |
| #15 | 🟩 merged | This dashboard had drifted six merges behind reality |
| #16 | 🟩 merged | The workspace image had no agent runtime in it: the bundle was described in a pull request body and never applied |
| #17 | 🟩 merged | Updating this dashboard was treated as an errand to schedule rather than the last step of the merge in front of it |
| #20 | 🟩 merged | The development server could not resolve the shared package at all: it requests the source condition unconditionally and resolves the NodeNext specifiers literally |
| #23 | 🟩 merged | Findings that no lane could close had no record outside a conversation |
| #25 | 🟩 merged | A routed row stated a contract change as though it had landed, and named the wrong remedy for it |
| #26 | 🟩 merged | `pnpm typecheck` emits without rewriting, so it leaves a `dist` whose declarations name files that do not exist |
| #27 | 🟩 merged | The dashboard and the task index disagreed about which lanes were ready |
| #28 | 🟨 PR open | The dashboard listed every lane's state but never what it added up to |

Legend: ⬜ not started · 🟦 running (branch) · 🟨 PR open · 🟩 merged · 🟥 blocked.

**Task progress per lane.** *Merged* counts tasks whose lane has landed on `main`; *on its branch*
counts tasks a lane has finished but not yet merged. Taken from each lane's own task index, so a
number here is only as current as the last close-out that lane wrote.

| Lane | Merged | On its branch | Total |
|---|---|---|---|
| W0 | 8 | — | 8 |
| W1-A | 5 | — | 5 |
| W1-B | 5 | — | 5 |
| W1-C | 5 | — | 5 |
| W1-D | 5 | — | 5 |
| W1-E | 5 | — | 5 |
| W1-F | 5 | — | 5 |
| W1-G | 7 | — | 7 |
| W1-H | 6 | — | 6 |
| W1-I | 6 | — | 6 |
| W2-A | 0 | 6 | 6 |
| W2-B | 0 | 6 | 6 |
| W2-C | 0 | — | 6 |
| W3-A | 0 | — | 6 |
| W3-B | 0 | — | 5 |
| W4-A | 0 | — | 4 |
| W4-B | 0 | — | 4 |
| **Total** | **57** | **12** | **94** |

## 13. Estimated complexity

| Wave | Agent hours (sum) | Wall-clock (cap 5, ≤ 1 🐳) |
|---|---|---|
| W0 | 3 | 3 |
| W1 | 29 | ≈ 7 (two batches: A,B🐳,C,E,F then D🐳,G,H,I — I is short and merges first) |
| W2 | 11 | ≈ 4 |
| W3 | 6 | ≈ 4 |
| W4 | 4 | ≈ 2 (deferrable) |
| **Total** | **53** | **≈ 18–20 h** |

## 14. Routed findings that no lane owns yet

Raised by a review, a lane report or the orchestrator, confirmed against the code, and too large or
too cross-cutting to fold into the lane that found them. **Every row names exactly one lane**, never a
role and never a choice between two — an owner a reader has to resolve is how an item gets dropped,
which is the failure this section exists to prevent.
Nothing here is silently dropped: an item that ships unfixed becomes a README "Known gaps" entry
stating the residual risk in plain terms.

| # | Finding | Why it was not fixed in place | Owner |
|---|---|---|---|
| R1 | A task's `run_shell` can read the forge token through `AH_GIT_TOKEN_FILE` and send it anywhere the container can reach. Credential mediation via `GIT_ASKPASS` stops the token appearing in a remote URL or in `git` output; it does not stop code that deliberately reads the file. | The obvious mitigation does not work as stated: a second uid that cannot read the token file also stops `askpass.sh` authenticating, because Git runs it as a child of the agent process and it reads that same file. Any real fix has to keep the helper's access while denying the task's — a setuid or setgid helper, a credential daemon on a socket the task cannot reach, or moving mediation out of the container entirely — together with an egress policy. That is a change to the container's process model, not a patch. | W3-A |
| R2 | The BullMQ scheduler keeps every completed repeatable job. At one job every five minutes that is 288 records a day, growing without bound in Redis. | Retention belongs with the processors that create the jobs, not with the scheduling contract. | W2-B |
| R3 | `JobRun.workspaceId` is not constrained to workspace-kind identifiers. Both the in-memory double and the Prisma repository must change together for the invariant to mean anything. | Split across two lanes it would be half-enforced, which is worse than not claiming it. | W3-A |
| R4 | Vitest resolves `@agent-hangar/core/testing` through the production condition rather than the source. It passes only because the built output happens to be present. | Needs the `development`-condition contract test extended rather than a local workaround. | W3-A |
| R5 | `packages/core/fixtures/openai/recorded-*.ndjson` is not ignored. A recorded fixture carries whatever the live API returned. | Belongs with the fixture-recording story rather than an unrelated diff. | W3-A |
| R6 | No continuous-integration job declares `timeout-minutes`. A hung job holds a runner for the platform default of six hours. | Infrastructure hygiene, not a lane deliverable. | W3-A |
| R7 | `healthResponse` declared `ports` as required on the web API lane's branch, which its own rules forbid — additive changes to an existing response schema may only add optional fields — and which would have broken `seedHealth()` in another lane's mocks on merge. | **Fixed on that branch, pending merge**: the field is now optional, all three ports still required together when the block is present, and the contract test asserts a report without ports parses while an incomplete block does not. Close this row when that pull request lands. | W2-A |
| R8 | Four contract values are **mirrored** in `apps/worker/src` rather than imported — `TURN_EVENT_FIELD` in `events.ts`, the heartbeat key, timings and schema in `heartbeat.ts`, and the scheduled-delivery payload in `processors/run-scheduled-job.ts`. Each is byte-identical to the definition in `packages/core/src/queues/contracts.ts` today. | They live on the web API lane's branch, which the worker lane may not touch. Two copies of a constant diverge silently and both sides stay green — this must become a one-line import each the moment that branch merges. | W2-B, in a follow-up opened the moment #21 merges |
| R9 | The same-origin guard compares `Origin` against `Host`, which DNS rebinding defeats. Closing it needs a Host allow-list. | A deployment decision, not a code one: the app binds to loopback, and an allow-list would refuse any proxy an operator fronts it with. Documented in `same-origin.ts`. | W3-A |
| R10 | `WorkspaceRunner` exposes no `imageExists`, so the boot check and the health card report what the last `create` observed — accurate once anything has run, optimistic before that. | Not the one-file change it looks like: `DockerWorkspaceRunner` and `FakeWorkspaceRunner` both declare that they implement `WorkspaceRunner`, so adding a method to the port breaks both until each implements it — the port, the real runner and the double must land together. | W3-A |
| R13 | A driver error reaching the 5xx log carries the Postgres password. The pino serializer runs the redactor over message and stack, which covers both credentials this repository's rule names — the forge token is now registered by exact value, and the model key never enters the web process — but the database password is neither registered nor shape-matched, so a connection-failure message can put it in a log. | The redaction policy lives in `packages/core/src/redaction`, which is frozen, and the password is not one of the two secrets the stated rule protects. Widening what counts as a secret is a policy decision, not a lane fix. | W3-A |
| R15 | Three worker file headers assert that only an unreachable Docker daemon rejects and that BullMQ therefore retries the turn. Measured against the installed library and the queue construction, nothing retries: `attempts` defaults to 0, `enqueueRunTurn` sets none, `createQueue` declares no default job options, and the only redelivery configured is stalled recovery for jobs whose lock lapsed. Either those comments are wrong or the queue options are. | Adding `attempts` and `backoff` belongs in `packages/core/src/queues/queues.ts`, which is frozen. Until it lands, a transport error must stay terminal — leaving the turn non-terminal would strand it with no event on its stream, which is a worse defect than the one it would fix. | W3-A |
| R16 | The workspace claim that serialises the turn processor against the idle collector is process-local, because `WorkspaceRepository` exposes only an unconditional `setStatus` with no conditional update to build a real claim from. It matches today's deployment — one worker process per instance — and says so in its own header. | A `claim(id, expectedStatus, nextStatus)` returning null when the row moved is the honest home for this, and it lives in frozen persistence code. Needed before a second worker process is ever run. | W3-A |
| R14 | `GITHUB_API_BASE_URL` and `ALLOWED_REPO_HOSTS` promise that another forge can be configured, but the `repoUrl` schema shared by the chat and job requests accepts only `https://github.com/...`. An Enterprise or self-hosted repository therefore appears in the picker and then fails with a 400 the user cannot act on. | Both halves must change together and `repoUrl` is in frozen core. Either the schema consults the configured hosts or the configuration stops offering what the contract refuses — that is a product decision, not a patch. | W3-A |
| R12 | `packages/core`'s `loadConfig()` still treats the instance-derived ports as defaults, so an explicit `POSTGRES_PORT` in the process environment wins there. `env.sh` is now stricter than the library it mirrors. In practice everything loads from `.env.local`, which `env.sh` writes with derived values, so the two agree today. | Making the identity block non-overridable lives in `packages/core/src/config/schema.ts`, which is frozen and belongs to no open lane. | W3-A |
| R17 | `pnpm test` is `pnpm -r --if-present test && vitest run --project scripts`. The `&&` means a failure in any workspace stops the run, so the scripts suite never executes — a flake elsewhere silently voids it, and the job reports the earlier failure rather than "these tests did not run". Observed: a timing-dependent web test failed, the scripts suite was never reached, and the tests that mattered to the change under review were never executed. | Restructuring the root test script and how continuous integration reports per-workspace results is repository-wide tooling, not a lane deliverable. | W3-A |
| R18 | `tsc -b && <rewrite>` short-circuits, so a failing typecheck emits a partial output and skips the rewrite. Worse, a **successful** typecheck also emits without rewriting when it is the root `tsc -b` rather than the package build, which then fails that package's own guard test on the very next test run — a failure nobody introduced. Accepted as unlikely when the chain was written; observed independently twice within the hour, once from a tree with no generated database client and once from an ordinary typecheck-then-test sequence. The working order is typecheck, then build the shared package, then tests. | Preserving the compiler's exit code while always rewriting needs exit-code handling in four manifests. The cheaper answers are making the prerequisite explicit so the compile does not fail that way, and making the gate order not matter. | W3-A |
| R19 | `postMessage` bumps the chat's ordering timestamp after the turn has been dispatched, and that last write is unguarded. Its failure answers 500 for a turn the worker already holds, and a caller who retries meets its own turn reported as already in progress. | Pre-existing and unchanged by the work that surfaced it — the bump was already the last unguarded statement. Neither available fix is better than the gap: reusing the compensation helper misuses an undo for a best-effort write, and an inline catch duplicates it and adds a second place that swallows. The limit is named in the module header instead, which is the standard this file is held to. | W3-A |
| R20 | The ownership map gives a lane its source directory, but a package manifest's scripts block now has two authors: the lane, and repository-wide infrastructure work that must chain a build step from every script reaching the shared package. Nothing states who wins, so a rebase resolved mechanically can drop one side without complaining — the collision was found only because a lane stopped and read it. | The map needs a rule for shared manifests, not a fix to either change. Measured today: of the branches in flight exactly one is affected, so the rule is cheap to write now and expensive later. | W3-B |
| R21 | Deleting a scheduled job is not serialised with editing it. After the scheduler is removed, a concurrent edit can rewrite the row and recreate the scheduler; the delete then removes the row, leaving a scheduler firing on its cron for a job that no longer exists. | Bounded in two ways, both measured rather than assumed. A delivery naming a missing job is failed with an explicit reason and a terminal event, so the orphan produces reporting failures and not corruption. And the worker's scheduler reconciliation removes schedulers with no matching enabled job — but only at worker startup, so the orphan fires on its cron until the next restart. Closing it properly needs the conditional or versioned write the persistence port does not offer. | W3-A |
| R22 | Deleting a chat has the same check-then-write shape: its live-turn check precedes the delete, so a concurrent message can claim a turn the cascade then removes. Found by the lane while fixing the sibling race in the archive path, and deliberately not folded into that round. | Not corrupting — the chat and everything under it are gone either way, and the losing request fails with an error and logs the release it could not perform. It shares R21's root cause and should be fixed with it rather than separately. | W3-A |
| R23 | The turn processor refines its stalled-workspace recovery on the delivery attempt count. That field never moves for a job rescued from a dead worker: the library's stalled-recovery script increments a separate stalled counter and never touches the attempt count, and nothing here configures retry attempts. The refinement is therefore dead code. | Not a defect today — the recovery's other arm, a workspace left busy, is what actually catches an abandoned turn, so the behaviour is right for the wrong reason. It becomes one the moment someone relies on the attempt count or removes the other arm. Found while fixing the same mistake in the sibling processor, where it *was* load-bearing and would have shipped a guard that silently preserved the defect it was written to fix. | W3-A |
| R11 | The presence check that greps route files for `assertSameOrigin` reports every route as covered **by construction**, because the guard lives in the handler behind a thin wiring module. It cannot fail. | Replaced by `apps/web/app/api/same-origin-policy.test.ts`, which calls every state-changing export from a foreign origin and names the offending route when the guard is removed. The grep must be retired from the lane prompts so it is not reintroduced. | W3-B |

Approved 2026-08-19. Per-lane task files with self-contained agent prompts live in [docs/tasks/](tasks/README.md).
