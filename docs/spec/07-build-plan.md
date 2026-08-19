# 07 — Phased Build Plan

Phases are sized for autonomous agent execution (one PR each, ≤ ~1 day of agent work). The system is demonstrable end-to-end at the end of **Phase 1** and every later phase keeps it demonstrable. Every phase ends with lint, typecheck, tests, and code review green; nothing merges with a known red gate.

| # | Phase | Demonstrable outcome |
|---|---|---|
| 0 | Foundation | Monorepo boots, infra up, CI green on an empty app |
| 1 | Walking skeleton | One chat, one container, one OpenAI round-trip, streamed to the browser |
| 2 | Chats complete | Tools, git with PAT, archive/restore, idle GC, cancel |
| 3 | Scheduled jobs | Cron → fresh workspace → run recorded, UI with runs |
| 4 | Settings & secrets hardening | Mask, redact, scrub, rotate; mutation gate on secrets |
| 5 | Conductor | Two parallel checkouts run side by side |
| 6 | Polish & release | UI per design doc, full E2E, README, deployment appendix |

---

## Phase 0 — Foundation

**Scope.** pnpm workspaces monorepo; TypeScript 7 strict base config (verify toolchain; fallback to TS 6 documented); ESLint flat config + Prettier + Husky/commitlint; Next.js 16 app shell with Tailwind v4 + shadcn (Base UI) initialised and design tokens from [10](10-ui-design.md); worker app skeleton (boots, connects to Redis/Postgres, logs, exits cleanly); `packages/core` with config schema (Zod, instance/port derivation), Prisma 7 schema from [02](02-data-model.md) + first migration + `PrismaClient` with `@prisma/adapter-pg`; `packages/agent-runtime` skeleton (`cli.js --version`); `infra/docker-compose.yml`, `infra/scripts/{env,setup,run,archive,doctor}.sh`, workspace `Dockerfile`; `.env.example`; CI workflow with all seven jobs (empty suites pass); README skeleton.

**Files touched.** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.husky/*`, `apps/web/**` (shell only), `apps/worker/src/main.ts`, `packages/core/{package.json,prisma/**,prisma.config.ts,src/config/**,src/persistence/client.ts}`, `packages/agent-runtime/src/cli.ts`, `infra/**`, `.conductor/settings.toml` (placeholder mapping), `.github/workflows/ci.yml`, `.env.example`, `README.md`.

**Tests that must pass.** Unit: config derivation (instance/ports/Conductor precedence, slugify). Integration: Prisma migrate + `SELECT 1` against compose Postgres; Redis ping. CI: all jobs green.

**DONE.** `git clone && pnpm setup && pnpm dev` opens an empty app shell at `http://localhost:3000`; `pnpm doctor` reports infra ✓, image ✓, secrets ✗ with instructions; CI green; toolchain decision (TS 7 vs 6) recorded in README.

## Phase 1 — Walking skeleton (one chat, one container, one round-trip)

**Scope.** `WorkspaceRunner` interface + `DockerWorkspaceRunner` (create/exec/destroy/health/list; snapshot stub returning git-less summary); `AgentModelProvider` + `OpenAIModelProvider` (Responses API streaming, text only + function tools wiring); agent protocol types + NDJSON codec; agent-runtime `turn` command with **no tools yet** (prompt in, streamed answer out); minimal `SecretsService` (encrypt/decrypt/set/reveal/status — hardening later) and Settings page with the two fields (save + last4); `POST /api/chats`, `GET /api/chats/:id`, `POST /messages`, SSE `events` route with Redis Streams replay; worker `run-turn` processor (ensure workspace → exec → persist → publish); chat UI: sidebar with chat list, New chat empty state, composer, transcript with streaming assistant text and status pill (per [10](10-ui-design.md), functional not final).

**Files touched.** `packages/core/src/{runner/**,model/**,agent-protocol/**,secrets/**,persistence/repositories/**,testing/**}`, `packages/agent-runtime/src/{cli.ts,loop.ts,protocol.ts}`, `infra/workspace/Dockerfile`, `apps/worker/src/{processors/run-turn.ts,queues.ts,events.ts}`, `apps/web/app/{(app)/layout.tsx,(app)/chats/**,(app)/settings/**,api/chats/**,api/settings/**}`, `apps/web/lib/{sse.ts,api.ts}`.

**Tests that must pass.** Unit: secrets roundtrip, protocol codec, OpenAI event mapping from fixtures, runner spec builder. Integration: `DockerWorkspaceRunner` create/exec/destroy/health; SSE replay; worker run-turn with `FakeAgentModelProvider` + real Docker. E2E: `settings-save-mask` (basic), `chat-create-run` (text-only variant).

**DONE.** With real keys in Settings: New chat → "Say hello and tell me the model you are" → answer streams into the browser from inside a container; `docker ps` shows `ah-ws-default-<id>`; the Turn, Messages, and Workspace rows exist; CI green.

## Phase 2 — Chats complete

**Scope.** Tools in agent-runtime (`run_shell`, `read_file`, `write_file`, `list_dir`) with confinement, truncation, timeout, env scrubbing, `GIT_ASKPASS`; repo clone/checkout in `prepare` with `workBranch` (`agent/<short-id>`) and `expectedHeadSha` check; `git.pushed` detection; tool-call cards in UI with live output; `ToolCallLog` persistence + `TOOL_SUMMARY` compaction; `snapshot()` real implementation; archive (destroy + snapshot hints) and restore (notice + recreate on next message); idle GC (`workspace-gc` scheduler, `list()` orphan reconcile); cancel turn (Redis command channel → `signal INT`); repo/branch picker backed by GitHub API via PAT; limits (maxSteps/maxTurnMs) with graceful stop; stalled-job recovery.

**Files touched.** `packages/agent-runtime/src/{tools/**,prepare.ts,loop.ts}`, `packages/core/src/{workspace/**,restore/**,runner/docker/snapshot.ts,github/**}`, `apps/worker/src/{processors/{run-turn,gc}.ts,commands.ts}`, `apps/web/app/{(app)/chats/**,api/{chats,turns,repos}/**}`, `apps/web/components/{tool-call-card,transcript,status-pill,repo-picker}/**`.

**Tests that must pass.** Unit: tools (confinement, truncation, scrubbing), lifecycle state machine, restore-context builder, GC selection, cancel path. Integration: two-workspace isolation, snapshot on real repo, GC destroys idle + reaps orphans, restore turn clones and checks out `workBranch`. E2E: `chat-create-run` (full), `chat-archive-restore`, `cancel-turn`, `settings-missing`.

**DONE.** A prompt that edits a file, runs tests, commits, and pushes a branch completes end-to-end against a real GitHub repo; archive → restore continues the conversation in a new container with the pushed branch checked out; after 30 idle minutes the container is gone and the next message brings it back; CI green.

## Phase 3 — Scheduled jobs

**Scope.** `ScheduledJob`/`JobRun` CRUD API; cron validation + `nextRunAt`; BullMQ Job Schedulers (`upsertJobScheduler`/`removeJobScheduler`, boot reconcile); worker `run-scheduled-job` processor (fresh JOB workspace → turn → record output → destroy in `finally`; overlap policy; manual trigger); Scheduled page: job list with next/last run and status, create/edit dialog (cron helper with human-readable preview, timezone), enable/disable toggle, Run now, runs table, run detail with transcript/tool calls and SSE while running.

**Files touched.** `packages/core/src/scheduling/**`, `apps/worker/src/{processors/run-scheduled-job.ts,scheduler-reconcile.ts}`, `apps/web/app/{(app)/scheduled/**,api/{jobs,runs}/**}`, `apps/web/components/{job-form,cron-preview,run-list,run-detail}/**`.

**Tests that must pass.** Unit: cron validation/DST/next-run, reconcile diff, overlap policy. Integration: scheduler upsert/remove/reconcile against Redis; processor creates and destroys a workspace per run with real Docker. E2E: `scheduled-job-run`.

**DONE.** A job on `* * * * *` produces a new `JobRun` each minute, each with its own container that no longer exists after the run; disabling stops it; Run now works; UI shows output; CI green.

## Phase 4 — Settings & secrets hardening

**Scope.** Master key management (0600 check, `keyVersion`, `pnpm secrets:rotate` re-encrypts rows); `Redactor` with exact values + shape patterns wired into pino, repositories, worker event path, and runtime; env scrubbing audit for `run_shell`; Settings UX (password inputs, Replace/Remove, "last updated", model id display, link to doctor); `/api/settings` never returns plaintext; request logging disabled for settings routes; `gitleaks` in CI + canary test (a known fake secret value must not appear in logs, DB dumps, or `docker history` of the image); Stryker configured with `break: 80` on `secrets`, `redaction`, `scheduling`, `workspace`, `agent-protocol`, runtime `tools`.

**Files touched.** `packages/core/src/{secrets/**,redaction/**,logging/**}`, `packages/agent-runtime/src/{tools/run-shell.ts,redact.ts}`, `apps/worker/src/logger.ts`, `apps/web/app/{(app)/settings/**,api/settings/**}`, `packages/core/stryker.config.mjs`, `packages/agent-runtime/stryker.config.mjs`, `.github/workflows/ci.yml`, `infra/scripts/rotate-key.sh`.

**Tests that must pass.** Unit: full secrets + redaction suites (see [06 §2](06-testing.md)); mutation score ≥ 80 on gated modules. E2E: `settings-save-mask` (full, including redaction in logs after a turn). CI: gitleaks + canary job.

**DONE.** Mutation gate enforced in CI and passing; the canary value is provably absent from every sink; Settings page matches [10 §5.4](10-ui-design.md); README security section written.

## Phase 5 — Conductor

**Scope.** Finalise `.conductor/settings.toml` (setup/run/archive, `run_mode = concurrent`); `env.sh` precedence for `CONDUCTOR_WORKSPACE_NAME`/`CONDUCTOR_PORT`; `archive.sh` tears down compose project + reaps instance containers; `doctor` prints instance, ports, DB; GC label filter verified per instance; README "Working with Conductor".

**Files touched.** `.conductor/settings.toml`, `infra/scripts/{env,setup,run,archive,doctor}.sh`, `packages/core/src/config/instance.ts`, `README.md`.

**Tests that must pass.** Unit: env precedence + slugify. Manual (documented checklist in PR): two Conductor workspaces on different branches — both stacks up, distinct ports/DBs, a chat in each, GC in one does not touch the other's containers; archive script leaves nothing behind.

**DONE.** Checklist executed and recorded in the PR; README section present.

## Phase 6 — Polish & release

**Scope.** UI to the design doc (tokens, typography, empty states, suggestion cards, keyboard shortcuts, toasts, loading/error states, responsive ≥ 1024 px desktop-first with usable 768 px); accessibility pass (focus rings, labels, contrast, reduced motion); full Playwright suite stable in CI; README complete (sections in [05 §7](05-local-dev.md)) including "Known gaps & plan to finish" (target: empty) and the deployment appendix ([08](08-deployment-discussion.md)); `docs/` refreshed to match reality; release tag `v1.0.0`.

**Files touched.** `apps/web/**` (styling, components), `apps/web/e2e/**`, `README.md`, `docs/**`.

**Tests that must pass.** Everything; Playwright on CI 3× without flake; Lighthouse a11y ≥ 95 on the three pages (manual, recorded).

**DONE.** A fresh clone on a clean macOS machine follows the README to a working chat, scheduled job, and masked settings; all gates green; tag pushed.

---

## Cross-cutting rules for every phase

- Branch per phase (`feat/phase-N-<slug>`), Conventional Commits, PR with checklist: scope ↔ this doc, tests listed above, screenshots for UI, "known gaps" delta.
- No dockerode import outside `packages/core/src/runner/docker/**` (lint-enforced from Phase 1).
- No secret value in any fixture, log, or test name; use documented canaries (`ghp_TESTCANARY…`, `sk-TESTCANARY…`).
- Any gap left at phase end goes into README "Known gaps & plan to finish" in the same PR.
