# Agent Hangar — Implementation Plan (orchestrator + parallel subagents)

| | |
|---|---|
| **Status** | ✅ Approved — 2026-08-19 · task files: [docs/tasks/](tasks/README.md) |
| **Source spec** | [docs/spec/](spec/README.md) (01–10) — this plan executes it; where they differ, this plan wins on *sequencing*, the spec wins on *behaviour* |
| **Execution model** | One orchestrator session; each workstream = one isolated subagent in its own git worktree = one PR. Workstreams in the same wave run **in parallel** |
| **Quality bar** | TS strict, zero suppressions, JSDoc on every export, **100 % coverage on all four metrics (lines / branches / functions / statements) per package**, gates green before every PR. Stryker 10 mutation testing is the **final wave** and is explicitly allowed to slip |
| **Last updated** | 2026-08-20 · every count in §12 is re-derived from `gh` and `git` at the top of that section, never carried forward from this line |

**If you have just arrived.** This is the *build plan*: how the work was cut into lanes that own
disjoint paths, in what order those lanes run, and what each one has to prove before it merges.
It does not describe what the product does — [docs/spec/](spec/README.md) does that, and `README.md`
is the operator's entry point.

- **"What is the state of this project?"** → [§12 Status dashboard](#12-status-dashboard-orchestrator-keeps-this-current).
  It holds the lane table, the fixes merged alongside the lanes, and the per-lane task counts, and
  it names the `gh` and `git` commands that settle any disagreement with it.
- **"What is known to be wrong or missing?"** → [§14 Routed findings](#14-routed-findings-that-no-lane-owns-yet).
  Every defect and gap that no merged lane closed, open and closed alike, with the reasoning that
  put it there.
- **"Why is it built this way?"** → §1–§4 (requirements, reuse scan, parallelism rules, wave plan).
- §5–§9 are the lane briefs, §10 the risk register, §11 the orchestration protocol and §13 the
  original estimates. They are the instructions the build ran on and are kept as the record of it;
  they are not a description of today.

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
5. **Shared files are pre-split.** `packages/core/src/index.ts` re-exports one barrel per folder; a lane adds exports only to the barrel of the folder it owns. Each package's `vitest.config.ts` `coverage.include` was the one file several lanes appended a line to, one line per lane at the end. **That convention is retired**: every package now measures its whole `src/**`, so a new folder is covered the moment it exists and no file depends on a lane having remembered to claim it. Root `package.json` scripts are owned by W1-I (merged first).
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

Each lane below is one subagent prompt. Common to all: read `CLAUDE.md`, the spec documents named, and the contract files; TDD (`/bymax-quality:tdd`) — tests first; JSDoc on exports; test-file headers + `it()` comments; 100 % coverage on **owned** `src/**` (the package's `vitest.config` `coverage.include` was scoped to owned paths during the waves and now covers the whole `src/**`); no new deps; `/bymax-quality:code-review` to zero findings; open PR; return PR number.

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

- Widen every `vitest.config` `coverage.include` to the whole package (`src/**`) and keep 100 %; wire remaining seams (worker image check banner in UI, `/api/health` ↔ env pill, cancel button, restore banner, settings-missing gate); run Playwright suite for real (Docker + Postgres + Redis + fake provider) until green 3× in a row; run **one real OpenAI smoke** with the user's key (documented script `pnpm smoke:openai`, not in CI); fix flakiness at the root; UI polish pass against spec 10 §10 checklist on real data; `pnpm infra:doctor` final; CI all jobs green.
- **Owned:** any path, one agent. **DONE:** spec 01 §5 success criteria S1–S6, S8 verified and listed in the PR with evidence.

### W3-B — README + docs refresh — complexity LOW, ~2 h (parallel with W3-A; owns only `README.md`, `docs/**`)

- README per spec 05 §7 (quick start, config table, scripts, Conductor, testing, security notes, troubleshooting, known gaps, decisions, deployment appendix = spec 08 condensed with a link); refresh `docs/spec/*` to match reality (versions, names); this plan's §9 updated.

## 9. Wave 4 — Stryker 10 mutation testing (last, non-blocking, parallel per package)

Deliberately last: the code is stable, so mutants are meaningful, and if time runs out the product is complete without it (README "Known gaps" then states the mutation status and the plan — which is this section).

**Status: deferred by the operator on 2026-08-20.** Both lanes stay in the plan and are expected to be taken up later; nothing about the design below changes. This is a scheduling decision, not a cancellation and not a blockage — the two are different, and a reader who finds these rows should not go looking for the missing dependency. What the product ships without is the mutation gate, and the README says so in plain terms.

| Lane | Owned | Config | Gate |
|---|---|---|---|
| W4-A | 🟡 deferred | — | **Deferred by the operator on 2026-08-20, not blocked and not cancelled.** Mutation testing on `packages/core` stays in the plan and will be taken up later. It was never a gate: the section below already says the product is complete without it. Do not start it on the strength of its dependency graph — it needs the operator to say so |
| W4-B | 🟡 deferred | — | **Deferred by the operator on 2026-08-20**, on the same terms as W4-A, for `packages/agent-runtime` |

Rules: kill survivors by **strengthening tests** (or simplifying code to the value that serves); no `// Stryker disable` without a one-line reason; equivalent mutants documented in the PR. When both lanes pass, a third tiny PR adds the `mutation` CI job (PR-scoped incremental, nightly full) and the README badge/section.

## 10. Risks

| Level | Risk | Mitigation in this plan |
|---|---|---|
| LOW | TypeScript toolchain incompatibility stalls W0 | Decided up front: `typescript@~6.0.3` (stable); TS 7 not used in v1 |
| HIGH | Contract drift discovered mid-Wave 1 | Contracts copied verbatim from spec 03 + Zod; additive-only change PRs; `FakeWorkspaceRunner`/`FakeAgentModelProvider` in W0 give every lane a working counterpart |
| MEDIUM | `pnpm-lock.yaml`/`package.json` merge conflicts | Full manifest in W0; scripts block owned by W1-I and merged first; no deps added in lanes |
| MEDIUM | OOM / port collisions from parallel Docker-heavy lanes | ≤ 1 🐳 lane at a time; `AH_INSTANCE` per worktree (`feat-*` ports) so even two local stacks never collide |
| MEDIUM | 100 % coverage on UI code slows W1-G/H | Components are small and state-driven; MSW + Testing Library; `coverage.include` scoped to owned paths during the wave, widened to the whole package afterwards |
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
| Lanes merged | **14 of 17** — the foundation, all nine first-wave lanes, all three integration lanes (web API, worker, end-to-end) and the documentation lane. Their 14 pull requests are #4, #6, #7, #8, #10, #11, #12, #18, #19, #21, #22, #24, #32 and #37; every other merged pull request is an orchestrator fix, which is how the last row of this table is derived |
| Lanes in review | **0**, and a reader can check it without asking GitHub: the lane set is closed at 17 and every one of them is a row of the table below, so a lane in review would say so there. Pull requests open against `main` at any given moment are orchestrator fixes; their number is not recorded here, for the reason the next-but-one row gives |
| Lanes not merged | **3** — wiring and stabilisation (📋 ToDo) and both mutation-testing lanes (🟡 deferred by decision on 2026-08-20: they stay in the plan and are scheduled later — §9). Deferred is not blocked and not cancelled |
| Tasks merged | **80 of 94** |
| Tasks written but not yet merged | **0** — nothing is on a lane branch; the 14 that remain are W3-A's six and the two mutation lanes' eight |
| Routed findings still open | **27** of the 47 rows in §14 below. Closed rows are marked, not deleted, so this is the count of rows whose **Owner column** does not begin with 🟩 or `superseded`. Read that column, not the whole line: a row can say "superseded" in its prose while still being open, and a check that greps the line miscounts it. It was 31 of 44 before this refresh: six rows (R12, R13, R28, R33, R34, R35) closed against PRs #60 and #61, which had landed without the board recording it, R10 went half-closed and stayed open, and three rows were added of which two are open. **This number moves the day PR #56 merges**: as that branch stands it adds R39, R40 and R41 and closes R16, and it is being reworked, so what arrives may differ. Re-derive rather than trust: read the last column of every `| R…` row and count the ones that do not begin with 🟩 or `superseded` |
| Orchestrator fixes | **No total is recorded here, deliberately.** They are *every merged pull request that is not one of the 14 lane pull requests named two rows up*; to get the number, run `gh pr list --state merged --limit 200 --json number` and subtract those 14. The table below the lane table names the fifty merged by 2026-08-20 — anything merged after that date is missing from it by construction, and the table is a record of what was fixed rather than a count of it. The previous version of this row said "41 merged, 0 open" when the true figure was 48: it double-counted a lane's own pull request as a fix and had no row for nine merged ones. That correction was then overtaken twice more before it could merge — #64 and #62 landed — and its open-side figure was wrong the moment it was typed, because the pull request carrying it was itself an open orchestrator fix and could not count itself. A line that cannot be right while it is being written is not worth keeping right |

Four tables in this section describe the same build and are updated together, because one of them
being stale is how a reader ends up with the wrong answer: the lane table, the two orchestrator-fix
tables beneath it (what has merged, then the one open pull request that moves §14), and the task-progress
table at the end. The lane index in
`docs/tasks/README.md` mirrors the first of them and moves with it, and so does each lane file's own
header block — three places, one value. Where they disagree, the merged state settles it.

Every count above is derived, and each one says from what. **A number is recorded here only when the set it
counts is enumerated in this document** — the 17 lanes, the 94 tasks, the rows of §14. Those move only when
something in these pages moves, and a reader can recount them without leaving the file. The pull requests of
this repository are not such a set: they change while the page is being written. For those, this section keeps
the derivation and the command and not the answer. Nothing here should be believed over `gh pr list --state all
--limit 200` and `git log --oneline origin/main`.

The task counts come from the per-lane task indexes in `docs/tasks/`. A lane's tasks only count as
merged once its pull request lands, so there is no gap today: nothing is on a branch.

**What unblocks what.** Nothing on this board is blocked. Every dependency of the wiring lane —
the web API, the worker and the end-to-end harness — is merged, so W3-A is available to start and
is the only lane whose remaining work is gated on nobody. The two mutation lanes name W3-A as their
dependency, but they are not waiting on it: they were deferred by decision on 2026-08-20 (§9), so
they would still need the operator to say so even if W3-A merged tomorrow.

An earlier version of this paragraph said the wiring lane was gated on the end-to-end lane "in
review". That lane merged as PR #32 on 2026-08-20 and the sentence outlived it, which is why the
lane table now carries the merge state and this paragraph carries only what follows from it.

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
| W2-A | 🟩 merged | PR #21 | web 100 · core 100 (all four metrics) | 19 routes and both SSE streams; found and fixed a path traversal in the forge slug pattern that would have sent the authorisation header to an unnamed path |
| W2-B 🐳 | 🟩 merged | PR #22 | worker 100 (all four metrics) | three consumers, cancel channel, scheduler reconcile and graceful shutdown; Docker suite ran green six consecutive times with no leftover containers |
| W2-C | 🟩 merged | PR #32 | web 100 (all four metrics) | Playwright harness, a local git server and the six critical-flow specs. Merged against **its own** Definition of Done — specs compile, selectors resolve, the harness boots and tears down — not against a real-mode pass, which §7 assigns to W3-A in as many words. It was the integration canary regardless: five defects blocking a real turn were found through it and fixed elsewhere (the client clone URL, the scheduled-run cancel route, the repository-origin policy, the scripted-provider script and the unwired model provider). The last recorded real-mode figure is **7 of 9**, measured before PR #61. Its two failures were R34 and R35 (R33 is the assertion that could not fail, not a failure) — an earlier version of this row named R33 and R34, which was wrong. PR #61 found and fixed the cause of both: the scripted double omitted arguments the tools require under strict function calling, so four calls were refused before they ran, and the archive check waited for the double's wording rather than the product's. **No real-mode run has been recorded since**, so 9 of 9 is expected and unmeasured — run it before repeating a number here |
| W3-A 🐳 | 📋 ToDo | — | — | **The lane has not run: its six tasks are untouched and no branch exists.** What it is for: switch the system from doubles to the real stack, run it end to end, and prove spec 01 §5 success criteria S1–S6 and S8 with evidence in the pull request — that is its DONE. Nothing blocks it; every dependency is merged. **But its backlog is not what it was, and the difference is not the lane's doing.** Besides its own six tasks it was routed every finding no lane owned, and eleven of those have since been closed by orchestrator fix pull requests instead: R4, R5, R6, R17 and R18 by PR #46; R12, R13 and R28 by PR #60; R33, R34 and R35 by PR #61. R10 was closed halfway by PR #60 — the port gained `imageExists`, the two consumers still read the remembered value — and stays open. What genuinely remains is **27 open rows in §14**, R2 and R8 included since their lanes closed without them. They are not one job: four of them — R16, R21, R22 and R26 — are the same missing primitive, a conditional terminal write the persistence port does not offer, and PR #56 is open against exactly that. The rest fall into three recognisable groups — the container's security model (R1, R9, R29, R30), what a transcript can and cannot show, live or reloaded (R32, R44, R46, R49), and defects no check in this repository can see (R42, R43, R50) — and the remainder are single items. R48 sits beside them as a decision rather than a finding: the preparation notice is ephemeral on purpose, and the row exists so nobody closes it by reversing that. The pattern of the last three days is the argument for splitting them: everything that did not need a running system was taken out by a fix pull request and closed, and what is left is what actually needs the system this lane exists to produce |
| W3-B | 🟩 merged | PR #37 | n/a (docs only) | README rewritten against the running system, every command executed from a fresh clone; three claims corrected because verification refuted them (`pnpm doctor` is shadowed by pnpm's own command, five scripts resolved the instance from the shell while `setup`/`run` read `.env.local`, and the `RequestContext` in 09 does not exist); R11 and R20 closed in `docs/AUTOPILOT.md`. The five-scripts finding describes behaviour that PR #39 has since replaced: every instance-acting script now reads the checkout's `.env.local` and refuses on disagreement, and the shadowed command has the working alias `pnpm infra:doctor` |
| W4-A | 🟡 deferred | — | — | deferred by the operator on 2026-08-20; stays in the plan, taken up later — see §9 |
| W4-B | 🟡 deferred | — | — | deferred by the operator on 2026-08-20; stays in the plan, taken up later — see §9 |

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
| #28 | 🟩 merged | The dashboard listed every lane's state but never what it added up to |
| #29 | 🟩 merged | The summary recorded a branch tip and a continuous-integration state, both of which age the moment anything merges|
| #30 | 🟩 merged | The first wave completed and the board still showed a lane blocking it; two delete-versus-edit races had no record|
| #31 | 🟩 merged | A finding was being carried as a limit when a third option closed it outright |
| #33 | 🟩 merged | The scripts suite failed under load from two independent causes: no timeout for its process trees, and workers colliding over the same port bases |
| #34 | 🟩 merged | The configuration offered a configurable forge while two validators refused everything but one hard-coded host, so end-to-end real mode could not start |
| #35 · #36 | 🟩 merged | The board lagged two integration lanes; a web test waited on a request being seen rather than on the settled state. **#37 used to be listed here and is not a fix**: it is the documentation lane's own pull request and belongs to the lane table above, where it already appears — counting it in both places is what made this table's total read one too high |
| #38 | 🟩 merged | Stopping a scheduled run answered 404: the only cancel route resolved through the turn repository, which never holds a run id |
| #39 | 🟩 merged | Five scripts read the instance from the shell while `setup`/`run` read the checkout, the health probes reported a listening socket as a working service, and `pnpm doctor` ran pnpm's own command instead of this project's |
| #40 | 🟩 merged | A Stop the API had already accepted with 202 was recorded as `FAILED` on every branch that ends a run without executing it — in both processors |
| #41 | 🟩 merged | The interface rebuilt clone URLs against a hard-coded origin instead of carrying the one the API returned, so editing an unrelated field of a job silently rewrote its repository |
| #42 | 🟩 merged | The scripted provider's script was set by the end-to-end harness and read by nothing: the worker's container environment is a fixed set that never carried it, so a real run always played the built-in answers |
| #43 · #45 · #48 | 🟩 merged | The dashboard drifted behind the merges three times, and each round of findings had nowhere to live until it did |
| #44 | 🟩 merged | The credential helper released the forge token to any origin a crafted prompt named — the URL authority was cut at `/` only, so `https://evil.test?@github.com` reduced to the approved host; and the policy itself was an environment entry the model could set inline through `bash -lc` |
| #46 | 🟩 merged | `pnpm test` stopped before the scripts project whenever any workspace failed, and `tsc -b && <rewrite>` skipped the rewrite on a failed compile, leaving declarations naming files that do not exist |
| #47 | 🟩 merged | The repository picker gave no sign which repositories the agent cannot push to — read-only or archived — or cannot work from at all, having no branch; and the composer's Send button went dead without saying which of three things was missing |
| #49 | 🟩 merged | The OpenAI provider was never wired into the binary the container runs: `bin.ts` fed no factory and the seam was optional, so every real turn failed with `the openai provider is not wired into this build`. **Spec 01 §5 S1 and S6 had therefore never been demonstrated** |
| #50 | 🟩 merged | `CLAUDE.md` still told authors to chain the declaration rewrite by hand, contradicting the guard that now forbids naming the compiler directly |
| #51 | 🟩 merged | Findings were **deleted** from §14 when they closed, so a reader could not tell one that closed from one that never existed — while the section promised nothing is silently dropped |
| #52 | 🟩 merged | Two optional fields still let an unwired build type-check; the seam had survived #49 because `TurnDeps` restated its members instead of extending, so the two could require different things |
| #53 | 🟩 merged | A chat's **second turn** could never start: preparation chose its path on whether the work branch existed on the *remote* and never looked locally, so a reused workspace whose first turn had not pushed failed with `already exists`. A force-pushed work branch also broke preparation permanently, on an unforced fetch refspec |
| #54 · #55 · #58 · #65 | 🟩 merged | Four more rounds of board work: mutation testing was deferred by decision and had no record saying so; an image built from one checkout serves every instance on the machine and nothing said which checkout it came from; and two rounds of findings from the interface and parallel-fix pull requests had nowhere to live |
| #57 | 🟩 merged | Nine defects the running product showed and no suite did: shortcut labels read `navigator` while rendering, so hydration disagreed with the server pass; a prompt's tooltip carried the raw ISO instant, a machine string in UTC that the prop's own documentation called "currently unused visually" (the fix formats it as local wall-clock time, client-side, so hydration still matches); a picker trigger ran under the control beside it; the branch picker auto-selected the first entry of a listing GitHub returns alphabetically, so an `agent/…` branch was silently pinned into new chats and schedules; the composer sent only on ⌘Enter; the drawer painted its close button over the sidebar's own header control; and two dialogs told the operator to run `pnpm doctor`, which reaches pnpm's built-in command and exits 0 whatever this environment is in |
| #59 | 🟩 merged | A reloaded chat showed only prompts and prose. The mapper emitted a turn's tool calls only under a user message carrying that turn's id, and the API writes the user message before the turn row exists, so the condition could never hold; the push notice and the cancellation line were not reconstructed at all |
| #60 | 🟩 merged | Four routed findings at once — R13, R28, R12 and half of R10. A connection URL's password was redacted by nothing; `env.sh --print-effective` trusted an incomplete file and let the first consumer die on `MASTER_KEY_PATH: unbound variable`; `loadConfig` and `env.sh` disagreed about whether the environment may overrule a derived port, which turned out to be intentional and is now stated and pinned; and the runner port gained `imageExists` so an image check need not create a container |
| #61 | 🟩 merged | The two real-mode end-to-end failures, diagnosed rather than adjusted away. Only `run_shell` streamed, so the other three tools reached the model and nothing else — a row said "no output" beside a byte count that contradicted it. And the scripted double omitted arguments that strict function calling requires, so four calls were refused before they ran: `FAILED` in one to two milliseconds with no exit code, which is why a `sleep 60` left no window for a Stop button |
| #63 | 🟩 merged | The sidebar rail was a one-way door — narrowing below 1024 px collapsed the column and nothing on screen brought it back — and at rail width the footer painted the theme toggle outside the sidebar's own right border |
| #64 | 🟩 merged | The run drawer's "Copy run id" button sat **inside** the sheet close button's box: measured in Chrome at 1280 px, Copy's centre point (1250, 37) lay within the close button, so a click aimed at Copy closed the drawer. One of the three collisions R43 names — R43 itself stays open, because it is about no check in this repository being able to see any of them |
| #62 | 🟩 merged | Retrying a failed turn posted its prompt a second time. Measured on `chat-failed`: one persisted `USER` row before, two after, with a second `Turn` row beside it — the duplicate was in the database, so hiding it in the interface would have made the screen disagree with the record on every reload |

Legend: 📋 ToDo · 🟦 running (branch) · 🟨 PR open · 🟩 merged · 🟥 blocked / held · 🟡 deferred by decision (in the plan, scheduled later — not blocked). The same six symbols are used by [docs/tasks/README.md](tasks/README.md) and by each lane file's own header, and no lane may carry a different one in two places.

**Open pull requests are not inventoried here.** `gh pr list --state open` answers that, and the answer
changes faster than a page can be written — it changed four times while this section was being corrected.
One open pull request is named below, and only because it moves rows of §14, which a reader counting open
findings has to know is coming:

| PR | Status | The defect |
|---|---|---|
| #56 | 🟨 PR open | The persistence port offers only unconditional writes, so no workspace or run transition can be arbitrated — the missing primitive R16, R21, R22 and R26 all name. As its branch stands, `WorkspaceRepository.claimStatus(id, from, to)` carries the expected status in the `WHERE` of the update and answers `null` when no row matched, which closes R16, leaves the other three open and adds R39, R40 and R41. **The branch is in rework** — a review challenged the `BUSY` arm of its boot recovery — so read it there rather than treating any of that as settled |

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
| W2-A | 6 | — | 6 |
| W2-B | 6 | — | 6 |
| W2-C | 6 | — | 6 |
| W3-A | 0 | — | 6 |
| W3-B | 5 | — | 5 |
| W4-A | 0 | — | 4 |
| W4-B | 0 | — | 4 |
| **Total** | **80** | **—** | **94** |

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
too cross-cutting to fold into the lane that found them. **Every OPEN row names exactly one lane**, never a
role and never a choice between two — a closed row names what closed it instead — an owner a reader has to resolve is how an item gets dropped,
which is the failure this section exists to prevent.
Nothing here is silently dropped: an item that ships unfixed becomes a README "Known gaps" entry
stating the residual risk in plain terms. **A closed row is marked, never deleted** — three rows
(R7, R14, R19) were removed on closure before this was written down, which made a reader of this
section unable to tell a finding that closed from one that never existed; they are restored in the table that follows.
These ids are **not** the risk ids of `docs/spec/01-overview.md` §8, which also run from R1: a
reference to "R7" has to name which table it means.

A row can also close as a **decision**: the finding was real, it was measured, and the answer was that the
behaviour is intended. R12 and R48 are the two. Their Owner column begins with 🟩 like any other closed row,
so they do not count as open, and it names the pull request whose reasoning settled it — the point of
keeping them is that the next reader does not close a symptom by undoing a choice nobody told them was one.

The ids run to R50 with **R39, R40 and R41 missing from this table and not free**: they are allocated on
the branch of the open PR #56 and arrive here when it merges. As that branch stands it also closes R16 and
rewrites R21, R22 and R26, so the counts here move the day it lands — and it is being reworked, so what
arrives may not be what is on it today. Nothing was deleted at those ids.

| # | Finding | Why it was not fixed in place | Owner |
|---|---|---|---|
| R1 | A task's `run_shell` can read the forge token through `AH_GIT_TOKEN_FILE` and send it anywhere the container can reach. Credential mediation via `GIT_ASKPASS` stops the token appearing in a remote URL or in `git` output; it does not stop code that deliberately reads the file. | The obvious mitigation does not work as stated: a second uid that cannot read the token file also stops `askpass.sh` authenticating, because Git runs it as a child of the agent process and it reads that same file. Any real fix has to keep the helper's access while denying the task's — a setuid or setgid helper, a credential daemon on a socket the task cannot reach, or moving mediation out of the container entirely — together with an egress policy. That is a change to the container's process model, not a patch. | W3-A |
| R2 | The BullMQ scheduler keeps every completed repeatable job. At one job every five minutes that is 288 records a day, growing without bound in Redis. | Retention belongs with the processors that create the jobs, not with the scheduling contract. | W3-A — rerouted: W2-B merged in PR #22, and a finding whose owner is a closed lane has no executor, which is the failure this section exists to prevent |
| R3 | `JobRun.workspaceId` is not constrained to workspace-kind identifiers. Both the in-memory double and the Prisma repository must change together for the invariant to mean anything. | Split across two lanes it would be half-enforced, which is worse than not claiming it. | W3-A |
| R4 | Vitest resolves `@agent-hangar/core/testing` through the production condition rather than the source. It passes only because the built output happens to be present. | Needs the `development`-condition contract test extended rather than a local workaround. | 🟩 closed by PR #46 — the premise did not reproduce (measured with no `dist`, and again with a poisoned `dist` whose entry points throw). The real gap was that nothing verified it: the check read manifest text, which passes identically either way. It now compares module identity against the source barrel |
| R5 | `packages/core/fixtures/openai/recorded-*.ndjson` is not ignored. A recorded fixture carries whatever the live API returned. | Belongs with the fixture-recording story rather than an unrelated diff. | 🟩 closed by PR #46 — `.gitignore` matches `packages/core/fixtures/openai/recorded-*.ndjson`; the committed synthetic fixtures stay tracked |
| R6 | No continuous-integration job declares `timeout-minutes`. A hung job holds a runner for the platform default of six hours. | Infrastructure hygiene, not a lane deliverable. | 🟩 closed by PR #46 — all seven jobs declare `timeout-minutes`, sized from 34 observed runs |
| R8 | Four contract values are **mirrored** in `apps/worker/src` rather than imported — `TURN_EVENT_FIELD` in `events.ts`, the heartbeat key, timings and schema in `heartbeat.ts`, and the scheduled-delivery payload in `processors/run-scheduled-job.ts`. Each is byte-identical to the definition in `packages/core/src/queues/contracts.ts` today. | They live on the web API lane's branch, which the worker lane may not touch. Two copies of a constant diverge silently and both sides stay green — this must become a one-line import each the moment that branch merges. | W3-A — rerouted. #21 merged and no follow-up was ever opened, so the routing named an event rather than an owner. Still live: `TURN_EVENT_FIELD` is declared in both `apps/worker/src/events.ts:39` and `packages/core/src/queues/contracts.ts:148` |
| R9 | The same-origin guard compares `Origin` against `Host`, which DNS rebinding defeats. Closing it needs a Host allow-list. | A deployment decision, not a code one: the app binds to loopback, and an allow-list would refuse any proxy an operator fronts it with. Documented in `same-origin.ts`. | W3-A |
| R10 | `WorkspaceRunner` exposes no `imageExists`, so the boot check and the health card report what the last `create` observed — accurate once anything has run, optimistic before that. | Not the one-file change it looks like: `DockerWorkspaceRunner` and `FakeWorkspaceRunner` both declare that they implement `WorkspaceRunner`, so adding a method to the port breaks both until each implements it — the port, the real runner and the double must land together. | W3-A — **half closed by PR #60**: `WorkspaceRunner` now declares `imageExists` and both the Docker runner and the fake implement it, which was the part that had to land together. It stays open because the two consumers were deliberately left behind — the worker's boot probe (`apps/worker/src/app.ts`, `probeRunnerReachable`) still ignores the image it is handed and the heartbeat still publishes `imagePresent` from the remembered value, so the health card is still optimistic on a fresh checkout. That probe's own header now asserts "the `WorkspaceRunner` port exposes no image lookup" and "a contract change request asks the Docker runner for an `imageExists`", both of which stopped being true in the same pull request — the R15 shape, in a new place |
| R13 | A driver error reaching the 5xx log carries the Postgres password. The pino serializer runs the redactor over message and stack, which covers both credentials this repository's rule names — the forge token is now registered by exact value, and the model key never enters the web process — but the database password is neither registered nor shape-matched, so a connection-failure message can put it in a log. | The redaction policy lives in `packages/core/src/redaction`, which is frozen, and the password is not one of the two secrets the stated rule protects. Widening what counts as a secret is a policy decision, not a lane fix. | 🟩 closed by PR #60 — the process-side redactor now treats the password in a URL's userinfo as a credential by shape, so it needs no registration and covers every process. The match is bounded by the authority and is greedy to the last at-sign, which is the WHATWG parser's own rule for where userinfo ends; a password carrying whitespace or a bare quote is still left to registration at boot, and the code says so |
| R15 | Three worker file headers assert that only an unreachable Docker daemon rejects and that BullMQ therefore retries the turn. Measured against the installed library and the queue construction, nothing retries: `attempts` defaults to 0, `enqueueRunTurn` sets none, `createQueue` declares no default job options, and the only redelivery configured is stalled recovery for jobs whose lock lapsed. Either those comments are wrong or the queue options are. | Adding `attempts` and `backoff` belongs in `packages/core/src/queues/queues.ts`, which is frozen. Until it lands, a transport error must stay terminal — leaving the turn non-terminal would strand it with no event on its stream, which is a worse defect than the one it would fix. | W3-A |
| R16 | The workspace claim that serialises the turn processor against the idle collector is process-local, because `WorkspaceRepository` exposes only an unconditional `setStatus` with no conditional update to build a real claim from. It matches today's deployment — one worker process per instance — and says so in its own header. | A `claim(id, expectedStatus, nextStatus)` returning null when the row moved is the honest home for this, and it lives in frozen persistence code. Needed before a second worker process is ever run. | 🟩 closed by PR #56 — `WorkspaceRepository.claimStatus(id, from, to, update?)` carries the expected status in the `WHERE` of the update itself and answers `null` when no row matched, so Postgres arbitrates rather than a process. Every write that commits a writer to a workspace uses it: the turn taking it `BUSY`, the teardown moving it to `STOPPING`, and the reconciler closing out a row whose container is gone. Each names a status nobody owns rather than the status it read — `READY` for the first two — because `BUSY -> STOPPING` and `STOPPING -> STOPPING` are both moves the database would accept, so a claim quoting what it found would be granted over a row that already has an owner. Measured: removing the status from that `WHERE` makes two concurrent callers both win against a real database. The in-process register survives as an optimisation — it spares a worker preparing work it is about to lose — and as the turn-redelivery guard, which no row status can express. Refusing to take a row that is not `READY` removed the unsafe recovery the old unconditional write provided, so boot now closes out what a dead incarnation left half-torn-down; the residual of that is R39 |
| R12 | `packages/core`'s `loadConfig()` still treats the instance-derived ports as defaults, so an explicit `POSTGRES_PORT` in the process environment wins there. `env.sh` is now stricter than the library it mirrors. In practice everything loads from `.env.local`, which `env.sh` writes with derived values, so the two agree today. | Making the identity block non-overridable lives in `packages/core/src/config/schema.ts`, which is frozen and belongs to no open lane. | 🟩 closed by PR #60 — resolved as intended behaviour rather than changed. The script derives an environment and the library reads one somebody else composed, so it cannot tell a derived deployment from one addressing a database elsewhere; this repository's own integration job is that case (instance `test` against Postgres on 5432, which no derivation produces), so sealing the block would refuse it. The reason is now stated where the code is read and both halves are pinned by tests — reversing the merge order fails five |
| R17 | `pnpm test` is `pnpm -r --if-present test && vitest run --project scripts`. The `&&` means a failure in any workspace stops the run, so the scripts suite never executes — a flake elsewhere silently voids it, and the job reports the earlier failure rather than "these tests did not run". Observed: a timing-dependent web test failed, the scripts suite was never reached, and the tests that mattered to the change under review were never executed. | Restructuring the root test script and how continuous integration reports per-workspace results is repository-wide tooling, not a lane deliverable. | 🟩 closed by PR #46 — `scripts/run-tests.sh` runs every workspace suite and then the scripts project unconditionally, reporting per group and still exiting non-zero if any failed |
| R18 | `tsc -b && <rewrite>` short-circuits, so a failing typecheck emits a partial output and skips the rewrite. Worse, a **successful** typecheck also emits without rewriting when it is the root `tsc -b` rather than the package build, which then fails that package's own guard test on the very next test run — a failure nobody introduced. Accepted as unlikely when the chain was written; observed independently twice within the hour, once from a tree with no generated database client and once from an ordinary typecheck-then-test sequence. The working order is typecheck, then build the shared package, then tests. | Preserving the compiler's exit code while always rewriting needs exit-code handling in four manifests. The cheaper answers are making the prerequisite explicit so the compile does not fail that way, and making the gate order not matter. | 🟩 closed by PR #46 — no manifest may name `tsc -b`; `scripts/tsc-build.sh` always rewrites and still exits with the compiler status, and a guard makes the short-circuit unrepresentable |
| R20 | The ownership map gives a lane its source directory, but a package manifest's scripts block now has two authors: the lane, and repository-wide infrastructure work that must chain a build step from every script reaching the shared package. Nothing states who wins, so a rebase resolved mechanically can drop one side without complaining — the collision was found only because a lane stopped and read it. | The map needs a rule for shared manifests, not a fix to either change. Measured today: of the branches in flight exactly one is affected, so the rule is cheap to write now and expensive later. | 🟩 closed by PR #37 — `docs/AUTOPILOT.md` now states that the cross-cutting change is the base and the lane's change is reapplied on top |
| R21 | Deleting a scheduled job is not serialised with editing it. After the scheduler is removed, a concurrent edit can rewrite the row and recreate the scheduler; the delete then removes the row, leaving a scheduler firing on its cron for a job that no longer exists. | Bounded in two ways, both measured rather than assumed. A delivery naming a missing job is failed with an explicit reason and a terminal event, so the orphan produces reporting failures and not corruption. And the worker's scheduler reconciliation removes schedulers with no matching enabled job — but only at worker startup, so the orphan fires on its cron until the next restart. Closing it properly needs the conditional or versioned write the persistence port does not offer. **The shape now exists and is proven**: PR #56 added `WorkspaceRepository.claimStatus` and pinned it against Postgres. What remains is the same conditional write on `ScheduledJobRepository` and the two handlers that would use it, `apps/web/src/server/handlers/jobs.ts` — untouched by that PR because `apps/web` was occupied by another change in flight. | W3-A |
| R22 | Deleting a chat has the same check-then-write shape: its live-turn check precedes the delete, so a concurrent message can claim a turn the cascade then removes. Found by the lane while fixing the sibling race in the archive path, and deliberately not folded into that round. | Not corrupting — the chat and everything under it are gone either way, and the losing request fails with an error and logs the release it could not perform. It shares R21's root cause and should be fixed with it rather than separately. **The shape now exists and is proven** (PR #56, on `WorkspaceRepository`); what remains is the same conditional write on `ChatRepository` and the delete handler in `apps/web/src/server/handlers/chats.ts`, which that PR did not touch. | W3-A |
| R23 | The turn processor refines its stalled-workspace recovery on the delivery attempt count. That field never moves for a job rescued from a dead worker: the library's stalled-recovery script increments a separate stalled counter and never touches the attempt count, and nothing here configures retry attempts. The refinement is therefore dead code. | Not a defect today — the recovery's other arm, a workspace left busy, is what actually catches an abandoned turn, so the behaviour is right for the wrong reason. It becomes one the moment someone relies on the attempt count or removes the other arm. Found while fixing the same mistake in the sibling processor, where it *was* load-bearing and would have shipped a guard that silently preserved the defect it was written to fix. | W3-A |
| R11 | The presence check that greps route files for `assertSameOrigin` reports every route as covered **by construction**, because the guard lives in the handler behind a thin wiring module. It cannot fail. | Replaced by `apps/web/app/api/same-origin-policy.test.ts`, which calls every state-changing export from a foreign origin and names the offending route when the guard is removed. The grep must be retired from the lane prompts so it is not reintroduced. | 🟩 closed by PR #37 — the invariant-greps section now checks for that test file instead, naming it as the only check that can fail when a route loses the guard |
| R24 | The credential helper and the repository allow-list no longer agree, and nothing forwards the agreement. `askpass.sh` falls back to `github.com` because `AH_GIT_ALLOWED_HOST` is set by nothing: the container env is a fixed set in `provision-workspace.ts` that does not include it. So an operator who lists any other origin in `ALLOWED_REPO_HOSTS` gets a URL the API accepts, a clone that runs, and a helper that refuses to release the token — private repositories on that origin cannot be cloned at all. The port half is the same split: the helper rejects any explicit port unconditionally, while the schema now authorises ported origins by whole-origin equality, and the comment justifying the rejection still claims the schema refuses them. | Fail-closed, so it leaks nothing — but the allow-list is half-implemented and the helper asserts a coupling that does not exist. The fix is not to hand the helper the allow-list, which would release the token to any listed origin a crafted prompt names; it is to bind `AH_GIT_ALLOWED_HOST` to the single origin of the repository this workspace is cloning, already validated against the list by `refuseDisallowedRepo` one call earlier. That is strictly narrower than today for `github.com` and correct for everything else. Touches the worker env construction, which is occupied by another change in flight. | superseded by R25, which found the same split in a third place and is being fixed as one |
| R25 | `ALLOWED_REPO_HOSTS` is enforced in one of the three places that apply it. The API validates against it; `infra/workspace/askpass.sh` reads `AH_GIT_ALLOWED_HOST`, which nothing sets, and falls back to `github.com`; `packages/agent-runtime/src/prepare.ts` hard-codes the host and the scheme, and the override seam that exists is never fed. Measured end to end: every turn fails at prepare for a repository the API accepted and the worker cloned. | Fail-closed, so nothing leaks, but the allow-list is two-thirds decorative and real mode cannot complete a turn on any origin. The fix is not to hand the container the allow-list — the helper releases the token based on a host it parses out of a prompt string, so a set of acceptable hosts is a set a crafted prompt can name. It is to bind both enforcement points to the single origin of the repository the workspace was created for, already validated one call earlier. Strictly narrower than today even for `github.com`. Subsumes R24. | 🟩 closed by PR #44 — the policy is a root-owned file placed between container create and start, so the model cannot set it inline; the helper and the runtime read the same file, and a third exfiltration path (the authority ending at `?`, `#` or `\`) was found and closed with it |
| R26 | A cancellation accepted by the API can still be recorded as `FAILED`. `watch.requested()` is a snapshot: the check and the terminal write are two awaits apart, and a Stop landing in that gap is seen by the cancel route as a non-terminal run, so it answers 202 and publishes while the worker has already committed to the failure. Both processors have it. | The fourth instance of one missing primitive, not a fourth defect. The persistence port exposes only an unconditional `finish`, so no transition can be arbitrated — the same gap behind R16, R21 and R22, and it should be fixed with them rather than separately. PR #40 narrows the window from the whole branch to the interval between one flag read and the write after it; the residual is bounded, because a run that loses the race is still recorded with a terminal event on its stream, so the outcome is wrong rather than absent, and every path that executes re-consults the watch. **The shape now exists and is proven** (PR #56, on `WorkspaceRepository`). What remains is more than adding it to `TurnRepository`/`JobRunRepository`: the flag read has to stop being the decision. The cancel route would have to take the run terminal itself, conditionally on the status it read, and answer `202` only when that write landed; the worker's `finish` would have to be conditional on the run still being non-terminal, so whichever of them writes first is the record and the other re-reads. Both halves live in `apps/web/app/api` and `apps/worker`, and the web half was occupied by another change in flight. | W3-A |
| R27 | A terminal run status does not mean the worker has finished with the run. Both processors persist the outcome inside the `try` and tear the workspace down in the `finally` — container destroy, workspace `DESTROYED`, run times — so anything that waits on status and then deletes races the teardown it cannot see. Found by the end-to-end lane, whose reset does exactly that. | Needs an observable signal that does not exist: `healthResponse` carries no live-workspace count, and the lane cannot invent one because the contract is another lane's path. Harmless in the mocked suite, which is what continuous integration runs; it bites the moment real mode is switched on, which is this lane's own job. | W3-A |
| R28 | `pnpm setup` fails with `MASTER_KEY_PATH: unbound variable` when `.env.local` exists but is incomplete. `env.sh --print-effective` trusts an existing file and echoes it verbatim without re-deriving, and `setup.sh` then dereferences a key that file never carried, under `set -u`. Observed on a checkout whose file held 5 of the 17 keys, with the missing one present only as a comment. | Fail-closed but unreadable: the first missing key becomes a shell error on a line that explains nothing, and the file that caused it is not named. The honest fix is for the scripts that consume the file to check it against the key list they already declare and name what is missing — or to fill in the derived ones — rather than assuming any existing file is complete. | 🟩 closed by PR #60 — `env.sh --print-effective` checks an existing file against the key list it already declares and refuses with exit 4, naming every key it lacks; a key present only as a comment or recorded empty counts as missing. `setup.sh` now captures the environment before evaluating it, because `eval "$(cmd)"` reports the status of `eval` and would have discarded the refusal |
| R29 | The workspace image tag is machine-global. `WORKSPACE_IMAGE` derives to `agent-hangar/workspace:dev` for every instance, so `pnpm infra:image` in one checkout retargets the tag every other checkout resolves **when it creates a workspace container**. Containers that already exist are unaffected — they are bound to the image ID they were created from — so the boundary is container creation, not the rebuild itself. Measured: a lane's end-to-end run was rebuilt out from under it one minute in, and the failure it recorded described a combination of worker and runtime that existed in no tree. | Not a defect of any lane, and it invalidates measurements silently rather than loudly — the run does not fail, it reports something untrue. The tag should carry the instance the way the compose project, database and container prefix already do, so a rebuild in one checkout cannot decide what another checkout's next container runs. Affects an operator testing by hand for the same reason. **And that is only half of it:** an image also silently lags its own checkout. `pnpm infra:image` rebuilds the bundle and copies it, but nothing checks that the bundle matches the tree, and when it does not the Docker layer cache turns the whole build into a no-op that reports success. Observed three separate times on 2026-08-20 — a build that ran a minute before the source it should have carried arrived; a lane's measurement that executed another lane's runtime; and an operator hitting a defect fixed and merged an hour earlier. Every time the error named the code rather than the image. The remedy has to identify the bundle by **what it is**, not by when it was built: a digest over the bundle's own bytes, or over the inputs that produced it, carried into the image and compared by the worker against the same digest recomputed from the tree it was started from. A commit stamp is **not** enough and would be worse than nothing — a rebuild that consumes stale generated output stamps the current `HEAD` onto stale bytes, which is exactly incident one above, and uncommitted source changes share a commit id with the code they differ from. Either way the worker would accept the very image this row is about while reporting it verified. A command that succeeds without doing anything is worse than one that fails; a check that passes without checking is worse than both. | W3-A |
| R30 | The end-to-end harness writes `state.json`, `master.key` and `worker.log` to a fixed `apps/web/e2e/.tmp`, not under the instance. Two runs on different port bases share those files, so the isolation `instanceForPortBase` provides for ports does not extend to the harness's own state. | Bounded today because the suite is not run concurrently with itself, and the lane that found it does not own the answer for where instance-scoped scratch state belongs. | W3-A |
| R7 | `healthResponse` required `ports`, so any health fixture or mock handler without it failed response parsing. | Restored to this table rather than left deleted. | 🟩 closed by PR #21 — the fixture and the mock handler carry `ports`; the row had been removed from this section instead of marked, which is the traceability gap the preamble below now names |
| R14 | `GITHUB_API_BASE_URL` and `ALLOWED_REPO_HOSTS` promised a configurable forge while the shared `repoUrl` schema accepted only `https://github.com/...`, so a self-hosted repository appeared in the picker and then failed with a 400 the user could not act on. | Restored to this table rather than left deleted. | 🟩 closed by PR #34, and again by PR #44 which carried the policy into the container and the credential helper. It shipped with a residual — only a GitHub-compatible API is *discoverable* — which is the README "Known gaps" entry that still cites this id |
| R19 | `postMessage` bumped the chat's ordering timestamp after the turn was dispatched, and that last write was unguarded: its failure answered 500 for a turn the worker already held, and a caller who retried met its own turn reported as already in progress. | Restored to this table rather than left deleted. | 🟩 closed by PR #29's follow-up work; the row had been removed from this section instead of marked |
| R31 | The repository picker gave no sign which repositories the agent cannot push to, or cannot work from at all for want of a branch, and the composer's Send button went dead without naming which of three requirements was missing. Fixed in PR #47 — recorded here because it is **scope beyond spec 10**, which §1 says the build does not take. | Accepted deliberately: both were found by the operator using the running system, and both are failures of the product to explain itself rather than features. Recorded so the scope decision is visible instead of implicit. | 🟩 closed by PR #47 |
| R32 | The divergence warning `switchToWorkBranch` emits reaches nobody durably. `prepare.progress` is upserted under one notice id and `prepare.done` replaces it with the success line, and `runTurnLoop` is never handed the note — so a workspace whose work branch diverged from the remote tells neither the user nor the model. | PR #53 chose to land on the local branch and warn rather than merge or refuse, and defended that on the user being told and the agent being able to reconcile. Neither holds while the note is transient, so the reasoning is weaker than the code claims — though still far better than what it replaced, which discarded the local commits silently and failed every second turn of a chat. Making it durable needs a persistent transcript item and a line in the model's context, in two paths that change belongs to neither. | W3-A |
| R33 | `chat-create-run` asserts which tools a turn called and never their status, so the spec passes while a tool call inside it fails. The lane found it and left it: adding the assertion would correctly turn the spec red against a defect outside its own paths. | The same shape this project has closed twice — a check that cannot fail. It is one line, and it should land together with whatever explains the failing tool call, not before it. | 🟩 closed by PR #61 — `chat-create-run` now asserts the status, the exit code and the recorded output of each call, not only which tools ran, and the scripted loader validates every scripted call against the tools' argument shapes so a script the runtime would refuse fails where it can be read |
| R34 | Measured in a real-stack run: `list_dir` and `run_shell` were recorded `FAILED` in 1–2 ms with no exit code and no output in a **chat** workspace, while the same `run_shell` executed and returned output in a **job** workspace. Reproduced twice against one image; not re-confirmed after PR #52, because the per-test reset clears the rows and an isolated re-run raced a stopped worker. An operator's real-model turn on the same day recorded `list_dir` and `read_file` at exit 0, so the argument shape differs between the two observations and is the first thing to check. | Reported with its confidence stated rather than folded into a spec fix. If real, it is the cause of the `cancel-turn` failure: a `sleep 60` that fails in 2 ms leaves no window in which a Stop button can exist. | 🟩 closed by PR #61 — cause found and fixed, and it was neither the image nor the workspace kind. Providers are asked for strict function calling, which requires every property to be present; the scripted double omitted them, so `list_dir`, `read_file` and both `run_shell` calls were rejected by argument validation before the tool ran — `FAILED` in one to two milliseconds with no exit code. It went undiagnosed because the rejection text never reached a row: only `run_shell` used the streaming hook, so the other tools' output was never carried into the event stream. Both halves landed together. **Not re-confirmed by a real-mode run** — see the W2-C row |
| R35 | The `chat-archive-restore` end-to-end check waits for a notice matching `/restored/i`. The mocked double writes "This chat was restored…"; the product's normative notice is `Workspace recreated from history at …` and is written when the next turn recreates the workspace. Wording and timing both differ, so the assertion tracks the double rather than the product. | The mock and the spec have to move together and the mock is another lane's file, so the lane that found it could not close it alone. It is the second of the two real-mode failures; the first is R34. | 🟩 closed by PR #61 — the mock now builds the notice from the same shared helper the restore route uses, with the chat's own work branch, and the spec matches the product's normative `Workspace recreated from history at …` opening. The tool-row baseline is waited for by name rather than sampled, because rows arrive on the event stream after the API has already reported the turn `SUCCEEDED` and a count taken there could be zero — which would have turned the comparison into another check that cannot fail |
| R36 | `apps/web/src/mocks/repos.ts` reorders its branch listing to put the repository's default first; the real adapter returns the forge's order unchanged. Every test of the branch pickers therefore ran against a double that could not reproduce the defect they were written to catch — a job silently inherited an agent work branch because the listing is alphabetical and `agent/…` sorts before `main`. Found while fixing that defect in PR #57. | The fix landed without touching the mock, and its regression tests state the forge's real ordering explicitly instead. Making the double match the forge is the real repair and is a better test bed for everything else that reads a listing, but the file belongs to the interface lane and moving it changes that lane's own mock tests. | W3-A |
| R37 | `docs/spec/10-ui-design.md` still lists ⌘Enter as the send binding and `docs/tasks/wave-1g-web-chats.md` still prescribes the `Send (⌘↵)` tooltip. PR #57 made Enter send, Shift+Enter insert a newline and ⌘/Ctrl+Enter keep working, so both are now wrong. | Documentation is another lane's owned path and the change that superseded them could not edit it. Small, but a specification that contradicts the shipped product is how the next reader reintroduces the old behaviour. | W3-A |
| R38 | Two layout defects fixed in PR #57 — a picker overrunning its grid cell, and the mobile drawer stacking its search control on the close button — are pinned only by the classes that produce the containment, because jsdom has no layout engine. The geometry was measured in a real browser and recorded in the pull request. | Stated rather than hidden: a regression that removes the class is caught, one that changes the surrounding CSS so the class no longer suffices is not. Closing it needs a layout-capable check, which is the end-to-end suite's territory rather than a unit test's. | W3-A |
| R39 | A workspace left `STOPPING` by a teardown whose process died — a crash, or a job abandoned past the shutdown grace period — is recovered only at worker boot. Nothing in the steady state can do it: a teardown refuses any row that is not `READY`, the idle selection refuses it for the same reason, and the reconciliation refuses it because its container is still running, so it is not gone. **The pass covers `STOPPING` and nothing else, and the reason is worth stating because it briefly covered more.** A `BUSY` arm was added for a scheduled run that died before recording its workspace, and withdrawn after Copilot pointed out that this row's safety argument does not transfer to it: a `STOPPING` row's owner has committed to destroying its container, so a second worker closing it out agrees with it, whereas a `BUSY` row's owner has committed to the opposite — it is executing inside that container. Measured under two workers of one instance: the booting worker closed the row out and the next reconciliation destroyed the container with a live exec in it, which is the cross-process race the conditional writes exist to remove. The leak that arm was added for is now answered by the stalled-run recovery instead, which a run gives a durable handle by recording its workspace before taking it. Boot works because this process holds no teardowns and an instance runs one worker, which makes such a row provably abandoned rather than merely slow. Age cannot make that distinction — the two rows are identical — and this project has already been bitten by treating age as ownership, in the port-base allocator, where a marker old enough to look abandoned belonged to a live watch session. | The general answer is a lease the owner renews: a column on `Workspace`, a renewal while the teardown runs, and an expiry the recovery reads. That is a schema migration plus a renewal loop plus its own failure modes, and it is more than the change that found this should carry. Bounded meanwhile, and measured rather than assumed: recovery runs on the next boot, which is exactly when a crashed worker comes back; the container is destroyed by the orphan pass rather than by the recovery, so the recovery needs only the database — a claim that was false until the boot steps were ordered by what they depend on, because the runner probe ahead of it rejects on an unreachable daemon by deliberate design and took the whole boot with it, and which is now asserted through `prepareBoot` rather than against the recovery alone, since a test calling it directly would pass either way; and a second worker per instance would at worst close out a row the first is mid-destroy on, whose outcome is a row reading `FAILED` instead of `DESTROYED` and a container the orphan pass removes — never a turn killed mid-exec, because a `STOPPING` row's owner has already committed to destroying its container. That last clause is what limits the pass to `STOPPING`: it is the safety argument, not a remark about it, and any status added here has to have one of its own. | W3-A |
| R40 | `apps/worker/src/processors/run-scheduled-job.ts` keeps reaching the 800-line review cap, three times in one branch, and each time the answer was to move something that was already in the wrong place: the scheduled-run failure codes to `processors/constants.ts` (beside `STALLED_RUN_REASON`, the `Workspace.failureReason` half of the same event), the acquisition argument to `processors/provision-workspace.ts`, and `failRun`/`cancelRun` to `processors/run-outcome.ts`, whose own header already described them as "what a chat turn and a scheduled run do identically when they end". It is at 774 now, so it has headroom — but the cap kept being the thing that found these, which is a structural signal rather than three coincidences. | The seam is already named by the repository itself: the file has two test files, `run-scheduled-job.test.ts` for the run lifecycle and `run-scheduled-job-deliveries.test.ts` for which run a delivery is entitled to drive, and the second names a coherent set — `IneligibleRunError`, `recordSkippedTick`, `closeUnrunnableRun`, `destroyAbandonedWorkspace`, `recoverAbandonedRun`, `resolveRunningRun`, `openRun`. Splitting along it is a ~180-line move that shares `failRun`, so it needs its own change and its own review rather than riding along with a race fix, where it would make the fix harder to read — which is the opposite of what the cap is for. | W3-A |
| R41 | `whenWorkspaceIsBusy` in `apps/worker/src/testing/turn-fixtures.ts` resolves when a workspace is written `BUSY`, and its own comment says that once it settles "the first processor owns a container and is inside its exec". Those are not the same moment: everything between the status write and the `exec` call is microtasks, so a test that awaits it and then asserts on `exec` passes only by ordering. Measured — routing the chat path's take through one extra `async` function, a change with no behavioural difference, flipped `run-turn.test.ts` "leaves the running turn alone when its own job is redelivered" from green to `expected [] to have a length of 1`. | Not a defect in shipped code, and the fixture is used by several suites, so making it mean what it says — resolving when the runner is asked to exec — is a change to a shared double whose timing other tests also depend on. It was found while shrinking a file, not while testing the fixture, and it should be fixed deliberately rather than as a side effect. Until then the shared take is used by the scheduled path only and the chat path keeps its own copy of the one-line claim, which is the cost this row records. | W3-A |
| R42 | **A check that cannot fail, five times in one day.** `RunDrawer` asks for `sm:max-w-[720px]`; the sheet primitive's `data-[side=right]:sm:max-w-sm` is more specific and wins, so the drawer renders at 384 px — and its own test asserts the class is *present*, which is true and meaningless. The same shape appeared in the same-origin presence grep (R11), the end-to-end tool-status assertion (R33), the mock branch ordering (R36) and `shortcut-hydration.test.tsx`, whose console-sniffing assertion was measured to pass against deliberately broken code. | Each was found by a different agent looking at something else. The common property is a test that observes a proxy — a class, a console line, a name — instead of the outcome the code exists to produce. Worth a sweep as its own piece of work rather than five separate repairs, and worth stating as a rule the next author is held to. | W3-A |
| R43 | **No check in this repository sees** that one interactive control covers another, and none can be written where the unit suites live. Three collisions were found by eye this day — the sidebar search over the drawer close, the rail footer overflowing its own border, and the run drawer's Copy button sitting **inside** the sheet close button's box, where a click aimed at Copy closed the drawer. jsdom cannot express the assertion — every `getBoundingClientRect` is 0×0, so a check written there passes against broken code, which is R42's own failure mode. A real engine can express it, which is exactly why the remedy below is worth writing. | The assertion that would have caught all three without anyone knowing to look is one sentence — no interactive element's centre point is covered by a different element — and it belongs in the end-to-end suite, which owns a real engine. The browser driver used to measure these already implements it: it refused a covered click and named the covering element. | W3-A — the three collisions themselves have since been fixed (PRs #57, #63 and #64). The row stays open on its own terms: nothing in this repository would have caught any of the three, and the assertion that would have is still unwritten |
| R44 | A failed non-streaming tool call routes its output to stderr live, but a reloaded transcript renders that text on stdout, so the destructive border the live row carried is missing after a reload. | `ToolCallLog` stores one `resultHead` and not the stream that produced it — the recorder concatenates every delta into a single field — so a mapper cannot restore the split without copying a routing rule that lives in the runtime. Persisting the stream alongside the head is the clean fix and is a schema change; both mappers could then restore it exactly. | W3-A |
| R45 | `handlers/chats.ts` omits the message repository's optional fourth `turnId` argument in both `createChat` and `postMessage`, while every other role passes it. | Independent of the mapper repair, which had to work without it and does. Passing it is more correct on its own terms, and it repairs nothing already written — which is why the read side had to move first. | W3-A |
| R46 | A `JobRun` has no message channel, so a push or preparation notice inside a scheduled run cannot be persisted the way a chat's is. And `mapChatDetail` renders only the newest turn's error, so an earlier failed turn loses its failure row on reload. | The first needs a schema change. The second needs a product decision rather than a line: rendering every turn's error would also surface the internal bookkeeping text a released claim writes. | W3-A |
| R47 | `packages/agent-runtime/src/loop.test.ts` is over the 800-line cap and carries 29 `it()` comments in the body rather than above the case — which is the convention of all 24 suites in that package. | Converting one file would make it the only suite in the package in a different style while leaving the same gap in twenty-three others, and would add roughly 45 lines to a file already over the cap. A package-wide convention pass, not something a defect fix should carry. | W3-A |
| R48 | **Not a defect — a decision, recorded because the symptom is reported as one.** The `Prepared agent/<branch> at <sha>` notice is the only transcript item that does not survive a reload: it renders live on every turn, naming the workspace branch and the commit the turn ran against, and a re-read chat does not have it, while the push notice and the cancellation notice do. It was reported as the class PR #59 fixed, for one event that fix missed. The code says otherwise. The notice is built in the live reducer from the streamed `prepare.done` event and is never persisted in any form, so the read path is not failing to join anything — the push notice survives because the worker writes a SYSTEM message row per push, and the cancellation notice survives because it is rebuilt from `Turn.status`. `makeTurnSink` in `apps/worker/src/processors/run-turn.ts` drops `prepare.progress` and `prepare.done` into a branch whose comment states the reasoning: they describe the container while it is being set up, the container does not outlive the turn, what the turn actually did is in its tool calls and its answer, and a stored SYSTEM message would cost the model a line of history on every turn. | Recorded here so that nobody closes it by undoing a choice nobody told them was one. **The decision has one observable cost and it is worth stating plainly**: a reader of a reloaded transcript cannot tell which workspace branch or which base commit a turn ran against, and that is the one fact in the prepare events that *does* outlive the container. If that ever has to be recoverable, the answer is a field on `Turn`, not a SYSTEM message — the history argument above does not apply to a column — and it is the same schema call R46 already asks for. Nobody has asked for it yet, so nothing is routed. | 🟩 decided, not a defect — PR #59, with its reasoning at the branch that drops the events |
| R49 | Reported as: a cancelled tool call loses its arguments, seen as `run_shell {}` after pressing Stop. **The report and its first correction are both wrong, each from a measurement that stopped short of the code, and the second one would have sent an author to rewrite a reducer branch that is fine.** Persistence is intact: the recorder writes `args` verbatim from the `tool.call` event, `run-shell.ts` appends `[cancelled]` to the collected output and records `FAILED`, and the read-path mapper renders `args: call.args` — so a reload shows complete arguments. The live reducer's `turn.cancelled` branch is intact too: it moves the phase, finalises a streaming assistant message and pushes a notice, and never touches a tool item. The empty row is fabricated in a third place — the `tool.result` branch of the same reducer, which on finding no open row for the `callId` invents one hardcoding `name: 'run_shell'` and `args: {}` instead of saying it does not know. It is reachable whenever a result reaches a client whose state never folded in the matching call: the turn event stream is trimmed at `TURN_EVENTS_MAXLEN` (5000), so a chatty long-running call plus a reconnect can deliver the result without its opening frame. Cancellation is simply when a long call's terminal event finally lands, which is why it was seen there. | The placeholder is deliberate and has its own passing test, so nothing in the suite disagrees with it — which is what let a row asserting two facts it does not have read as a real one to three separate observers. The repair is a row that carries the call id and states that the opening frame was not seen, plus a replay path that does not depend on the stream still holding a frame older than the resume point. Those are the transcript item and the event stream together, and no single lane owns both. | W3-A |
| R50 | **Observed and unconfirmed.** Reported as: Enter is swallowed in the chat composer. It was not reproduced, and the composer's own key handling was read and is correct — `Composer.tsx` sends on Enter, lets Shift+Enter insert a newline, keeps ⌘/Ctrl+Enter working and ignores Enter while an input method is composing a candidate, and all four are asserted against a real textarea in the suite. No other keydown listener in `apps/web/src` can take an unmodified Enter first: the shortcut hook requires the platform modifier, the stop hook reads only Escape, and the sidebar list handles only arrow keys. The one mechanism that would produce the symptom is a different thing entirely — `ChatBody` marks the composer disabled whenever the chat is archived **or** a turn is live, so while any turn is in flight the textarea carries the native `disabled` attribute and the browser dispatches no key events at all, and nothing beside the composer says why: the component's own stated reason for staying silent while locked accounts for the archived case only. Whether that is the state the report was made in is not established. | Recorded with its confidence stated rather than asserted or dropped, because the two candidates have different fixes and one of them is not a defect. Confirming it needs a reproduction that says which state the composer was in. Closing it is a product decision — either a locked composer explains itself, or one-turn-at-a-time stops disabling the field — and it reaches the specification as well: `docs/spec/10-ui-design.md` still lists `⌘Enter` as the send binding "shown in tooltips" while the shipped tooltip reads `Send (↵)`, which is R37's half and is certain. `ChatView.test.tsx` never exercises the composer during a live non-archived turn, so nothing in the suite would notice either answer changing. | W3-A |

Approved 2026-08-19. Per-lane task files with self-contained agent prompts live in [docs/tasks/](tasks/README.md).
