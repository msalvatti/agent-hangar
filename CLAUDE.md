# Agent Hangar — agent instructions

## What this is

Agent Hangar is a local-first web app where AI agents answer questions and perform coding tasks
against GitHub repositories inside isolated, disposable Docker workspaces. Cron-scheduled jobs run
in fresh workspaces, and Settings stores encrypted credentials (GitHub PAT, OpenAI API key).

## Stack & versions

| Concern    | Choice                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| Runtime    | Node 24 LTS · pnpm 11 workspaces (`packageManager` pinned)                                                    |
| Language   | TypeScript `~6.0.3` strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) |
| Web        | Next.js 16 App Router · React 19 · Tailwind v4 · shadcn (Base UI)                                             |
| Data       | Postgres 18 · Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg`)                                     |
| Queues     | Redis 8 · BullMQ 6 (Redis Streams for turn events)                                                            |
| Containers | dockerode 5 (only under `packages/core/src/runner/docker/`)                                                   |
| Model      | openai SDK (Responses API)                                                                                    |
| Tests      | Vitest 4 (coverage v8) · Testing Library · Playwright · Stryker 10                                            |
| Tooling    | ESLint 10 flat config · Prettier 3 · Husky · commitlint · lint-staged                                         |

## Commands (root scripts)

| Script                                  | Purpose                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm setup`                            | First run: install, `.env.local`, master key, compose up, migrate, image |
| `pnpm dev` / `pnpm start`               | Web + worker with `.env.local` loaded                                    |
| `pnpm build`                            | Build every workspace                                                    |
| `pnpm lint` / `pnpm lint:fix`           | ESLint over the monorepo                                                 |
| `pnpm format` / `format:check`          | Prettier                                                                 |
| `pnpm typecheck`                        | `tsc -b` over all project references                                     |
| `pnpm test`                             | Unit suites of every workspace (100 % coverage thresholds)               |
| `pnpm test:integration`                 | `@db` / `@redis` / `@docker` suites against the compose instance         |
| `pnpm test:e2e`                         | Playwright                                                               |
| `pnpm test:mutation`                    | Stryker                                                                  |
| `pnpm infra:up/down/reset`              | docker compose for the current instance                                  |
| `pnpm infra:image`                      | Build the workspace image                                                |
| `pnpm db:generate/migrate/studio/prune` | Prisma                                                                   |
| `pnpm doctor`                           | Environment diagnostics                                                  |
| `pnpm ws:list` / `ws:reap`              | Workspace containers of this instance                                    |

Every checkout is an _instance_: `AH_INSTANCE` (default `default`) and `AH_PORT_BASE` (default
`3000`) derive ports, database name, compose project and container prefix. Conductor sets them
from `CONDUCTOR_WORKSPACE_NAME` / `CONDUCTOR_PORT`.

## Ownership map (lane → owned paths)

Work is organised in lanes (`docs/tasks/`). An agent may create or edit files only in the owned
paths of its lane, plus its own test files and its own row in the planning dashboards. Touching
another lane's path gets the PR rejected.

| Lane    | Owned paths                                                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0      | everything (foundation: monorepo, contracts, doubles, Prisma, infra base, app shells, CI)                                                                                        |
| W1-A    | `packages/core/src/secrets/**`, `packages/core/src/redaction/**`, `packages/core/src/logging/**`                                                                                 |
| W1-B 🐳 | `packages/core/src/runner/docker/**`, `infra/workspace/**`, `pnpm infra:image`                                                                                                   |
| W1-C    | `packages/core/src/model/openai/**`, `packages/core/src/model/registry.ts`, `packages/core/fixtures/openai/*`                                                                    |
| W1-D    | `packages/agent-runtime/**` (Dockerfile `COPY` lines are applied by the orchestrator)                                                                                            |
| W1-E    | `packages/core/src/persistence/repositories/**`, `packages/core/src/persistence/testing/db.ts`                                                                                   |
| W1-F    | `packages/core/src/scheduling/**`, `packages/core/src/workspace/**`, `packages/core/src/restore/**`, `packages/core/src/queues/{queues,schedulers}.ts`                           |
| W1-G    | `apps/web/src/features/shell/**`, `apps/web/src/features/chats/**`, `apps/web/src/shared/transcript/**`, `app/(app)/chats/**`, `app/(app)/layout.tsx`, `apps/web/src/mocks/**`   |
| W1-H    | `apps/web/src/features/scheduled/**`, `apps/web/src/features/settings/**`, `app/(app)/scheduled/**`, `app/(app)/settings/page.tsx`, `apps/web/src/mocks/{scheduled,settings}.ts` |
| W1-I    | `infra/scripts/{setup,run,archive,doctor,rotate-key}.sh`, `.conductor/settings.toml`, `infra/docker-compose.yml`, `.env.example`, root `package.json` scripts block              |
| W2-A    | `apps/web/app/api/**`, `apps/web/src/server/**`                                                                                                                                  |
| W2-B 🐳 | `apps/worker/src/**`                                                                                                                                                             |
| W2-C    | `apps/web/e2e/**`, `infra/test/gitserver/**`, `playwright.config.ts` projects, CI `e2e` job body                                                                                 |
| W3-A 🐳 | any path (single agent; nothing else runs in `apps/**` concurrently)                                                                                                             |
| W3-B    | `README.md`, `docs/**`                                                                                                                                                           |
| W4-A    | `packages/core` tests + Stryker config                                                                                                                                           |
| W4-B    | `packages/agent-runtime` tests + Stryker config                                                                                                                                  |

Shared files are append-only, one line per lane: each package's `vitest.config.ts`
`coverage.include`, `packages/core/package.json` `exports`, the per-folder barrels re-exported by
`packages/core/src/index.ts` (the root barrel itself is frozen), `apps/web/src/mocks/handlers.ts`.
Contracts in `packages/core` are frozen after W0; changes are additive, one-file PRs.

## Gates before any PR

1. `pnpm lint && pnpm format:check && pnpm typecheck` — exit 0.
2. `pnpm test -- --coverage` — green, **100 % lines / branches / functions / statements** on every
   path listed in the package's `coverage.include` (thresholds are enforced by the Vitest config;
   never lower them).
3. Integration suites (`@db`, `@redis`, `@docker`) green when the lane is tagged for them; they
   fail loudly when `CI=1` and the resource is missing, and print an instruction locally.
4. Code review (`/bymax-quality:code-review full`) and security review with **zero** open findings.
5. Conventional Commit messages, PR opened against `main` (PR-only branch).

Memory-safe testing on a shared machine: `maxWorkers: 3` in every Vitest config, one suite at a
time, `NODE_OPTIONS=--max-old-space-size=4096`.

## Rules

- **No new dependencies inside a lane.** The manifest is complete; a lane that needs a package
  stops and reports so the orchestrator adds it on `main` first.
- **No `enum`** — string-literal unions (Prisma enums live only in `schema.prisma` and are mapped
  at the repository boundary).
- **No suppression comments** (`eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
  `istanbul ignore`, `v8 ignore`), no `any`, no `--no-verify`. Fix the root cause or the rule.
- **Zod at every process boundary**; types derived with `z.infer` from the schema.
- **JSDoc on every export** and a documentation header per file; a header and a block comment on
  every `it()` in test files.
- **English only** in code, comments, commits, PRs, issues. Comments are timeless — no references
  to lanes or tasks in shipped code.
- **Conventional Commits**, no AI-attribution trailers anywhere (commits, PR titles, bodies,
  comments).
- **Secrets:** GitHub PAT and OpenAI key exist in plaintext only in the `PUT /api/settings/:key`
  body, in worker memory while a turn is prepared, and in the container env. Never in the repo,
  image layers, logs, Postgres (ciphertext only), API responses, UI, error messages, fixtures or
  PR bodies. Tests use the canaries from `packages/core/src/testing/canaries.ts`
  (`GITHUB_CANARY`, `OPENAI_CANARY`) — the only secret-shaped strings allowed anywhere.
- `dockerode` only under `packages/core/src/runner/docker/**`; `node:crypto` (never bare `crypto`),
  `crypto.randomUUID()` (never `uuid`/`nanoid`).
- `docs/` is hand-authored Markdown and is excluded from Prettier; edit only your own rows.

## Pointers

- Specification: `docs/spec/01-overview.md` … `docs/spec/10-ui-design.md`
- Execution plan and status dashboard: `docs/plan.md`
- Lane task files with self-contained agent prompts: `docs/tasks/README.md`
