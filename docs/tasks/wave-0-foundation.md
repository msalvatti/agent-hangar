# Wave 0 — Foundation & frozen contracts

| | |
|---|---|
| **Lane** | W0 (single agent, sequential — critical path) |
| **Status** | 🟦 running |
| **Progress** | 6/8 tasks |
| **Branch** | `feat/w0-foundation` |
| **Owned paths** | everything (only lane in this wave) |
| **Depends on** | — |
| **Unblocks** | every Wave 1 lane (W1-A … W1-I) |
| **Source** | [docs/plan.md §5](../plan.md) · spec [01](../spec/01-overview.md) [02](../spec/02-data-model.md) [03](../spec/03-interfaces.md) [05](../spec/05-local-dev.md) [06](../spec/06-testing.md) [10](../spec/10-ui-design.md) |
| **Last updated** | 2026-08-19 |

## Context

The repository is empty (no commits). This lane creates the monorepo, installs the **complete** dependency manifest, and freezes every cross-lane contract (TypeScript types + Zod schemas, Prisma schema, repository ports, API/queue contracts, test doubles, design tokens, tooling, CI). When this PR merges, nine Wave 1 agents start in parallel and must not need to touch anything created here except by additive contract PRs.

Quality bar that applies to every file created here and in every later lane: TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), zero `any`, zero suppression comments, no `enum` in TS (string-literal unions; Prisma enums exist only in the schema and are mapped at the repository boundary), JSDoc on every export + file header, English only, test files with a header and a block comment on every `it()`, **100 % coverage on lines/branches/functions/statements** for every package's `src/**` that is in scope.

## Rules of this lane

1. Install **all** dependencies listed in T0.2 now; no later lane may add a dependency (lockfile-conflict rule from plan §3).
2. Contracts are copied from [spec 03](../spec/03-interfaces.md) with names unchanged. Where the spec shows a union with a `'started'` exec event "omitted for brevity", include it: `ExecEvent` gains `{ type: 'started'; execRef: string }`.
3. No `enum` keyword in TypeScript. Prisma enums are fine in `schema.prisma`.
4. Everything that crosses a process boundary has a Zod schema next to its type, and the type is **derived** from the schema (`z.infer`) so they cannot drift.
5. `packages/core` has zero imports from `next`, `react`, `bullmq` runtime (types only), or `dockerode` outside `src/runner/docker/**` (the dockerode folder is created empty here; W1-B fills it).
6. Vitest coverage thresholds are 100/100/100/100 in every package; `coverage.include` lists only the paths this lane implements (later lanes extend the list with their owned paths; W3-A widens to `src/**`).
7. Commit messages: Conventional Commits, English, no attribution trailers. Branch `feat/w0-foundation`. One PR at the end (T0.8).

## Reference docs

- [docs/plan.md](../plan.md) § "5. Wave 0", § "3. Parallelism rules", § "11. Orchestrator protocol"
- [spec 03 — Interface contracts](../spec/03-interfaces.md) (all sections)
- [spec 02 — Data model](../spec/02-data-model.md) § "2. Prisma schema draft", § "3. Invariants"
- [spec 05 — Local dev](../spec/05-local-dev.md) § "2. Repository layout", § "3. Environment model", § "5. docker-compose services"
- [spec 06 — Testing](../spec/06-testing.md) § "1. Layers", § "6. CI pipeline", § "7. Test doubles"
- [spec 10 — UI design](../spec/10-ui-design.md) § "2. Tokens", § "5. Components"

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 0.1 | Monorepo, TypeScript, lint/format, git hooks, CLAUDE.md | ✅ | P0 | M | — |
| 0.2 | Complete dependency manifest (all workspaces) | ✅ | P0 | S | 0.1 |
| 0.3 | Frozen core contracts: types, Zod, NDJSON codec, errors, config | ✅ | P0 | L | 0.2 |
| 0.4 | Test doubles and canaries (`packages/core/src/testing`) | ✅ | P0 | M | 0.3 |
| 0.5 | Prisma 7 schema, migration, client factory | ✅ | P0 | M | 0.2 |
| 0.6 | Infra skeleton: compose, workspace Dockerfile base, env.sh, scripts, .env.example | ✅ | P0 | M | 0.1 |
| 0.7 | Apps skeleton: Next.js shell with tokens + shadcn, worker boot, test configs | 📋 | P0 | L | 0.3, 0.5, 0.6 |
| 0.8 | CI workflow, README skeleton, plan dashboard, close-out PR | 📋 | P0 | S | 0.1–0.7 |

---

## Task 0.1 — Monorepo, TypeScript, lint/format, git hooks, CLAUDE.md

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** Create the pnpm-workspaces monorepo with strict TypeScript project references, ESLint flat config, Prettier, Husky + commitlint + lint-staged, and a `CLAUDE.md` that carries the ownership map and gates for every later agent.

**Acceptance criteria**
- [x] `pnpm install` succeeds on Node 24 with pnpm 11 (`packageManager` pinned)
- [x] `pnpm typecheck` runs `tsc -b` over all workspaces (empty packages compile)
- [x] `pnpm lint` runs ESLint flat config with import-x ordering, security plugin, `no-restricted-imports` (dockerode outside runner/docker; `crypto` → `node:crypto`; `uuid`/`nanoid` banned) and `no-restricted-syntax` banning `TSEnumDeclaration`
- [x] Husky `pre-commit` runs lint-staged (eslint --fix + prettier), `commit-msg` runs commitlint (conventional)
- [x] `CLAUDE.md` contains: project one-liner, stack with versions, ownership map (plan §6/§7 lanes → paths), the gates list, canary rule, "no deps added in lanes" rule, English-only rule, no-attribution rule
- [x] `.gitignore` ignores `.env*` (except `.env.example`), `master.key`, `coverage/`, `reports/`, `.next/`, `dist/`, `node_modules/`, `playwright-report/`, `test-results/`

**Files to create**
`package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.nvmrc`, `tsconfig.base.json`, `tsconfig.json` (solution file with references), `eslint.config.js`, `.prettierrc`, `.prettierignore`, `.editorconfig`, `.gitignore`, `.husky/pre-commit`, `.husky/commit-msg`, `commitlint.config.js`, `.lintstagedrc.json`, `CLAUDE.md`, `apps/web/package.json`, `apps/worker/package.json`, `packages/core/package.json`, `packages/agent-runtime/package.json` (all four with `tsconfig.json` extending base, empty `src/index.ts`).

**Agent prompt**

````
You are a senior full-stack TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — a local-first web app where AI agents answer questions and perform coding tasks against GitHub repositories inside isolated, disposable Docker workspaces; plus cron-scheduled jobs that run in fresh workspaces, and a settings page with encrypted credentials (GitHub PAT, OpenAI API key).
Stack: pnpm 11 workspaces · TypeScript ~6.0.3 strict · Node 24 LTS · Next.js 16.3 App Router + React 19.2 · Tailwind v4 + shadcn (Base UI) · Postgres 18 + Prisma 7.9 (adapter-pg) · Redis 8 + BullMQ 6 · dockerode 5 · openai SDK 7.5 · Vitest 4 · Playwright 1.62 · Stryker 10.
Specification lives in docs/spec/ (01–10); execution plan in docs/plan.md. You are in a git worktree on branch feat/w0-foundation.

CURRENT LANE: W0 (Foundation) — Task 0.1 of 8 (FIRST)

PRECONDITIONS
- Empty repository (no commits). docs/ exists and must not be modified in this task.

REQUIRED READING (only these):
- docs/plan.md § "3. Parallelism rules", § "5. Wave 0" items 1 and 9, § "6. Wave 1" (owned-paths lists only), § "7. Wave 2" (owned-paths only)
- docs/spec/05-local-dev.md § "2. Repository layout"

TASK
Create the monorepo skeleton and tooling so every later workspace compiles, lints, formats and commits under one strict configuration, and write CLAUDE.md so later agents know the rules without reading the plan.

DELIVERABLES

1. `package.json` (root): `"name": "agent-hangar"`, `"private": true`, `"packageManager": "pnpm@11.22.0"` (use the exact latest 11.x from `npm view pnpm version` if newer), `"engines": { "node": ">=24 <25" }`, scripts:
   `dev`, `build`, `start`, `lint` (`eslint .`), `lint:fix`, `format` (`prettier --write .`), `format:check`, `typecheck` (`tsc -b`), `test` (`pnpm -r --if-present test`), `test:integration`, `test:e2e`, `test:mutation`, `setup`, `doctor`, `infra:up`, `infra:down`, `infra:reset`, `infra:image`, `db:migrate`, `db:generate`, `db:studio`, `db:prune`, `ws:list`, `ws:reap`, `prepare` (`husky`). Scripts that later tasks/lanes implement may point at `infra/scripts/<name>.sh` paths that T0.6 creates — leave them wired now.
2. `pnpm-workspace.yaml`: `packages: ['apps/*', 'packages/*']`.
3. `.npmrc`: `engine-strict=true`, `auto-install-peers=true`, `shamefully-hoist=false`.
4. `.nvmrc`: `24`.
5. `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `forceConsistentCasingInFileNames`, `isolatedModules`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2023`, `lib: ["ES2023"]`, `skipLibCheck: true`, `declaration: true`, `composite: true`, `incremental: true`. Do NOT set `baseUrl` (removed in TS 7; keeps the upgrade path clean).
6. `tsconfig.json` (root solution): `files: []`, `references` to the four workspaces.
7. Workspace packages — create `apps/web`, `apps/worker`, `packages/core` (`@agent-hangar/core`), `packages/agent-runtime` (`@agent-hangar/agent-runtime`) each with `package.json` (`type: module`, `exports`, scripts `lint`, `typecheck`, `test`), `tsconfig.json` extending the base (`rootDir: src`, `outDir: dist`; apps/web uses Next's own tsconfig conventions: `jsx: preserve`, `moduleResolution: bundler`, `noEmit`, `plugins: [{ name: 'next' }]`, path alias `@/*` → `./src/*` and `@/app/*` → `./app/*`), and `src/index.ts` exporting nothing yet (a one-line comment is enough).
8. `eslint.config.js` (flat): `typescript-eslint` strict-type-checked + stylistic-type-checked, `eslint-plugin-import-x` (order groups: builtin, external, internal `@/`, parent, sibling, index; alphabetical; newline between groups), `eslint-plugin-security` recommended, `eslint-plugin-react-hooks` + `@next/eslint-plugin-next` scoped to `apps/web/**`, rules: `no-restricted-syntax` with selector `TSEnumDeclaration` (message: "Use string-literal unions"), `no-restricted-imports` paths: `crypto` → "use node:crypto", `uuid`/`nanoid` → "use crypto.randomUUID()", `dockerode` allowed only in files matching `packages/core/src/runner/docker/**` (implement as a general ban plus an override block for that glob that turns it off), `@typescript-eslint/consistent-type-imports`, `@typescript-eslint/no-explicit-any: error`, `@typescript-eslint/ban-ts-comment: error` (no exceptions), `eslint-comments`-style rule is not installed — instead add a lint-staged grep step in `.lintstagedrc.json` that fails on `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` in staged files. Ignore `dist/`, `.next/`, `coverage/`, `packages/core/src/persistence/generated/**`.
9. `.prettierrc`: `singleQuote: true`, `semi: true`, `printWidth: 100`, `trailingComma: all`, `plugins: ['prettier-plugin-tailwindcss']`. `.prettierignore` mirrors the ESLint ignores plus `pnpm-lock.yaml`.
10. `.editorconfig`, `.gitignore` (as in the acceptance criteria), `.husky/pre-commit` (`pnpm lint-staged`), `.husky/commit-msg` (`pnpm commitlint --edit "$1"`), `commitlint.config.js` (`@commitlint/config-conventional`, header max 100), `.lintstagedrc.json` (`*.{ts,tsx,js,mjs}` → eslint --fix + prettier; `*.{md,json,yml,yaml,css}` → prettier; plus the suppression grep described above).
11. `CLAUDE.md` (root, English) with sections: What this is (3 lines) · Stack & versions · Commands (the root scripts) · Ownership map (table: lane → owned paths, copied from docs/plan.md §6 and §7) · Gates before any PR (lint, typecheck, unit 100 % coverage all metrics, integration if tagged, code review zero findings) · Rules (no new dependencies inside lanes; no `enum`; no suppression comments; JSDoc on every export; test headers + it() comments; English only; Conventional Commits; no AI-attribution trailers; secrets: use canaries from `packages/core/src/testing/canaries.ts`, never real-looking values) · Pointers (docs/spec, docs/plan.md, docs/tasks).

Constraints:
- Follow /bymax-workflow:standards: TS strict, JSDoc on every export, English comments only, no suppression comments.
- Do not install dependencies in this task beyond what the tooling itself needs to run (`typescript`, `eslint` + plugins, `prettier` + tailwind plugin, `husky`, `lint-staged`, `@commitlint/*`). Task 0.2 installs everything else.
- Pin `typescript` to `~6.0.3` in the root `devDependencies`.

Verification:
- `pnpm install` — succeeds; `node -v` prints v24.x
- `pnpm typecheck` — exit 0 on empty workspaces
- `pnpm lint` — exit 0
- `git commit -m "bad message"` on a dummy change — rejected by commitlint; `git commit -m "chore: scaffold monorepo"` — accepted
- A staged file containing `// @ts-ignore` is rejected by the pre-commit hook

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-0-foundation.md (header block and task index row)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/8 tasks`)
4. Append a completion log entry at the end of the file: `- 0.1 ✅ <YYYY-MM-DD> — <one-line summary>`
5. Commit: `chore: scaffold monorepo and tooling`
````

---

## Task 0.2 — Complete dependency manifest (all workspaces)

**Status:** ✅ Done · **Priority:** P0 · **Size:** S · **Depends on:** 0.1

**Description.** Install every runtime and dev dependency any lane will need, at the latest stable versions, so no later lane touches `pnpm-lock.yaml`.

**Acceptance criteria**
- [x] All packages below present in the correct workspace `package.json` with caret ranges on latest stable (verified with `npm view <pkg> version` at execution time)
- [x] `pnpm install --frozen-lockfile` passes from a clean clone
- [x] `pnpm audit --prod` shows no critical/high (document any unavoidable advisory in the PR)
- [x] `pnpm typecheck` still passes (type packages resolve)

**Files to modify**
`package.json`, `apps/web/package.json`, `apps/worker/package.json`, `packages/core/package.json`, `packages/agent-runtime/package.json`, `pnpm-lock.yaml`.

**Agent prompt**

````
You are a senior full-stack TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 workspaces · TypeScript ~6.0.3 · Node 24 · Next.js 16.3 + React 19.2 · Tailwind v4 + shadcn · Postgres 18 + Prisma 7.9 · Redis 8 + BullMQ 6 · dockerode 5 · openai 7.5 · Vitest 4 · Playwright 1.62 · Stryker 10.
Branch feat/w0-foundation (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W0 — Task 0.2 of 8 (MIDDLE)

PRECONDITIONS
- Task 0.1 done: monorepo with four workspaces, tooling, typescript ~6.0.3 pinned.

REQUIRED READING (only these):
- docs/plan.md § "5. Wave 0" item 2 (dependency manifest) and § "3. Parallelism rules" item 2

TASK
Add every dependency listed below to the right workspace at the latest stable version (check `npm view <name> version` for each; use caret ranges), run `pnpm install`, commit the lockfile. Do not write application code.

DELIVERABLES

1. Root `devDependencies` (add to what 0.1 installed): `typescript-eslint`, `eslint-plugin-import-x`, `eslint-plugin-security`, `eslint-plugin-react-hooks`, `@next/eslint-plugin-next`, `vitest`, `@vitest/coverage-v8`, `@vitest/ui`, `tsx`, `esbuild`, `concurrently`, `@stryker-mutator/core`, `@stryker-mutator/vitest-runner` (same 10.x version as core), `@types/node` (24.x), `rimraf`.
2. `packages/core`: dependencies `zod` (4.x), `pino`, `@prisma/client`, `@prisma/adapter-pg`, `pg`, `bullmq` (6.x), `ioredis` (6.x), `dockerode` (5.x), `openai` (7.x), `cron-parser`, `tar-stream`; devDependencies `prisma`, `@types/dockerode`, `@types/pg`, `@types/tar-stream`, `pino-pretty`.
3. `packages/agent-runtime`: dependencies `zod`, `openai`, `@agent-hangar/core` (`workspace:*`); devDependencies `esbuild`, `@types/node`. (Stdlib `node:child_process`, `node:fs`, `node:path` are used for tools — no execa, no globby.)
4. `apps/web`: dependencies `next` (16.x), `react`, `react-dom` (19.x), `@agent-hangar/core` (`workspace:*`), `tailwindcss` (4.x), `@tailwindcss/postcss`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `sonner`, `cmdk`, `@base-ui-components/react`, `react-markdown`, `remark-gfm`, `rehype-highlight`, `ioredis`, `bullmq`, `zod`, `pino`; devDependencies `shadcn` (4.x CLI), `@types/react`, `@types/react-dom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `jsdom`, `msw` (2.x), `@playwright/test` (1.62+), `@vitejs/plugin-react`, `postcss`.
5. `apps/worker`: dependencies `@agent-hangar/core` (`workspace:*`), `bullmq`, `ioredis`, `pino`, `zod`; devDependencies `pino-pretty`, `tsx`.
6. Run `pnpm install`; ensure `pnpm-lock.yaml` is committed; run `pnpm audit --prod` and note results.

Constraints:
- Latest stable only (no rc/beta/canary). If a package's latest major is incompatible with a peer (e.g. a shadcn-generated component needs a specific Base UI version), pin the compatible one and write a one-line comment in the PR description.
- Do not add anything not listed; if you believe something is missing, add it and list it explicitly in the PR description under "Manifest additions".

Verification:
- `pnpm install --frozen-lockfile` — exit 0
- `pnpm typecheck && pnpm lint` — exit 0
- `pnpm ls -r --depth 0` — every package above appears in its workspace

Completion Protocol: update status/AC/progress in docs/tasks/wave-0-foundation.md; append `- 0.2 ✅ <date> — <summary>`; commit `build(deps): install complete dependency manifest`.
````

---

## Task 0.3 — Frozen core contracts: types, Zod, NDJSON codec, errors, config

**Status:** ✅ Done · **Priority:** P0 · **Size:** L · **Depends on:** 0.2

**Description.** Implement every cross-lane contract in `packages/core` exactly as specified, with Zod schemas for boundary data, the shared NDJSON codec, typed errors, and the environment/instance configuration module — all unit-tested to 100 %.

**Acceptance criteria**
- [x] `src/runner/types.ts` exports `WorkspaceSpec`, `WorkspaceHandle`, `ExecSpec`, `ExecEvent` (incl. `started`), `WorkspaceSnapshot`, `WorkspaceHealth`, `WorkspaceRunner` exactly as spec 03 §1
- [x] `src/model/types.ts` exports `ToolDefinition`, `ConversationItem`, `ModelTurnInput`, `ModelEvent`, `AgentModelProvider` as spec 03 §2
- [x] `src/agent-protocol/{schemas,types,ndjson}.ts`: Zod schemas for `TurnRequest` and every `AgentEvent` variant; types via `z.infer`; `encodeLine(obj)`, `createNdjsonParser()` (async transform handling partial lines, multiple events per chunk, invalid JSON → `{ type: 'protocol.error', line, reason }` without throwing)
- [x] `src/secrets/types.ts` (`SecretKey`, `SecretsService`, `Redactor`), `src/scheduling/types.ts` (`CronSpec`, `SchedulerKey`, `ReconcilePlan`), `src/workspace/types.ts` (`WorkspaceStatus`, `TurnStatus`, `JobRunStatus`, `RestoreContext`, `EnsureWorkspaceDecision`)
- [x] `src/persistence/ports.ts`: interfaces for Chat/Message/Turn/Workspace/ScheduledJob/JobRun/ToolCallLog/Secret repositories with method signatures sufficient for every flow in spec 04 (document each method)
- [x] `src/api/contracts.ts`: Zod request/response schemas for every route in spec 03 §4 + `SseFrame` type; `src/queues/contracts.ts`: queue names, job names, payload schemas (spec 03 §5)
- [x] `src/config/schema.ts` (Zod env schema with every variable in spec 05 §3 and defaults), `src/config/instance.ts` (`resolveInstance({ env })` → `{ instance, portBase, webPort, postgresPort, redisPort, postgresDb, composeProjectName, workspaceNamePrefix }` with precedence `AH_*` → `CONDUCTOR_*` → defaults, slugify `[a-z0-9-]` max 30)
- [x] `src/errors.ts`: `AgentHangarError` base + `WorkspaceImageMissing`, `SecretIntegrityError`, `ProtocolError`, `InvalidCronError`, `IllegalTransitionError`, `ConfigError`, each with `code` literal
- [x] `src/index.ts` barrel exports the public API (types, schemas, codec, errors, config); 100 % coverage on everything in this task

**Files to create**
`packages/core/src/{runner/types.ts, model/types.ts, agent-protocol/{schemas,types,ndjson,index}.ts, secrets/types.ts, scheduling/types.ts, workspace/types.ts, persistence/ports.ts, api/contracts.ts, queues/contracts.ts, config/{schema,instance,index}.ts, errors.ts, index.ts}` + `*.test.ts` next to each implementation file, `packages/core/vitest.config.ts`.

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core is framework-free (zod, pino, prisma, bullmq, ioredis, dockerode, openai available). Vitest 4 with @vitest/coverage-v8.
Branch feat/w0-foundation (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W0 — Task 0.3 of 8 (MIDDLE)

PRECONDITIONS
- Tasks 0.1–0.2 done: workspaces exist, all dependencies installed, `packages/core/src/index.ts` is empty.

REQUIRED READING (only these):
- docs/spec/03-interfaces.md (ALL sections — this task transcribes them)
- docs/spec/02-data-model.md § "3. Invariants", § "4. What workspace context must be persisted"
- docs/spec/05-local-dev.md § "3. Environment model"
- docs/spec/04-flows.md (skim the four diagrams to size the repository ports)
- docs/plan.md § "5. Wave 0" item 3

TASK
Freeze every cross-lane contract in packages/core: TypeScript interfaces and unions copied from the spec, Zod schemas for everything that crosses a process boundary (types derived with z.infer), the NDJSON codec shared by worker and agent-runtime, typed error classes, and the env/instance configuration module. Everything unit-tested to 100 % coverage on all four metrics.

DELIVERABLES

1. `packages/core/src/runner/types.ts` — transcribe spec 03 §1. Add `{ type: 'started'; execRef: string }` as the first `ExecEvent` variant and document that `exec()` always yields it first. No implementation here; create an empty folder `src/runner/docker/` with a `.gitkeep` (W1-B owns it).
2. `packages/core/src/model/types.ts` — transcribe spec 03 §2 (`AgentModelProvider.stream`, `listModels`). Create `src/model/openai/.gitkeep` (W1-C owns it).
3. `packages/core/src/agent-protocol/schemas.ts` — Zod: `toolNameSchema` (`run_shell|read_file|write_file|list_dir`), `conversationItemSchema`, `turnRequestSchema` (all fields of spec 03 §3 incl. `protocolVersion: z.literal(1)`, `limits`, `prepare`), `agentEventSchema` as a discriminated union over `type` covering every variant in the spec plus `{ type: 'protocol.error', line: string, reason: string }` and `turn.completed` gaining optional `stoppedBy?: 'limit'`. `types.ts` re-exports `z.infer` types (`TurnRequest`, `AgentEvent`, `ToolName`, …). `ndjson.ts`: `encodeLine(value: unknown): string` (JSON + "\n"), `createNdjsonParser<T>(schema: ZodType<T>)` returning an object with `push(chunk: Uint8Array | string): T[]` and `flush(): T[]` that buffers partial lines, splits on "\n", parses each line with the schema, and maps invalid lines to a `protocol.error`-shaped value (never throws; expose the raw line truncated to 200 chars). Also `parseNdjsonStream(source: AsyncIterable<Uint8Array>, schema)` → `AsyncIterable<T>` built on the parser.
4. `packages/core/src/secrets/types.ts` — `SecretKey = 'GITHUB_PAT' | 'OPENAI_API_KEY'`, `SecretsService`, `Redactor` (spec 03 §6) + `SECRET_SHAPE_PATTERNS` constant (the regexes listed in spec 03 §6, as `readonly RegExp[]`) — the constant lives here so W1-A implements against it and tests reuse it.
5. `packages/core/src/scheduling/types.ts` — `CronSpec { cron: string; timezone: string }`, `SchedulerKey = string` (job id), `ReconcilePlan { upsert: ScheduledJobRef[]; remove: SchedulerKey[] }`, `OverlapPolicy = 'skip'`.
6. `packages/core/src/workspace/types.ts` — string-literal unions mirroring the Prisma enums: `ChatStatus`, `MessageRole`, `TurnStatus`, `WorkspaceKind`, `WorkspaceStatus`, `JobRunStatus`, `JobRunTrigger`, `ToolCallStatus`; `RestoreContext` (fields of spec 02 §4); `EnsureWorkspaceDecision = { action: 'reuse', workspaceId } | { action: 'create', clone: true, restore: RestoreContext }`.
7. `packages/core/src/persistence/ports.ts` — repository interfaces. Minimum methods: Chat: `create`, `getById`, `list(status)`, `setStatus`, `updateRestoreHints`, `touch`, `delete`. Message: `append(chatId, role, content, turnId?)` (assigns gap-free seq), `listByChat(chatId, {limit?, before?})`. Turn: `create`, `setStatus`, `get`, `finish(usage)`, `listByChat`. Workspace: `create`, `findLiveByChat`, `setStatus`, `listIdle(before)`, `listLive`, `get`. ScheduledJob: CRUD + `listEnabled`, `setRunTimes`. JobRun: `create`, `setStatus`, `finish`, `listByJob`, `get`, `findRunningByJob`. ToolCallLog: `start`, `finish`, `listByTurn`, `listByJobRun`. Secret: `upsert(key, envelope)`, `get(key)`, `remove(key)`, `status()`. Every method documented; inputs/outputs are domain types (no Prisma types leak).
8. `packages/core/src/api/contracts.ts` — Zod schemas per route in spec 03 §4 (`createChatRequest`, `chatSummary`, `chatDetail`, `renameChatRequest` (`PATCH /api/chats/:id { title }`), `postMessageRequest`, `jobUpsertRequest`, `jobSummary`, `runSummary`, `runDetail`, `settingsStatus`, `putSecretRequest`, `healthResponse`, `repoSummary`, `branchSummary`, `apiError`) + `SseFrame { id: string; event: AgentEvent['type'] | 'expired'; data: string }`. Export a `routes` const map of path templates.
9. `packages/core/src/queues/contracts.ts` — `QUEUE_NAMES` (`chat-turns`, `scheduled-jobs`, `workspace-gc`), `JOB_NAMES` (`run-turn`, `run-scheduled-job`, `reap-idle`, `destroy-chat-workspace`), Zod payload schemas (`runTurnPayload {turnId}`, `runScheduledJobPayload {jobId, trigger}`, `destroyChatWorkspacePayload {chatId}`), `turnEventsStreamKey(turnId)`, `turnCommandChannel(turnId)`.
10. `packages/core/src/config/schema.ts` — Zod object with every variable from docs/spec/05-local-dev.md §3 (`AH_INSTANCE`, `AH_PORT_BASE`, `WEB_PORT`, `POSTGRES_PORT`, `REDIS_PORT`, `POSTGRES_DB`, `DATABASE_URL`, `REDIS_URL`, `COMPOSE_PROJECT_NAME`, `MASTER_KEY_PATH`, `WORKSPACE_IMAGE`, `WORKSPACE_NAME_PREFIX`, `WORKSPACE_IDLE_TTL_MIN`, `WORKER_TURN_CONCURRENCY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, `AGENT_MODEL_PROVIDER`, `DOCKER_HOST`, `LOG_LEVEL`, plus `NEXT_PUBLIC_API_MOCK`), coercions and defaults; `loadConfig(env = process.env)` that first runs `resolveInstance` and then validates, throwing `ConfigError` with a readable list of problems. `instance.ts` — `resolveInstance` exactly as the acceptance criteria describe (precedence AH_* → CONDUCTOR_WORKSPACE_NAME/CONDUCTOR_PORT → `default`/`3000`; slugify; ports = base+0/+1/+2; db `agent_hangar_<instance>` with `-` → `_`; compose project `agent-hangar-<instance>`; prefix `ah-ws-<instance>-`).
11. `packages/core/src/errors.ts` — `AgentHangarError extends Error { readonly code: string }` and subclasses listed in the acceptance criteria, each with a literal `code` and a helpful default message (e.g. `WorkspaceImageMissing` includes the `pnpm infra:image` command).
12. `packages/core/src/index.ts` — root barrel that ONLY re-exports per-folder barrels: `export * from './runner/index.js'`, `'./model/index.js'`, `'./agent-protocol/index.js'`, `'./secrets/index.js'`, `'./redaction/index.js'`, `'./logging/index.js'`, `'./scheduling/index.js'`, `'./workspace/index.js'`, `'./restore/index.js'`, `'./persistence/index.js'`, `'./queues/index.js'`, `'./api/index.js'`, `'./config/index.js'`, `'./errors.js'`. Create every one of those folder `index.ts` files now (exporting the types/schemas that exist; empty-comment placeholder `// Public API of <folder>; implementations are added by lane <W1-x>.` where nothing exists yet, e.g. `redaction/`, `logging/`, `restore/`, `runner/docker/`, `model/openai/`, `persistence/repositories/`). Later lanes add exports ONLY to the barrel of the folder they own — the root `index.ts` is frozen after W0 (avoids every lane editing one file). `packages/core/vitest.config.ts` — node environment, `coverage.provider: 'v8'`, `coverage.include: ['src/agent-protocol/**','src/config/**','src/errors.ts','src/api/**','src/queues/**']`, `coverage.exclude: ['**/*.test.ts','src/**/types.ts','src/index.ts','src/persistence/generated/**']` (pure type files have no runtime), thresholds 100/100/100/100.
13. Tests (`*.test.ts` beside each file): NDJSON codec (partial chunks, multiple lines per chunk, invalid JSON, schema violation, flush with trailing partial, large line, CRLF), every Zod schema accepts the spec example and rejects a malformed variant, config defaults and overrides, instance precedence table, slugify (upper-case, spaces, >30 chars, unicode), error classes `code`/`message`/`instanceof`.

Constraints:
- Follow /bymax-workflow:standards: TS strict, JSDoc + file headers, English, no `enum`, no suppression comments, test headers and a block comment on every it().
- Names must match the spec verbatim — other lanes are written against them.
- No runtime import of dockerode/openai/bullmq in this task (types only if needed).

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — all green, coverage 100/100/100/100 for included files
- `pnpm typecheck && pnpm lint` — exit 0
- `node -e "import('@agent-hangar/core')"` from apps/worker after `pnpm --filter @agent-hangar/core build` — resolves

Completion Protocol: update status/AC/progress in docs/tasks/wave-0-foundation.md; append `- 0.3 ✅ <date> — <summary>`; commit `feat(core): freeze cross-lane contracts, protocol codec, config and errors`.
````

---

## Task 0.4 — Test doubles and canaries (`packages/core/src/testing`)

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 0.3

**Description.** Provide the fakes every lane tests against: `FakeWorkspaceRunner`, `FakeAgentModelProvider`, in-memory repositories for every port, `FakeClock`, and the secret canaries.

**Acceptance criteria**
- [x] `FakeWorkspaceRunner` implements `WorkspaceRunner` with an in-memory filesystem per handle, scripted `exec` responses (by command prefix), `signal` support that aborts a scripted long exec, `snapshot`, `destroy` idempotent, `list` by labels, `health` reflecting state; records every call for assertions
- [x] `FakeAgentModelProvider` implements `AgentModelProvider`; takes a script map keyed by the last user message (or a default) → ordered `ModelEvent[]` with optional per-event delay; supports tool-call sequences across steps; `listModels` returns `['fake-model']`
- [x] `InMemory*Repository` for all eight ports with the same invariants as Postgres (gap-free `seq`, one live workspace per chat throws, unique `JobRun.workspaceId`)
- [x] `FakeClock` (`now()`, `advance(ms)`) and `canaries.ts` (`GITHUB_CANARY = 'ghp_TESTCANARY0000000000000000000000000'`, `OPENAI_CANARY = 'sk-TESTCANARY00000000000000000000'`)
- [x] Exported from `@agent-hangar/core/testing` (package `exports` subpath); 100 % coverage

**Files to create**
`packages/core/src/testing/{fake-workspace-runner,fake-agent-model-provider,in-memory-repositories,fake-clock,canaries,index}.ts` + tests; `packages/core/package.json` exports `./testing`.

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Vitest 4. packages/core is framework-free.
Branch feat/w0-foundation (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W0 — Task 0.4 of 8 (MIDDLE)

PRECONDITIONS
- Task 0.3 done: contracts exist in packages/core/src/{runner,model,agent-protocol,persistence/ports.ts,workspace,secrets}.

REQUIRED READING (only these):
- packages/core/src/runner/types.ts, model/types.ts, persistence/ports.ts, workspace/types.ts (the code you implement against)
- docs/spec/06-testing.md § "7. Test doubles"
- docs/spec/02-data-model.md § "3. Invariants"

TASK
Implement the shared test doubles in packages/core/src/testing so every later lane (runner consumers, worker, web API, E2E in fake mode) can test without Docker, OpenAI or Postgres.

DELIVERABLES

1. `fake-workspace-runner.ts` — class `FakeWorkspaceRunner implements WorkspaceRunner` (`kind = 'fake'`). Constructor options: `scripts?: ExecScript[]` where `ExecScript = { match: (cmd: readonly string[]) => boolean; events: ExecEvent[] | ((spec: ExecSpec) => AsyncIterable<ExecEvent>); }`, `createDelayMs?`. State: `Map<workspaceId, { handle, spec, files: Map<string,string>, status }>`. `exec` yields `{type:'started', execRef}` then the scripted events; default script echoes stdin to stdout and exits 0. `signal(handle, execRef, 'INT'|'TERM'|'KILL')` aborts an in-flight scripted exec (use AbortController per execRef). `snapshot` returns a deterministic summary from the in-memory files. `destroy` is idempotent and marks gone. `list(labels)` filters by subset match on `spec.labels`. Expose `calls: Array<{ method: string; args: unknown[] }>` and helpers `getWorkspace(id)`, `writeFile(id, path, content)`.
2. `fake-agent-model-provider.ts` — class `FakeAgentModelProvider implements AgentModelProvider` (`name='fake'`). Options: `script: Record<string, ScriptedStep[]> & { default?: ScriptedStep[] }` where `ScriptedStep = { events: ModelEvent[]; delayMs?: number }`; `stream(input)` selects the script by the text of the last `role:'user'` item (exact match, then `default`), pops the next step each call (so multi-step tool loops work), yields events in order honouring `delayMs` and `input.signal` (abort → yields `error` event with code 'unknown'? No — abort must end the stream silently; document it). `listModels()` → `['fake-model']`. Provide a helper `simpleAnswer(text)` and `toolThenAnswer(toolCall, answerText)` script builders.
3. `in-memory-repositories.ts` — one class per port in persistence/ports.ts, backed by Maps, generating ids with `crypto.randomUUID()`, timestamps from an injected `Clock`. Enforce: Message seq gap-free per chat; Workspace "one live per chat" (throw `IllegalTransitionError` or a dedicated error when violated); JobRun workspaceId unique; cascade deletes for Chat. Provide `createInMemoryRepositories(clock)` returning all eight.
4. `fake-clock.ts` — `FakeClock implements Clock { now(): Date; advance(ms: number): void; set(date: Date): void }` (define `Clock` interface here and re-export from core index).
5. `canaries.ts` — the two constants plus `CANARY_VALUES: readonly string[]` and a helper `assertNoCanary(text: string)` that throws listing which canary leaked (used by lanes to assert redaction).
6. `index.ts` barrel; add `"./testing": "./dist/testing/index.js"` (types too) to packages/core `exports`; extend `vitest.config.ts` `coverage.include` with `src/testing/**`.
7. Tests for each double: runner (create/exec default echo/scripted match/signal aborts/destroy idempotent/list labels/health gone), provider (script selection, multi-step pop, delay, abort), repositories (every invariant above + each method), clock, canaries (`assertNoCanary` throws on each canary, passes on clean text).

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- Doubles must be deterministic; no real timers in tests — use `vi.useFakeTimers()` where delays exist.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green, 100 % on `src/testing/**`
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-0-foundation.md; append `- 0.4 ✅ <date> — <summary>`; commit `feat(core): add shared test doubles and canaries`.
````

---

## Task 0.5 — Prisma 7 schema, migration, client factory

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 0.2

**Description.** Add the Prisma 7 schema exactly as spec 02, the first migration (including the partial unique index), `prisma.config.ts`, and a client factory using `@prisma/adapter-pg` with a real-round-trip boot check.

**Acceptance criteria**
- [x] `packages/core/prisma/schema.prisma` matches spec 02 §2 (generator `prisma-client`, output `../src/persistence/generated`, no datasource url)
- [x] `prisma.config.ts` reads `DATABASE_URL` via core config (`import 'dotenv/config'` is NOT used; the scripts pass env from `.env.local`)
- [x] Migration `0001_init` created with `prisma migrate dev --create-only` and hand-edited to add `CREATE UNIQUE INDEX "Workspace_one_live_per_chat" ON "Workspace"("chatId") WHERE status IN ('CREATING','READY','BUSY','STOPPING') AND "chatId" IS NOT NULL;`
- [x] `src/persistence/client.ts`: `createPrismaClient({ connectionString, max?, connectionTimeoutMillis? })` → `PrismaClient` with `PrismaPg` adapter; `assertDatabaseReachable(client)` runs `SELECT 1` (adapter `$connect()` is lazy — documented); `disconnect`
- [x] `src/persistence/generated/**` is git-ignored and produced by `pnpm db:generate`; unit tests cover the factory with an injected fake adapter/`$queryRaw`; integration test (tag `@db`) applies the migration to compose Postgres and asserts the partial index exists

**Files to create**
`packages/core/prisma/schema.prisma`, `packages/core/prisma/migrations/0001_init/migration.sql`, `packages/core/prisma/migrations/migration_lock.toml`, `packages/core/prisma.config.ts`, `packages/core/src/persistence/{client,client.test,client.integration.test}.ts`, `packages/core/src/persistence/testing/db.ts` (connect helper for `AH_INSTANCE=test`, truncate all tables), `.gitignore` entry.

**Agent prompt**

````
You are a senior backend engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Postgres 18 · Prisma 7.9 with `prisma-client` generator and `@prisma/adapter-pg` (driver adapters are mandatory in Prisma 7; `datasource url` is not in the schema; `.env` is not auto-loaded). Vitest 4.
Branch feat/w0-foundation (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W0 — Task 0.5 of 8 (MIDDLE)

PRECONDITIONS
- Tasks 0.1–0.3 done. Compose file may not exist yet (Task 0.6) — write the integration test so it runs only when `DATABASE_URL` is set and FAILS LOUDLY (not skipped) when `CI=1` and the DB is unreachable.

REQUIRED READING (only these):
- docs/spec/02-data-model.md § "2. Prisma schema draft", § "3. Invariants"
- docs/spec/05-local-dev.md § "3. Environment model" (DATABASE_URL shape)
- Prisma 7 upgrade guide (official docs): driver adapters, `prisma.config.ts`, `prisma-client` generator

TASK
Add the Prisma 7 schema, first migration with the partial unique index, config file, and a client factory that fails fast when Postgres is unreachable.

DELIVERABLES

1. `packages/core/prisma/schema.prisma` — copy the schema from docs/spec/02-data-model.md §2 verbatim (generator `prisma-client`, `output = "../src/persistence/generated"`, `datasource db { provider = "postgresql" }`).
2. `packages/core/prisma.config.ts` — Prisma 7 config exporting `defineConfig({ schema: 'prisma/schema.prisma', migrations: { path: 'prisma/migrations' }, datasource: { url: process.env.DATABASE_URL ?? '' } })` (adapt to the exact API in the installed Prisma version — check `node_modules/prisma/config.d.ts`).
3. Migration: run `pnpm prisma migrate dev --create-only --name init` against a local Postgres (start one with `docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=ah -e POSTGRES_USER=ah -e POSTGRES_DB=ah postgres:18-alpine` if compose is not available yet), then append the partial unique index statement from the acceptance criteria to `migration.sql`. Commit `migration_lock.toml`.
4. `packages/core/src/persistence/client.ts` — `createPrismaClient(opts: { connectionString: string; max?: number; connectionTimeoutMillis?: number })` building `new PrismaPg({ connectionString, max, connectionTimeoutMillis })` (Prisma URL params `connection_limit`/`pool_timeout` are ignored by pg — that is why these are explicit options) and `new PrismaClient({ adapter })`; `assertDatabaseReachable(client, timeoutMs = 5000)` → `await client.$queryRaw\`SELECT 1\`` with a timeout race, throwing `ConfigError('database unreachable: …')`; `disconnectPrisma(client)`.
5. `packages/core/src/persistence/testing/db.ts` — `connectTestDb()` reading `DATABASE_URL`, `truncateAll(client)` (TRUNCATE every table CASCADE, order-independent), `withTestDb(fn)` helper; exported via `@agent-hangar/core/testing` barrel (add to index).
6. Tests: `client.test.ts` unit (factory passes options through — mock `@prisma/adapter-pg` and `../generated/client` with `vi.mock`; `assertDatabaseReachable` resolves on `SELECT 1` success, throws `ConfigError` on rejection and on timeout using fake timers). `client.integration.test.ts` (describe tagged `@db`): connects, runs `prisma migrate deploy` programmatically or via `execSync`, asserts `pg_indexes` contains `Workspace_one_live_per_chat`, inserts two live workspaces for one chat and expects a unique-violation error, then truncates.
7. Add `packages/core/src/persistence/generated/` to `.gitignore`; add `db:generate` → `prisma generate`, `db:migrate` → `prisma migrate deploy` scripts in packages/core; ensure `postinstall`-free (generation is explicit via `pnpm db:generate`, called by setup).

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no suppression, it() comments).
- No Prisma types leak out of `src/persistence/**`; ports use domain types (W1-E maps them).
- `vitest.config.ts`: add `src/persistence/client.ts` and `src/persistence/testing/**` to `coverage.include`; integration test files are included in the default `pnpm test` run when `DATABASE_URL` is set, otherwise they run in `pnpm test:integration`.

Verification:
- `pnpm --filter @agent-hangar/core db:generate` — generates client into src/persistence/generated
- `pnpm --filter @agent-hangar/core test -- --coverage` — unit green, 100 %
- `DATABASE_URL=postgresql://ah:ah@127.0.0.1:55432/ah pnpm --filter @agent-hangar/core test:integration` — `@db` test green, partial index present

Completion Protocol: update status/AC/progress in docs/tasks/wave-0-foundation.md; append `- 0.5 ✅ <date> — <summary>`; commit `feat(core): add Prisma 7 schema, initial migration and client factory`.
````

---

## Task 0.6 — Infra skeleton: compose, workspace Dockerfile base, env.sh, scripts, .env.example

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 0.1

**Description.** Create the parameterised local infrastructure: docker-compose (Postgres 18, Redis 8), the workspace image base Dockerfile, the instance/port derivation shell helper, `.env.example`, and stub scripts that W1-I completes.

**Acceptance criteria**
- [x] `infra/docker-compose.yml` matches spec 05 §5 (name from `COMPOSE_PROJECT_NAME`, ports bound to `127.0.0.1:${POSTGRES_PORT}` / `${REDIS_PORT}`, healthchecks, named volumes)
- [x] `infra/scripts/env.sh` derives the same values as `packages/core/src/config/instance.ts` (instance, ports, db, compose project, prefix) and writes `.env.local` if absent (`--force` to overwrite; `--print` to echo)
- [x] `infra/workspace/Dockerfile` builds a base image (node:24-bookworm-slim + git, ca-certificates, ripgrep, jq, python3, build-essential; user `agent` uid 1001; `/workspace`; `ENTRYPOINT ["sleep","infinity"]`); contains a clearly marked placeholder comment where W1-D's runtime `COPY` lines go; `infra/workspace/askpass.sh` present
- [x] `.env.example` lists every variable from spec 05 §3 with comments
- [x] Stub scripts `infra/scripts/{setup,run,archive,doctor}.sh` exist, are executable, print "not implemented yet (W1-I)" and exit 1 — except `setup.sh`, which already performs: `pnpm install`, `env.sh`, master key creation (`~/.agent-hangar/master.key`, 0600, `openssl rand -hex 32`), `docker compose up -d --wait`, `pnpm db:generate && pnpm db:migrate`, `docker build` of the workspace image
- [x] `pnpm setup` succeeds on a machine with Docker Desktop; `pnpm infra:down` stops the instance

**Files to create**
`infra/docker-compose.yml`, `infra/scripts/{env,setup,run,archive,doctor}.sh`, `infra/workspace/{Dockerfile,askpass.sh,.dockerignore}`, `.env.example`; root `package.json` scripts wired (`setup` → `infra/scripts/setup.sh`, `infra:*`, `doctor`).

**Agent prompt**

````
You are a senior platform engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: macOS + Docker Desktop (OrbStack/Colima compatible) · Postgres 18 · Redis 8 · Node 24 · pnpm 11. Web and worker run on the host; only Postgres/Redis/workspaces run in Docker.
Branch feat/w0-foundation (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W0 — Task 0.6 of 8 (MIDDLE)

PRECONDITIONS
- Task 0.1 done (root scripts exist as names). Task 0.5 may be in progress; `pnpm db:migrate` is expected to exist when setup.sh runs.

REQUIRED READING (only these):
- docs/spec/05-local-dev.md § "3. Environment model", § "4. First-run experience", § "5. docker-compose services", § "6. Conductor integration" (only the env precedence paragraph)
- docs/spec/01-overview.md § "8. Risks" R2 (Docker socket)

TASK
Create the parameterised local infrastructure and the first-run setup script. Everything must be keyed by instance (`AH_INSTANCE`/`AH_PORT_BASE`, with `CONDUCTOR_WORKSPACE_NAME`/`CONDUCTOR_PORT` as fallbacks) so two checkouts never collide.

DELIVERABLES

1. `infra/scripts/env.sh` — POSIX-compatible bash (`#!/usr/bin/env bash`, `set -euo pipefail`). Functions: `ah_slugify` (lowercase, non `[a-z0-9-]` → `-`, collapse, trim, max 30), `ah_resolve_env` computing: `AH_INSTANCE` (explicit → `CONDUCTOR_WORKSPACE_NAME` → `default`), `AH_PORT_BASE` (explicit → `CONDUCTOR_PORT` → 3000), `WEB_PORT=$((BASE+0))`, `POSTGRES_PORT=+1`, `REDIS_PORT=+2`, `POSTGRES_DB=agent_hangar_${INSTANCE//-/_}`, `DATABASE_URL=postgresql://ah:ah@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}`, `REDIS_URL=redis://127.0.0.1:${REDIS_PORT}`, `COMPOSE_PROJECT_NAME=agent-hangar-${INSTANCE}`, `WORKSPACE_NAME_PREFIX=ah-ws-${INSTANCE}-`, `WORKSPACE_IMAGE=agent-hangar/workspace:dev`, `MASTER_KEY_PATH=$HOME/.agent-hangar/master.key`, defaults for `WORKSPACE_IDLE_TTL_MIN=30`, `WORKER_TURN_CONCURRENCY=2`, `OPENAI_MODEL=gpt-5.6-sol`, `AGENT_MODEL_PROVIDER=openai`, `LOG_LEVEL=info`. CLI: `env.sh` (write `.env.local` if absent), `--force`, `--print` (export lines to stdout, used by other scripts via `eval "$(infra/scripts/env.sh --print)"`).
2. `infra/docker-compose.yml` — as in docs/spec/05-local-dev.md §5; services `postgres` (`postgres:18-alpine`, user/password `ah`/`ah`, db `${POSTGRES_DB}`, `127.0.0.1:${POSTGRES_PORT}:5432`, volume `pgdata`, healthcheck `pg_isready`), `redis` (`redis:8-alpine`, `--appendonly yes`, `127.0.0.1:${REDIS_PORT}:6379`, volume `redisdata`, healthcheck `redis-cli ping`). Also a `test` profile variant is NOT needed — tests use `AH_INSTANCE=test` which yields its own compose project.
3. `infra/workspace/Dockerfile` — multi-purpose base: `FROM node:24-bookworm-slim`; apt install `git ca-certificates ripgrep jq python3 build-essential curl`; `corepack enable`; `useradd -m -u 1001 agent`; `mkdir /workspace && chown agent /workspace`; copy `askpass.sh` to `/opt/agent-runtime/askpass.sh` (chmod 755); git global config for user agent: `credential.helper ""`, `user.name "Agent Hangar"`, `user.email "agent@localhost"`, `safe.directory /workspace`; `# --- AGENT RUNTIME BUNDLE (added by W1-D) ---` placeholder comment followed by nothing; `USER agent`, `WORKDIR /workspace`, `ENTRYPOINT ["sleep","infinity"]`. `askpass.sh`: `#!/bin/sh` printing `$GITHUB_TOKEN` (used via `GIT_ASKPASS`; git calls it for username too — print `x-access-token` when the prompt contains "Username", else the token). `.dockerignore` ignoring everything except what is copied.
4. `.env.example` — every variable above with a one-line comment; header comment says secrets (PAT/OpenAI key) are NOT env vars but entered in Settings.
5. `infra/scripts/setup.sh` — idempotent first run: `pnpm install --frozen-lockfile`; `env.sh`; create master key dir/file if missing (0700/0600, `openssl rand -hex 32`), refuse (exit 1 with message) if the key file is group/world readable; `docker compose -f infra/docker-compose.yml --env-file .env.local up -d --wait`; `pnpm db:generate && pnpm db:migrate` with env from `.env.local`; `docker build -t "$WORKSPACE_IMAGE" infra/workspace`; finally call `doctor.sh` (stub for now). Detect Docker socket: honour `DOCKER_HOST`; else if `$HOME/.docker/run/docker.sock` exists export `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock`; else rely on `/var/run/docker.sock`; print which one was used.
6. `infra/scripts/{run,archive,doctor}.sh` — executable stubs that `echo "not implemented yet (lane W1-I)"; exit 1`.
7. Root `package.json` scripts: `setup` → `bash infra/scripts/setup.sh`, `infra:up`/`infra:down`/`infra:reset` (compose up -d --wait / down / down -v using `--env-file .env.local`), `infra:image` → docker build, `doctor` → `bash infra/scripts/doctor.sh`.
8. Minimal test: `infra/scripts/env.test.ts` (Vitest at root or in packages/core `scripts-tests` folder — pick root `vitest.config.ts` with a `scripts` project) spawning `env.sh --print` with env permutations and asserting exact values (default; AH_*; CONDUCTOR_*; slugify of `Feature/ABC def`), so shell and TS derivations stay in sync (compare against `resolveInstance` from core).

Constraints:
- Bash scripts must run on macOS default bash 3.2 (no associative arrays, no `mapfile`).
- Never echo secrets. Never write the master key anywhere inside the repo.
- English in all script output.

Verification:
- `bash infra/scripts/env.sh --print` — prints the default table; `AH_INSTANCE=Feat_X AH_PORT_BASE=4000 bash infra/scripts/env.sh --print` — instance `feat-x`, ports 4000/4001/4002, db `agent_hangar_feat_x`
- `pnpm setup` — finishes with infra up, migration applied, image built (on a machine with Docker)
- `pnpm infra:down` — containers of `agent-hangar-default` stopped
- `pnpm test` — env.sh test green

Completion Protocol: update status/AC/progress in docs/tasks/wave-0-foundation.md; append `- 0.6 ✅ <date> — <summary>`; commit `build(infra): add parameterised compose, workspace image base and setup script`.
````

---

## Task 0.7 — Apps skeleton: Next.js shell with tokens + shadcn, worker boot, test configs

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** L · **Depends on:** 0.3, 0.5, 0.6

**Description.** Stand up `apps/web` (Next 16 App Router, Tailwind v4 tokens from spec 10, shadcn components generated into `src/shared/ui`, fonts, route placeholders, typed API client, Vitest + Playwright configs) and `apps/worker` (boot: config, DB round-trip, Redis ping, graceful shutdown) with 100 % coverage on what exists.

**Acceptance criteria**
- [ ] `pnpm --filter web dev` serves `/chats/new`, `/chats/[id]`, `/scheduled`, `/scheduled/[id]`, `/settings` placeholders inside `(app)/layout.tsx` that has a 260 px sidebar slot and a header slot (empty components W1-G fills)
- [ ] `app/globals.css` defines every token of spec 10 §2 for light and dark via `@theme` + `:root`/`.dark` variables, `next/font` Inter + JetBrains Mono wired as CSS variables
- [ ] shadcn initialised (Base UI, new-york) with components from spec 10 §5 generated into `apps/web/src/shared/ui/` (Button, Input, Textarea, Dialog, AlertDialog, Sheet, Command, DropdownMenu, Tooltip, Switch, Table, Badge, Card, Separator, ScrollArea, Sonner, Skeleton, Collapsible, Tabs); `components.json` points aliases to `@/shared/ui`
- [ ] `src/shared/api/client.ts`: typed `apiFetch(route, input)` using `@agent-hangar/core` api contracts (Zod parse of responses), plus `createEventSource(url, lastEventId?)` wrapper; unit-tested
- [ ] `apps/web/vitest.config.ts` (jsdom, `@vitejs/plugin-react`, setup file with jest-dom, thresholds 100/100/100/100, `coverage.include: ['src/shared/api/**']` for now) and `playwright.config.ts` (baseURL from `WEB_PORT`, chromium, `webServer` disabled — harness in W2-C)
- [ ] `apps/worker/src/main.ts` boots: `loadConfig`, `createPrismaClient` + `assertDatabaseReachable`, Redis ping via ioredis, pino logger, SIGINT/SIGTERM graceful shutdown, exits non-zero with a clear message if infra is down; `apps/worker/vitest.config.ts` 100 % on `src/**` with the boot wiring tested via injected fakes
- [ ] `pnpm dev` runs web + worker concurrently with `.env.local`

**Files to create**
`apps/web/{next.config.ts,postcss.config.mjs,components.json,app/layout.tsx,app/globals.css,app/(app)/layout.tsx,app/(app)/chats/new/page.tsx,app/(app)/chats/[id]/page.tsx,app/(app)/scheduled/page.tsx,app/(app)/scheduled/[id]/page.tsx,app/(app)/settings/page.tsx,app/page.tsx (redirect → /chats/new),src/shared/ui/**,src/shared/api/{client,client.test}.ts,src/shared/lib/cn.ts,src/test/setup.ts,vitest.config.ts,playwright.config.ts}`, `apps/worker/src/{main.ts,boot.ts,boot.test.ts,logger.ts}`, `apps/worker/vitest.config.ts`, root `dev` script.

**Agent prompt**

````
You are a senior full-stack engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: Next.js 16.3 App Router (Turbopack default, `proxy.ts` instead of middleware — not needed) + React 19.2 · Tailwind v4 (`@theme`, CSS-first config) · shadcn CLI 4 (Base UI default) · Vitest 4 + Testing Library · Playwright 1.62 · worker: Node 24 + pino + ioredis + Prisma client from @agent-hangar/core.
Branch feat/w0-foundation (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W0 — Task 0.7 of 8 (MIDDLE)

PRECONDITIONS
- Tasks 0.3 (contracts, config), 0.5 (prisma client factory), 0.6 (env.sh, compose) done.

REQUIRED READING (only these):
- docs/spec/10-ui-design.md § "1. Direction", § "2. Tokens", § "3. App shell" (layout dimensions only), § "5. Components"
- docs/spec/03-interfaces.md § "4. HTTP API" (route list, for the client)
- packages/core/src/api/contracts.ts, packages/core/src/config/schema.ts, packages/core/src/persistence/client.ts
- docs/spec/06-testing.md § "1. Layers"

TASK
Create the two application skeletons so Wave 1 UI lanes can build features on a finished design-token + component foundation, and so the worker lane has a booting process to extend.

DELIVERABLES

apps/web
1. `next.config.ts` — `reactStrictMode`, `typedRoutes: true`, `output: 'standalone'`, `transpilePackages: ['@agent-hangar/core']`, `serverExternalPackages: ['pino','ioredis','bullmq','@prisma/client','@prisma/adapter-pg','pg']`. `postcss.config.mjs` with `@tailwindcss/postcss`.
2. `app/globals.css` — `@import "tailwindcss";` then `@theme inline` mapping semantic tokens (`--color-background`, `--color-sidebar`, `--color-card`, `--color-popover`, `--color-muted`, `--color-border`, `--color-input`, `--color-foreground`, `--color-muted-foreground`, `--color-primary`, `--color-primary-foreground`, `--color-accent`, `--color-success`, `--color-warning`, `--color-destructive`, `--color-ring`, `--radius-*`, `--font-sans`, `--font-mono`) to CSS variables defined in `:root` (light values from docs/spec/10 §2) and `.dark` (dark values); `@custom-variant dark (&:where(.dark, .dark *));`; base styles (body bg/fg, focus-visible ring 2px accent offset 2px, `prefers-reduced-motion` rule killing transitions/animations). Do NOT hardcode hex anywhere else.
3. `app/layout.tsx` — html `lang="en"`, `next/font/google` Inter (`--font-sans`) + JetBrains Mono (`--font-mono`), `suppressHydrationWarning`, theme class applied from a cookie/`localStorage` with system default (tiny inline script, no library); `Toaster` from Sonner mounted. `app/page.tsx` → `redirect('/chats/new')`.
4. `app/(app)/layout.tsx` — grid `grid-cols-[260px_1fr] h-dvh`: `<aside>` placeholder component `src/shared/shell/SidebarSlot.tsx` (renders children or an empty `nav` with `aria-label="Primary"`) and `<main>` with a 48 px header slot component `HeaderSlot.tsx`; both exported so W1-G replaces their contents, not the layout.
5. Route placeholders: `app/(app)/chats/new/page.tsx`, `chats/[id]/page.tsx`, `scheduled/page.tsx`, `scheduled/[id]/page.tsx`, `settings/page.tsx` — each renders an `<h1>` with the page name and a `data-testid="placeholder-<route>"`.
6. shadcn: `components.json` (style new-york, base Base UI, rsc true, tsx true, tailwind css `app/globals.css`, aliases `components: "@/shared/ui"`, `utils: "@/shared/lib/cn"`, `ui: "@/shared/ui"`). Run `pnpm dlx shadcn@latest add` for: button input textarea dialog alert-dialog sheet command dropdown-menu tooltip switch table badge card separator scroll-area sonner skeleton collapsible tabs. Generated files live in `src/shared/ui/`; `src/shared/lib/cn.ts` exports `cn` (clsx + tailwind-merge). Fix any lint findings in generated files by configuration (eslint override for `src/shared/ui/**` relaxing only stylistic rules — no suppression comments in files).
7. `src/shared/api/client.ts` — `apiFetch<TRoute>(route, { params?, query?, body?, signal? })` strongly typed via the `routes` map and Zod schemas from `@agent-hangar/core` (`parse` the JSON response; on non-2xx parse `apiError` and throw `ApiClientError { status, code, message }`); `createEventSource(path, { lastEventId? })` returning a native `EventSource` (same-origin; `Last-Event-ID` is handled by the browser automatically on reconnect — document; the option exists for manual resume via query param `?from=`). `src/shared/api/client.test.ts` — mock `fetch`; success parse, schema violation throws, non-2xx maps to `ApiClientError`, abort propagates.
8. `src/test/setup.ts` (jest-dom, `cleanup`), `vitest.config.ts` (environment jsdom, react plugin, alias `@/`, setupFiles, coverage v8 with `include: ['src/shared/api/**','src/shared/lib/**']`, thresholds 100×4, exclude `src/shared/ui/**` (generated vendor code — document why; W3-A decides whether to include), `playwright.config.ts` (testDir `e2e`, baseURL `http://127.0.0.1:${process.env.WEB_PORT ?? 3000}`, chromium only, retries 1 in CI, trace on-first-retry; no `webServer` yet).

apps/worker
9. `src/logger.ts` — `createLogger(level)` (pino; pretty transport only when `NODE_ENV !== 'production'` and stdout is TTY); `src/boot.ts` — `boot(deps)` where deps = `{ loadConfig, createPrismaClient, assertDatabaseReachable, createRedis, logger }` (all injectable) → validates config, checks DB with a real `SELECT 1`, `PING`s Redis, returns `{ config, prisma, redis, shutdown() }`; shutdown closes both and resolves. `src/main.ts` — calls `boot` with real deps, logs "worker ready (instance=…, web port …)", registers SIGINT/SIGTERM → shutdown → exit 0; on boot error logs `error.message` and exits 1. `boot.test.ts` — 100 % with fakes (success path, DB down, Redis down, shutdown ordering).
10. `apps/worker/vitest.config.ts` — node env, coverage include `src/**`, exclude `src/main.ts` only if it is a 5-line wiring file (prefer making main trivially small), thresholds 100×4.

Root
11. `dev` script → `concurrently -n web,worker -c blue,magenta "pnpm --filter web dev --port $WEB_PORT" "pnpm --filter worker dev"` wrapped by `infra/scripts/run.sh`? No — W1-I owns run.sh; for now root `dev` uses `dotenv`-free approach: `bash -c 'set -a; . ./.env.local; set +a; concurrently …'`. `apps/web` scripts: `dev` (`next dev`), `build`, `start`, `test`, `test:e2e`; `apps/worker`: `dev` (`tsx watch src/main.ts`), `build` (`tsc -b`), `start`, `test`.

Constraints:
- Tailwind v4 canonical syntax (`bg-(--token)` style not needed because tokens are mapped to utilities like `bg-background`; never raw hex in components).
- Accessibility from day one: landmarks (`nav`, `main`, `header`), focus-visible ring via tokens.
- Follow /bymax-workflow:standards (JSDoc on exports, headers, English, no enum, no suppression, it() comments).

Verification:
- `pnpm --filter web build` — succeeds (Turbopack), no type errors
- `pnpm dev` — web on WEB_PORT shows placeholders with the dark theme by default on a dark OS; worker logs "worker ready"; `Ctrl+C` exits cleanly
- `pnpm --filter web test -- --coverage` and `pnpm --filter worker test -- --coverage` — green, 100 %
- `pnpm lint && pnpm typecheck` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-0-foundation.md; append `- 0.7 ✅ <date> — <summary>`; commit `feat(apps): scaffold web shell with design tokens and worker boot`.
````

---

## Task 0.8 — CI workflow, README skeleton, plan dashboard, close-out PR

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** S · **Depends on:** 0.1–0.7

**Description.** Add the GitHub Actions pipeline (all jobs except mutation), the README skeleton with the decisions made here, update the plan dashboard, run the full gate set and code review, open the PR.

**Acceptance criteria**
- [ ] `.github/workflows/ci.yml` jobs: `lint`, `typecheck`, `unit` (coverage thresholds enforced), `integration` (services postgres:18 + redis:8; `DATABASE_URL`/`REDIS_URL` set; builds workspace image; runs `pnpm test:integration`), `e2e` (placeholder that runs `pnpm test:e2e` — passes with zero specs until W2-C), `build` (`pnpm build` + `docker build infra/workspace` + `docker run --rm <image> node --version`), `secret-scan` (gitleaks action); Node 24 + pnpm 11 via `pnpm/setup@v2` with store cache; concurrency group per ref
- [ ] `README.md` skeleton with the section list of spec 05 §7, Quick start filled, "Decisions" section recording TypeScript `~6.0.3` pin (why), shadcn Base UI, Responses API, BullMQ over pg-boss (one line each), "Known gaps & plan to finish" listing Wave 1–4 lanes as pending
- [ ] `docs/plan.md` §12 row W0 → 🟨 PR open with branch/PR number; `docs/tasks/README.md` index exists (table of lane files with status)
- [ ] `pnpm lint && pnpm typecheck && pnpm test -- --coverage` green locally; `/bymax-quality:code-review` run with zero open findings; PR opened with the structured summary from plan §11

**Files to create/modify**
`.github/workflows/ci.yml`, `README.md`, `docs/plan.md` (§12), `docs/tasks/README.md`.

**Agent prompt**

````
You are a senior engineer closing out the foundation lane of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 · Node 24 · Next 16.3 · Prisma 7.9 · BullMQ 6 · Vitest 4 · Playwright 1.62 · GitHub Actions.
Branch feat/w0-foundation (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W0 — Task 0.8 of 8 (LAST)

PRECONDITIONS
- Tasks 0.1–0.7 done and committed on this branch.

REQUIRED READING (only these):
- docs/spec/06-testing.md § "6. CI pipeline"
- docs/spec/05-local-dev.md § "7. What the README will contain"
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard"

TASK
Add CI, the README skeleton, update the plan dashboard, run all gates and a code review, and open the PR with a structured summary.

DELIVERABLES

1. `.github/workflows/ci.yml` — triggers `pull_request` and `push` to `main`; `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`; a reusable setup step (checkout v7, `pnpm/setup@v2` with `version: 11`, `runtime: node@24`, `cache: true`, `pnpm install --frozen-lockfile`). Jobs: `lint` (`pnpm lint && pnpm format:check`), `typecheck`, `unit` (`pnpm test -- --coverage`), `integration` (services `postgres:18-alpine` user/pass/db `ah`, `redis:8-alpine`; env `DATABASE_URL=postgresql://ah:ah@127.0.0.1:5432/ah`, `REDIS_URL=redis://127.0.0.1:6379`, `AH_INSTANCE=ci`, `DOCKER_AVAILABLE=1`; steps: `pnpm db:generate`, `pnpm db:migrate`, `docker build -t agent-hangar/workspace:dev infra/workspace`, `pnpm test:integration`), `e2e` (same services; `pnpm test:e2e` — must succeed with no specs; upload `playwright-report` on failure), `build` (`pnpm build`; docker build of the workspace image; `docker run --rm agent-hangar/workspace:dev node --version`), `secret-scan` (`gitleaks/gitleaks-action@v2` with `GITHUB_TOKEN`). No `continue-on-error` anywhere.
2. `README.md` — title "Agent Hangar", one-paragraph description, badges placeholder, sections in this order: Requirements · Quick start (`git clone`, `corepack enable`, `pnpm setup`, `pnpm dev`, then Settings → keys) · How it works (short, link to docs/spec/01-overview.md and the component diagram) · Configuration (table from docs/spec/05 §3) · Scripts · Working with Conductor (one line + link, to be completed by W1-I) · Testing · Security notes (stub) · Troubleshooting (Docker socket, port in use) · Known gaps & plan to finish (list lanes W1-A…W4-B as pending with one line each) · Decisions (TypeScript pinned to ~6.0.3 because TS 7's native compiler has no stable programmatic API until 7.1; shadcn on Base UI; OpenAI Responses API; BullMQ over pg-boss; SSE over WebSocket; exec+NDJSON over per-container HTTP — one line each with the reason) · License placeholder.
3. `docs/tasks/README.md` — index table of every lane task file (W0, W1-A…W1-I, W2-A…W2-C, W3-A, W3-B, W4-A, W4-B) with status column.
4. Update `docs/plan.md` §12 row W0 to 🟨 with branch name and PR number once opened.
5. Gates: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test -- --coverage` green; run `/bymax-quality:code-review` on the branch and fix every finding (no suppressions); `git log` messages conventional; no attribution trailers.
6. Open the PR (`gh pr create --base main --title "feat: foundation, frozen contracts and tooling (W0)" --body-file <generated>`), body: summary, what is frozen (contract files list), how to run, gate results, coverage numbers, decisions, known gaps. Return to the orchestrator: `{ pr, branch, headSha, gates: {...}, coverage: {...}, contractChangeRequests: [] }`.

Constraints:
- English; Conventional Commits; no AI attribution anywhere.
- Do not wait for CI; do not merge.

Verification:
- `act`-free check: `yamllint`-style sanity via `node -e "require('js-yaml')"` is unnecessary — instead `gh workflow view` after push shows the workflow parsed
- `gh pr view --json number,headRefOid` — PR exists

Completion Protocol: update status/AC/progress in docs/tasks/wave-0-foundation.md (lane header Status → 🟨 PR open); append `- 0.8 ✅ <date> — PR #<n> opened`; commit `ci: add pipeline and README skeleton` before opening the PR.
````

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)
- 0.1 ✅ 2026-08-19 — pnpm 11 monorepo with four workspaces, strict TS ~6.0.3 project references, ESLint 10 flat config, Prettier, Husky + commitlint + lint-staged suppression grep, CLAUDE.md
- 0.2 ✅ 2026-08-19 — full dependency manifest at latest stable (Base UI as @base-ui/react 1.7, tw-animate-css added for shadcn), lockfile committed, audit clean via deepmerge-ts override
- 0.3 ✅ 2026-08-19 — frozen contracts in packages/core (runner, model, agent protocol with Zod + NDJSON codec, secrets, scheduling, workspace, persistence ports and entities, API and queue contracts, config/instance, typed errors) with 100 % coverage
- 0.4 ✅ 2026-08-19 — FakeWorkspaceRunner, FakeAgentModelProvider, in-memory repositories for all eight ports, FakeClock and runtime-assembled canaries under @agent-hangar/core/testing, 100 % coverage
- 0.5 ✅ 2026-08-19 — Prisma 7 schema, 0001_init migration with the partial unique index, prisma.config.ts over core config, adapter-pg client factory with fail-fast SELECT 1, test DB helpers, @db integration test
- 0.6 ✅ 2026-08-19 — parameterised compose (Postgres 18 + Redis 8), env.sh mirroring resolveInstance (contract-tested), workspace image base with non-root agent user and askpass helper, idempotent setup.sh, .env.example, stub scripts
