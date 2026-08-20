# Wave 3 — W3-A 🐳 End-to-end wiring & stabilisation

| | |
|---|---|
| **Lane** | W3-A 🐳 (single agent, sequential — touches many paths; the only Docker-integration lane running) |
| **Status** | 🔄 In Progress |
| **Progress** | 3/6 tasks |
| **Branch** | `feat/w3a-integration` |
| **Owned paths** | any path (single agent; nothing else runs in `apps/**` concurrently — W3-B owns `README.md` and `docs/**` in parallel and only its own lines of `docs/plan.md` §12 / `docs/tasks/README.md` are touched here) |
| **Depends on** | W2-A, W2-B, W2-C merged (hence every Wave 1 lane and W0) |
| **Unblocks** | W4-A, W4-B (mutation testing on stable code) |
| **Source** | [docs/plan.md §8](../plan.md) (W3-A) · spec [01 §5](../spec/01-overview.md) [06 §4](../spec/06-testing.md) [10 §10](../spec/10-ui-design.md) [05 §4](../spec/05-local-dev.md) |
| **Last updated** | 2026-08-20 |

**Where this lane stands on 2026-08-20.** Five of its six tasks are open. Task 3A.4 shipped on its own branch (`feat/smoke-openai`) rather than on the lane branch, because the real-model smoke has no dependency on the rest of the lane in practice: it drives the running instance through the public API and touches only `infra/scripts/lib/**` and the root manifest. The other five are untouched and no lane branch exists yet. Nothing blocks it — W2-A, W2-B and W2-C are all merged. What has changed underneath it is the backlog: besides these six tasks the lane was routed every finding no lane owned, and eleven of those were closed by orchestrator fix pull requests rather than by the lane (R4, R5, R6, R17 and R18 by PR #46; R12, R13 and R28 by PR #60; R33, R34 and R35 by PR #61), with R10 closed halfway by PR #60. [plan §14](../plan.md) is the live list and every open row in it is routed here; [plan §12](../plan.md) records what closed and by what, and carries the count so this file does not have to keep a second copy of it. Read both before planning the work; the tasks below were written when none of it had happened.

## Context

Every feature exists in isolation: the web API (W2-A), the worker (W2-B) and the E2E specs (W2-C) were each built against fakes and contracts. This lane is where the product is proven as one system. It widens the coverage scope of every package from "owned paths" to `src/**`, wires the small seams that no single lane owned (health ↔ UI, cancel, restore notice, settings gate, worker heartbeat), runs the Playwright suite against real Docker + Postgres + Redis until it is stable, performs one real OpenAI turn, polishes the UI on real data, and gets CI fully green. When this PR merges, success criteria S1–S6 and S8 of spec 01 §5 are verified with evidence, and Wave 4 can mutate stable code.

Quality bar unchanged from W0: TypeScript strict, zero `any`, zero suppression comments, no `enum` in TS, JSDoc on every export + file header, English only, test headers and a block comment on every `it()`, **100 % coverage on lines/branches/functions/statements** for every package's `src/**` — now the whole package, not a subset.

## Rules of this lane

1. **Single agent, any path** — but stay minimal: touch a file only to wire, stabilise or polish. No refactors for taste, no renames of contract names, no new features beyond the seams listed in plan §8.
2. **No new dependencies.** Everything needed (Playwright, Testing Library, MSW, tsx, Lighthouse via `pnpm dlx`) is already installed or ephemeral. If something is truly missing, stop and report — the orchestrator adds it in a `chore(deps)` PR first.
3. **Flakiness is fixed at the root cause**, never by raising `retries`, widening timeouts or adding sleeps. Playwright runs in this lane use `--retries=0`; CI keeps the config W2-C set.
4. **Docker is a shared resource** — this is the only 🐳 lane running. Use `AH_INSTANCE=test` (compose project `agent-hangar-test`, ports 4000–4002 unless `AH_PORT_BASE` says otherwise) for the E2E stack and `AH_INSTANCE=w3a` for manual dev, so the orchestrator's `default` stack is never touched.
5. **The real OpenAI smoke uses the user's own key entered in Settings** — never an env var, never in CI, never committed anywhere. Canaries from `@agent-hangar/core/testing` are the only secret-shaped strings allowed in tests.
6. **No `enum`**, no suppression comments, JSDoc on exports + file headers, test header + `it()` comments, English everywhere, Conventional Commits, no AI-attribution trailers. Branch `feat/w3a-integration`. One PR at the end (T3A.6).
7. Contract changes (e.g. `healthResponse` gaining a `worker` field) are **additive** and Zod-first (type derived with `z.infer`); list each one in the PR under "Contract changes" even though this lane may edit `packages/core` directly.

## Reference docs

- [docs/plan.md](../plan.md) § "8. Wave 3" (W3-A), § "3. Parallelism rules" items 3 and 6, § "11. Orchestrator protocol", § "12. Status dashboard"
- [spec 01 — Overview](../spec/01-overview.md) § "5. Success criteria" (S1–S8), § "8. Risks" (R2–R5)
- [spec 03 — Interfaces](../spec/03-interfaces.md) § "4. HTTP API" (`/api/health`, `/api/turns/:id/cancel`), § "5. Queues"
- [spec 04 — Flows](../spec/04-flows.md) (a) turn, (d) settings
- [spec 05 — Local dev](../spec/05-local-dev.md) § "3. Environment model", § "4. First-run experience" (`pnpm doctor` table)
- [spec 06 — Testing](../spec/06-testing.md) § "4. Playwright E2E" (the six specs), § "6. CI pipeline"
- [spec 10 — UI design](../spec/10-ui-design.md) § "4. Screens" (env pill, status pill + Stop, archived banner, secrets-missing notice), § "6. States", § "8. Accessibility", § "9. Responsive", § "10. Pre-delivery checklist"

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 3A.1 | Widen `coverage.include` to `src/**` in every package; close coverage gaps | ✅ | P0 | M | — |
| 3A.2 | Wire remaining seams: health banner + env pill, cancel, restore notice, settings gate, repo hosts, worker heartbeat | ✅ | P0 | L | 3A.1 |
| 3A.3 | Playwright suite green 3× consecutively on the real stack; fix flakiness at the root | 📋 | P0 | L | 3A.2 |
| 3A.4 | Real OpenAI smoke: `pnpm smoke:openai` (one turn with `gpt-5.6-sol`, list files + write a file) | ✅ | P0 | S | 3A.3 |
| 3A.5 | UI polish pass against spec 10 §10 on real data; Lighthouse a11y ≥ 95; `pnpm doctor` final | 📋 | P1 | M | 3A.3 |
| 3A.6 | CI all jobs green; close-out PR with S1–S6, S8 evidence | 📋 | P0 | S | 3A.1–3A.5 |

---

## Task 3A.1 — Widen `coverage.include` to `src/**` in every package; close coverage gaps

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** During Waves 1–2 every package's `vitest.config.ts` listed only the paths its lanes owned under `coverage.include`. Widen the four configs to `src/**`, run each suite with coverage, and bring every package back to 100 % on all four metrics by adding behaviour tests (never by excluding files). Decide once, with evidence, whether `apps/web/src/shared/ui/**` (shadcn-generated components) stays excluded.

**Acceptance criteria**
- [ ] `packages/core`, `packages/agent-runtime`, `apps/web`, `apps/worker` `vitest.config.ts` each have `coverage.include: ['src/**']` (web additionally keeps `app/**` route handlers included if W2-A placed them outside `src/`), thresholds 100/100/100/100 unchanged
- [ ] `coverage.exclude` contains only: test files, pure type files (`**/types.ts`, `*.d.ts`), barrels that only re-export (`index.ts`), `src/persistence/generated/**`, and — if the decision below is "exclude" — `apps/web/src/shared/ui/**`
- [ ] Decision on `src/shared/ui/**` recorded in the completion log and PR body: include (and test every variant/prop branch) **only if** it costs ≤ 1 h; otherwise keep the exclusion with a one-paragraph rationale (generated vendor code, covered by the consuming components' tests) for W3-B to paste into README "Testing"
- [ ] `pnpm test -- --coverage` passes in all four packages at 100 %; no new `/* v8 ignore */` or `istanbul ignore` comments anywhere (`grep -r "v8 ignore\|istanbul ignore" --include=*.ts --include=*.tsx apps packages` returns nothing)
- [ ] New tests assert behaviour (outputs, calls, rendered text/roles), with file header + `it()` comments

**Files to modify**
`packages/core/vitest.config.ts`, `packages/agent-runtime/vitest.config.ts`, `apps/web/vitest.config.ts`, `apps/worker/vitest.config.ts`, plus new/extended `*.test.ts(x)` files next to any uncovered source.

**Agent prompt**

````
You are a senior full-stack TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 workspaces · TypeScript ~6.0.3 strict · Node 24 · Next.js 16.3 App Router + React 19.2 · Tailwind v4 + shadcn (Base UI) · Postgres 18 + Prisma 7.9 · Redis 8 + BullMQ 6 · dockerode 5 · openai SDK 7.5 · Vitest 4 (@vitest/coverage-v8) · Playwright 1.62 · Stryker 10.
Branch feat/w3a-integration (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W3-A 🐳 (End-to-end wiring & stabilisation) — Task 3A.1 of 6 (FIRST)

PRECONDITIONS
- W2-A, W2-B and W2-C are merged into main; your worktree is branched from the latest main.
- Nothing else runs in apps/** concurrently; W3-B edits only README.md and docs/** in parallel.
- Every package has a vitest.config.ts whose coverage.include lists a subset of src/**.

REQUIRED READING (only these):
- CLAUDE.md (gates, rules)
- docs/plan.md § "8. Wave 3" (W3-A bullet) and § "3. Parallelism rules" item 2
- docs/spec/06-testing.md § "1. Layers", § "2. Unit tests"
- the four vitest.config.ts files and apps/web/components.json (to see where shadcn generates into)

TASK
Widen every package's coverage scope to the whole package and restore 100 % on all four metrics by adding behaviour tests. Decide with evidence whether apps/web/src/shared/ui/** is included.

DELIVERABLES

1. In each of packages/core, packages/agent-runtime, apps/web, apps/worker: set `coverage.include: ['src/**']` (apps/web: also include `app/api/**` if W2-A's route handlers live under app/ rather than src/ — check `ls apps/web/app/api`). Keep thresholds at 100/100/100/100. Trim `coverage.exclude` to: `**/*.test.ts`, `**/*.test.tsx`, `**/*.integration.test.ts` (only if integration files are not part of the default run — check how W1-E/W2-B gated them), `**/types.ts`, `**/*.d.ts`, `**/index.ts` barrels that contain only `export … from`, `src/persistence/generated/**`, `src/testing/**` is NOT excluded (it is tested code). Do not exclude anything else.
2. Run `pnpm --filter <pkg> test -- --coverage` in each package and list the uncovered files/lines in your working notes. For each gap write tests that assert behaviour: route handlers with in-memory repositories and a fake queue (validation, status transitions, error mapping), worker processors with FakeWorkspaceRunner + FakeAgentModelProvider, UI components with Testing Library (text, roles, disabled states, keyboard), hooks with fake EventSource/timers (`vi.useFakeTimers()`), pure functions with tables. Tests are co-located `*.test.ts(x)` with a file header and a block comment on every it(). Use canaries from `@agent-hangar/core/testing` whenever a secret-shaped string is needed.
3. `apps/web/src/shared/ui/**` decision: time-box 1 h. Run coverage with the exclusion removed; if the remaining gaps are variant/prop branches of shadcn primitives that you can cover with small render tables (e.g. every `variant`/`size` of Button, open/closed of Dialog, checked/unchecked of Switch) within the hour, include it. Otherwise keep `src/shared/ui/**` excluded and write a 3–5 line rationale (generated vendor code from the shadcn CLI; behaviour exercised through the feature components' tests; a11y checked by Lighthouse in T3A.5) in the completion-log entry — W3-B copies it into README "Testing".
4. Where a file is genuinely unreachable (e.g. a 5-line `main.ts` that only calls `boot()`), make it smaller rather than excluding it, or test it with an injected entrypoint. No `v8 ignore` / `istanbul ignore` comments.

Constraints:
- Follow /bymax-workflow:standards: TS strict, JSDoc + file headers, English, no `enum`, no suppression comments, it() comments.
- Do not change behaviour while adding tests; if a test reveals a bug, fix it in the smallest possible change and mention it in the completion log.
- No new dependencies.

Verification:
- `pnpm test -- --coverage` — every package green with 100/100/100/100 and `coverage.include: ['src/**']`
- `grep -rn "v8 ignore\|istanbul ignore\|eslint-disable\|@ts-ignore\|@ts-expect-error" apps packages --include=*.ts --include=*.tsx` — no output
- `pnpm lint && pnpm typecheck` — exit 0

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-3a-integration.md (task index row and task block)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/6 tasks`)
4. Append a completion log entry at the end of the file: `- 3A.1 ✅ <YYYY-MM-DD> — <one-line summary incl. the src/shared/ui decision>`
5. Commit: `test: widen coverage scope to src/** in every package and close gaps`
````

---

## Task 3A.2 — Wire remaining seams: health banner + env pill, cancel, restore notice, settings gate, repo hosts, worker heartbeat

**Status:** ✅ Done · **Priority:** P0 · **Size:** L · **Depends on:** 3A.1

**Description.** Connect the small cross-lane seams that no Wave 1/2 lane owned end to end, as listed in plan §8: the sidebar environment pill and an "infrastructure down / workspace image missing" notice fed by `/api/health`; the **Stop** button calling `POST /api/turns/:id/cancel`; the system notice after a restore; the secrets-missing gate that replaces the composer; `ALLOWED_REPO_HOSTS` / local test git server support **if** W2-C requested it; and a worker heartbeat key in Redis so `/api/health` can report whether a worker is alive.

**Acceptance criteria**
- [x] `/api/health` response (Zod `healthResponse` in `packages/core/src/api/contracts.ts`, additive) includes `db`, `redis`, `docker`, `image: { present: boolean; name: string }`, `worker: { alive: boolean; lastSeenAt?: string }`, `workspaces: { live: number; byKind: Record<'chat'|'job', number> }` (keep existing field names if W2-A already defined some — extend, do not rename)
- [x] Worker writes `ah:<instance>:worker:heartbeat` (value = ISO timestamp, `EX 30`) every 10 s from boot until shutdown; tested with a fake Redis and fake timers; key is deleted on graceful shutdown
- [x] Sidebar env pill shows `docker ✓` / `docker ✗` (and destructive style when db/redis/worker down) from `/api/health`, polled every 15 s with backoff on error; click opens the doctor-details dialog listing each check and the fix command
- [x] When `image.present === false` or `docker`/`worker` is down, the composer area shows an inline notice card naming the dependency and the command (`pnpm infra:image`, `pnpm doctor`); Send is disabled
- [x] When `GET /api/settings` reports a missing `GITHUB_PAT` or `OPENAI_API_KEY`, the composer is replaced by the notice *"Add your GitHub token and OpenAI key in Settings to start."* with a button to `/settings`; no chat/turn is created (tested at component level and in the route — `POST /api/chats/:id/messages` returns 409 with `code: 'settings_missing'` while secrets are absent)
- [x] Header **Stop** button (visible while status is Queued/Preparing/Running) calls `POST /api/turns/:id/cancel`, shows a pending state, and the status pill reaches Cancelled from the SSE `turn.cancelled` event; route → Redis command channel → worker → `runner.signal(handle, execRef, 'INT')` verified by an integration test `@redis` (web ↔ worker command round trip with FakeWorkspaceRunner)
- [x] After a restore turn, the transcript renders the `SystemNotice` for the restoration notice emitted by the runtime (`prepare.done` with `restored: true` or the `system` message W1-F's restore context produces) — whichever the existing contract carries; tested
- [x] If `docs/tasks/wave-2c-e2e.md` (or the W2-C PR body) lists a contract change request for `ALLOWED_REPO_HOSTS` / local git server host: config schema gains `ALLOWED_REPO_HOSTS` (comma-separated, default `github.com`), repo URL validation in the create-chat route and the runtime `prepare` accept hosts in that list, `.env.example` documents it; E2E test env sets it to include the gitserver host. If W2-C did not request it, record "not requested" in the completion log and skip.
- [x] 100 % coverage maintained in every touched package; `pnpm dev` with `AGENT_MODEL_PROVIDER=fake` shows the pill, the gate, the Stop button working end to end

**Files to create/modify**
`packages/core/src/api/contracts.ts` (+ test), `packages/core/src/config/schema.ts` (+ test, only if repo hosts requested), `apps/worker/src/heartbeat.ts` (+ test), `apps/worker/src/main.ts`/`container.ts` wiring, `apps/web/app/api/health/route.ts` (+ test), `apps/web/app/api/chats/[id]/messages/route.ts` (+ test), `apps/web/src/features/shell/**` (env pill, doctor dialog), `apps/web/src/features/chats/**` (composer gate, infra notice, Stop button, restore notice), `apps/web/src/mocks/**` (MSW handlers for the new health fields), `.env.example`.

**Agent prompt**

````
You are a senior full-stack TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Next.js 16.3 App Router + React 19.2 · Tailwind v4 + shadcn (Base UI) · Postgres 18 + Prisma 7.9 · Redis 8 + BullMQ 6 · ioredis 6 · Vitest 4 + Testing Library + MSW 2.
Branch feat/w3a-integration (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W3-A 🐳 — Task 3A.2 of 6 (MIDDLE)

PRECONDITIONS
- Task 3A.1 done: every package covers src/** at 100 %.
- W2-A routes, W2-B worker processors and W1-G/H UI components exist; read their current shapes before editing.

REQUIRED READING (only these):
- docs/plan.md § "8. Wave 3" (W3-A bullet — the seam list)
- docs/spec/03-interfaces.md § "4. HTTP API" (rows `/api/health`, `/api/turns/:id/cancel`, `/api/settings`), § "5. Queues" (command channel paragraph)
- docs/spec/10-ui-design.md § "3. App shell" (sidebar footer env pill), § "4.2 Chat" (status pill + Stop, archived banner, restore notice), § "4.1 Home" (secrets-missing notice text), § "6. States" (Offline / infra down row)
- docs/spec/04-flows.md (a) turn — the cancel branch
- packages/core/src/api/contracts.ts, packages/core/src/queues/contracts.ts, apps/web/app/api/health/route.ts, apps/worker/src/commands.ts, apps/web/src/features/chats/** barrel, apps/web/src/features/shell/** barrel
- docs/tasks/wave-2c-e2e.md (completion log / contract change requests only) — to know whether ALLOWED_REPO_HOSTS was requested

TASK
Wire the cross-lane seams end to end so the UI reflects real infrastructure state, a running turn can be stopped, a restored chat tells the user what happened, and nothing starts without secrets. Add a worker heartbeat so health can report a live worker.

DELIVERABLES

1. Contract (additive, Zod-first): extend `healthResponse` in packages/core/src/api/contracts.ts with `image: { present, name }`, `worker: { alive, lastSeenAt? }`, `workspaces: { live, byKind }` — keep any field W2-A already defined. Add `workerHeartbeatKey(instance)` → `ah:<instance>:worker:heartbeat` next to the other key helpers in packages/core/src/queues/contracts.ts. Tests: schema accepts/rejects; key helper output pinned verbatim.
2. Worker: `apps/worker/src/heartbeat.ts` exporting `startHeartbeat({ redis, key, intervalMs = 10_000, ttlSeconds = 30, clock })` → `{ stop(): Promise<void> }` that SETs the key with `EX ttlSeconds` immediately and every interval, and DELs it on stop. Wire into apps/worker/src/main.ts after boot; stop it first in graceful shutdown. Tests with a fake Redis and `vi.useFakeTimers()`: first write immediate, interval writes, stop deletes and clears the timer, a failing SET is logged and does not throw.
3. Health route: apps/web/app/api/health/route.ts fills the new fields — `image.present` via the runner's image check (or a dockerode `getImage(name).inspect()` behind the existing server container — dockerode stays in packages/core/src/runner/docker/**; expose `imagePresent(name)` from the runner if it is not already exposed), `worker.alive` = heartbeat key exists (`lastSeenAt` = its value), `workspaces` from the Workspace repository (`listLive` grouped by kind). Route test with fakes covers every field and the degraded paths (docker unreachable → `docker: false`, image missing, no heartbeat).
4. UI — shell: the sidebar footer env pill reads `/api/health` every 15 s (pause when `document.hidden`; exponential backoff to 60 s on errors), renders `docker ✓` / `docker ✗`, switches to the destructive token when db/redis/worker/docker is down, and opens a Dialog "Environment" listing each check with ✓/✗ and the fix command (`pnpm infra:up`, `pnpm infra:image`, `pnpm dev` for the worker, `pnpm doctor`). Expose the health state through a small context/hook in features/shell so features/chats can read it without a cross-feature import (put the hook in `apps/web/src/shared/health/**` — zero domain imports — if shell and chats both need it).
5. UI — chats composer gates (in order of precedence): (a) secrets missing → the notice card with the exact spec text and a Button linking to /settings; (b) infra down or image missing → an inline notice naming the dependency and the command; (c) otherwise the composer. Route guard: `POST /api/chats/:id/messages` (and chat creation if it enqueues a turn) returns 409 `{ code: 'settings_missing' }` while either secret is absent — tested.
6. UI — Stop: header button visible for Queued/Preparing/Running, `aria-label="Stop turn"`, calls `POST /api/turns/:id/cancel` via apiFetch, disabled + spinner while pending, toast on error; status reaches Cancelled from the SSE `turn.cancelled` event (reducer already handles it — verify, add a test if not). Integration test `@redis` in apps/web or apps/worker (whichever already has the command-channel test scaffold): publish on the command channel via the route handler → worker `commands.ts` subscriber invokes `runner.signal(handle, execRef, 'INT')` on a FakeWorkspaceRunner.
7. UI — restore notice: after a restore, render the SystemNotice ("This chat was restored in a fresh workspace…" — use the text the restore-context builder or runtime already emits; do not invent a second wording) at the right position in the transcript; test with a scripted event stream.
8. ALLOWED_REPO_HOSTS — only if W2-C requested it (check docs/tasks/wave-2c-e2e.md completion log and `gh pr view <W2-C PR> --json body`): add to packages/core/src/config/schema.ts (string, default `github.com`, parsed to a `readonly string[]` helper `allowedRepoHosts(config)`), validate the repo URL host in the chat-creation route and in packages/agent-runtime `prepare.ts` (reject with a clear ProtocolError otherwise), document in `.env.example`, set it in the Playwright env to include the gitserver host. Tests for the parser, the route rejection, and the runtime rejection. If not requested: skip and write "ALLOWED_REPO_HOSTS: not requested by W2-C" in the completion log.
9. MSW handlers (apps/web/src/mocks/**) updated so `NEXT_PUBLIC_API_MOCK=1` still renders the pill, the gate and the Stop flow.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments). 100 % coverage in every touched package.
- Cross-feature imports remain banned in apps/web (shared/** is the meeting point).
- dockerode stays inside packages/core/src/runner/docker/**.
- Additive contract changes only; list them in the PR body.

Verification:
- `pnpm test -- --coverage` — all packages green at 100 %
- `pnpm test:integration` (with the test stack up: `AH_INSTANCE=test pnpm infra:up`) — `@redis` cancel round-trip green
- `AH_INSTANCE=w3a pnpm dev` with `AGENT_MODEL_PROVIDER=fake`: pill shows ✓; stop the worker → pill turns destructive within 30 s and composer shows the worker notice; remove a secret in Settings → composer replaced by the settings notice; start a scripted long turn → Stop → Cancelled in < 5 s
- `pnpm lint && pnpm typecheck` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-3a-integration.md; append `- 3A.2 ✅ <date> — <summary incl. ALLOWED_REPO_HOSTS decision>`; commit `feat: wire health, cancel, restore notice, settings gate and worker heartbeat end to end` (split into 2–3 commits by seam if the diff is large).
````

---

## Task 3A.3 — Playwright suite green 3× consecutively on the real stack; fix flakiness at the root

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** L · **Depends on:** 3A.2

**Description.** Run the six E2E specs authored by W2-C against the real stack — Docker workspaces, Postgres and Redis on `AH_INSTANCE=test`, the local git server container, MSW for the GitHub API, `AGENT_MODEL_PROVIDER=fake` — and make them pass three times in a row with `--retries=0`. Every failure is diagnosed to a root cause (ordering, missing wait on a real event, DB reset, port, image) and fixed in product or harness code, never hidden by retries or sleeps.

**Acceptance criteria**
- [ ] `pnpm test:e2e` brings up (or verifies) the test stack: `AH_INSTANCE=test` compose project, migrations applied, workspace image present, gitserver container up, web + worker started with `AGENT_MODEL_PROVIDER=fake` and `NEXT_PUBLIC_API_MOCK=0`; tears down what it started
- [ ] All six specs (`chat-create-run`, `chat-archive-restore`, `scheduled-job-run`, `settings-save-mask`, `settings-missing`, `cancel-turn`) pass 3× consecutively with `--retries=0` (`for i in 1 2 3; do pnpm test:e2e -- --retries=0 || exit 1; done`) — the three run logs are summarised in the completion log (duration per run)
- [ ] Each flake found is documented in the completion log as `symptom → root cause → fix (file)`; no `test.slow()`, no increased `expect` timeouts beyond the harness default, no `waitForTimeout`
- [ ] After the runs: `docker ps --filter label=ah.instance=test` shows no workspace containers; `/api/health` on the test instance reports `workspaces.live = 0`
- [ ] `playwright.config.ts` keeps `retries: process.env.CI ? 1 : 0`, `trace: 'on-first-retry'`, chromium only; the CI `e2e` job runs the same command

**Files to modify**
`apps/web/e2e/**` (fixtures/helpers only where a root cause lives there), `apps/web/playwright.config.ts` (only if needed), `infra/scripts/*.sh` / root `test:e2e` wiring (if the harness boot order is the cause), any product file whose race the specs expose (worker event ordering, SSE replay, DB reset helper, GC timing).

**Agent prompt**

````
You are a senior full-stack engineer stabilising the Agent Hangar project end to end.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: Playwright 1.62 (chromium) · Next.js 16.3 · Node 24 worker · Docker Desktop · Postgres 18 · Redis 8 · local git server container (infra/test/gitserver) · MSW 2 for the GitHub API in test mode · FakeAgentModelProvider (`AGENT_MODEL_PROVIDER=fake`).
Branch feat/w3a-integration (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W3-A 🐳 — Task 3A.3 of 6 (MIDDLE)

PRECONDITIONS
- Tasks 3A.1–3A.2 done. W2-C's harness and six specs exist under apps/web/e2e/**; they were validated only against the mocked UI.
- Docker Desktop running; you are the only Docker-integration lane. Use AH_INSTANCE=test (never `default`).

REQUIRED READING (only these):
- docs/spec/06-testing.md § "4. Playwright E2E" (stack + the six-row table — these are the assertions)
- docs/tasks/wave-2c-e2e.md (how the harness boots/tears down; its completion log)
- apps/web/e2e/** (fixtures, helpers, the six specs), apps/web/playwright.config.ts, root package.json `test:e2e` script
- docs/plan.md § "3. Parallelism rules" item 3

TASK
Run the E2E suite for real until it is green three times in a row with retries disabled, and fix every flake at its root cause.

DELIVERABLES

1. Harness check: `pnpm test:e2e` must (a) resolve env for AH_INSTANCE=test via infra/scripts/env.sh, (b) `docker compose … up -d --wait` the test project, (c) apply migrations, (d) ensure the workspace image and the gitserver container are present (build/start if not), (e) start web + worker with `AGENT_MODEL_PROVIDER=fake`, `NEXT_PUBLIC_API_MOCK=0`, `ALLOWED_REPO_HOSTS` including the gitserver host if 3A.2 added it, (f) run Playwright, (g) stop what it started. If any step is missing or order-dependent, fix the wiring (root `test:e2e` → the harness script W2-C owns) rather than documenting a manual step.
2. Run: `for i in 1 2 3; do pnpm test:e2e -- --retries=0 || break; done`. On any failure: read the trace/video, reproduce, find the root cause, fix it, then restart the count from 1. Typical roots to look for: asserting UI before the SSE event that drives it (use the event/`aria-live` text, not a timer); DB reset racing a still-running worker job (drain queues / wait for `workspaces.live = 0` via /api/health in the fixture); scheduled-job spec relying on wall-clock cron (use "Run now" and poll the runs table); GC interval vs archive assertion (assert through `/api/health` counters, which 3A.2 made accurate); ports from a previous run (env.sh + `--wait`); image not rebuilt after runtime changes (harness rebuilds when `packages/agent-runtime/dist` is newer than the image label).
3. Forbidden fixes: raising `retries`, `test.slow()`, larger `expect` timeouts, `page.waitForTimeout`, `test.skip`. Allowed: adding a deterministic wait on a real signal, fixing the product race, fixing fixture ordering.
4. After the third green run: `docker ps -a --filter label=ah.instance=test` shows no workspace containers; `curl http://127.0.0.1:$WEB_PORT/api/health` on the test instance shows `workspaces.live: 0`. If containers remain, the GC/finally path has a bug — fix it.
5. Record in the completion log: three run durations, and one line per flake `symptom → root cause → fix (path)`.

Constraints:
- Follow /bymax-workflow:standards. Any product code you change keeps 100 % coverage (add the unit test that would have caught the race).
- English; no suppression comments; no new dependencies.
- Never touch the `default` instance or the orchestrator's containers; everything you start is labelled `ah.instance=test`.

Verification:
- Three consecutive `pnpm test:e2e -- --retries=0` runs exit 0 (paste the summary lines)
- `pnpm test -- --coverage && pnpm lint && pnpm typecheck` — green after your fixes
- `docker ps -a --filter label=ah.instance=test --format '{{.Names}}'` — empty after teardown

Completion Protocol: update status/AC/progress in docs/tasks/wave-3a-integration.md; append `- 3A.3 ✅ <date> — 3× green (<d1>/<d2>/<d3>); flakes fixed: <n>`; commit(s) `fix(e2e): <root cause>` per fix and `test(e2e): run the full suite on the real stack`.
````

---

## Task 3A.4 — Real OpenAI smoke: `pnpm smoke:openai` (one turn with `gpt-5.6-sol`, list files + write a file)

**Status:** ✅ Done · **Priority:** P0 · **Size:** S · **Depends on:** 3A.3

**Description.** Prove the real model path once: a documented script drives the running stack (web + worker with `AGENT_MODEL_PROVIDER=openai`) through the public HTTP API to create a chat on a small public repository and send one prompt that makes the agent list the repository files and write a file. It uses the OpenAI key (and GitHub PAT for the repo picker) that the user entered in Settings; it never reads a key from env or argv and never runs in CI. The result (model, steps, tool calls, duration, tokens) is recorded in the PR.

**Acceptance criteria**
- [x] `scripts/smoke-openai.ts` (run via `tsx`; root script `smoke:openai`) takes `--base-url` (default `http://127.0.0.1:${WEB_PORT}`), `--repo` (default a small public repo such as `https://github.com/octocat/Hello-World`), `--branch` (default repo default), `--timeout` (default 300 s); reads no secrets
- [x] Flow: `GET /api/health` (requires docker ✓, worker alive, image present) → `GET /api/settings` (requires both secrets configured, else exits 2 with the message "Enter your keys in Settings first") → `POST /api/chats` → `POST …/messages` with the prompt *"List the files in this repository, then create a file SMOKE.md containing the current date and a one-line summary of the repo. Do not push."* → subscribes to the turn SSE with `fetch` + `ReadableStream` (Node 24, no EventSource polyfill) → prints each event compactly → exits 0 when `turn.completed` arrives and the event log contains at least one `tool.call` with `list_dir` (or `run_shell` with `ls`) and one `write_file` for `SMOKE.md`; exits 1 on `turn.failed`, timeout, or missing tool calls
- [x] Uses `OPENAI_MODEL` from the running server (the model id shown in the composer / health); the script prints the model id it observed
- [x] Unit-tested with a mocked `fetch` (happy path, settings missing, health degraded, failed turn, timeout) — 100 % coverage; the script lives outside any package's `src/**` so add a root `vitest.config.ts` project or place it under `apps/worker/scripts/` with its own include — whichever keeps the 100 % rule simple (decide and note it)
- [x] Run once for real with the user's key; the PR body gets a "Real OpenAI smoke" section: date, model, steps, tool calls (names + paths), duration, usage tokens if the `turn.completed` event carries them, and the redacted final assistant message (first 300 chars)
- [x] README pointer for W3-B: one paragraph in the completion log describing how to run it (W3-B writes the README "Testing → Real model smoke" subsection from it)

**Files to create**
`scripts/smoke-openai.ts`, `scripts/smoke-openai.test.ts`, root `package.json` script `smoke:openai` (`tsx scripts/smoke-openai.ts`), root `vitest.config.ts` (or workspace entry) so the test is part of `pnpm test`.

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: Node 24 (`fetch`, `ReadableStream`, `AbortController`) · tsx · Vitest 4 · the running stack: Next.js 16.3 web + worker with `AGENT_MODEL_PROVIDER=openai`, OpenAI Responses API through openai SDK 7.5, model `gpt-5.6-sol` via `OPENAI_MODEL`.
Branch feat/w3a-integration (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W3-A 🐳 — Task 3A.4 of 6 (MIDDLE)

PRECONDITIONS
- Tasks 3A.1–3A.3 done: the stack is stable with the fake provider.
- The user has entered a real OpenAI API key and GitHub PAT in Settings of a running instance (ask the orchestrator to confirm before the real run; if not available, implement + unit-test the script, mark the real run as pending in the completion log, and say so in the PR).

REQUIRED READING (only these):
- docs/plan.md § "8. Wave 3" (W3-A: "one real OpenAI smoke with the user's key (documented script `pnpm smoke:openai`, not in CI)")
- docs/spec/03-interfaces.md § "4. HTTP API" (chats, messages, events, settings, health rows) and § "3. Agent protocol" (AgentEvent variants you will print)
- docs/spec/01-overview.md § "9. Open questions" Q1 (model availability)
- packages/core/src/api/contracts.ts (route schemas, SseFrame), apps/web/src/shared/api/client.ts (for the SSE `?from=` convention)

TASK
Write and run `pnpm smoke:openai`: one real chat turn against a small public repository that lists files and writes SMOKE.md, driven through the HTTP API, using only the keys stored in Settings. Record the result in the PR.

DELIVERABLES

1. `scripts/smoke-openai.ts` — CLI with args `--base-url`, `--repo`, `--branch`, `--timeout` (defaults in the acceptance criteria). Steps: health check (docker, worker, image) → settings status (both secrets present, else exit 2 with a clear message) → create chat (repo + branch) → post the prompt from the acceptance criteria → open the turn's SSE endpoint with `fetch` and parse `text/event-stream` frames (id/event/data) incrementally; print one compact line per event (`tool.call list_dir /`, `tool.result … (1.2 kB)`, `assistant.delta …` collapsed to a running char count, `turn.completed`), redacting nothing yourself (the server already redacts) but never printing request bodies. Exit codes: 0 success (completed + required tool calls seen), 1 failure/timeout, 2 precondition not met. Print a final summary line `model=<id> steps=<n> toolCalls=<list> duration=<s> tokens=<in/out or n/a>`.
2. Structure for testability: export `runSmoke(options, deps = { fetch: globalThis.fetch, now: Date.now, log: console.log })` returning `{ exitCode, summary }`; `main()` only parses argv and calls it. Parse argv by hand (`process.argv` slice + a tiny table); no new dependencies.
3. `scripts/smoke-openai.test.ts` — mocked `fetch` sequences: happy path (asserts the prompt text and the summary), settings missing → 2, health degraded → 2, `turn.failed` → 1, timeout via fake timers → 1, event stream split across chunks parsed correctly. File header + it() comments; 100 % coverage of the script.
4. Wire: root `package.json` script `smoke:openai` → `tsx scripts/smoke-openai.ts` (root scripts block is free in Wave 3); make the test part of `pnpm test` (root `vitest.config.ts` project `scripts` with `coverage.include: ['scripts/**']` and 100 % thresholds — reuse the project W0 T0.6 created for env.sh tests if it exists).
5. Real run: with the user's instance up (`AGENT_MODEL_PROVIDER=openai`, keys in Settings), run `pnpm smoke:openai`; paste the event log (trimmed) and the summary into your notes for the PR body section "Real OpenAI smoke" (date, model, steps, tool calls, duration, tokens, first 300 chars of the final answer). If the model id is not available to the key (401/404 on model), report it, and rerun with the `OPENAI_MODEL` the user names — record both. Never commit output files.
6. Completion-log paragraph for W3-B: how to run it, preconditions, what it proves, that it is not in CI.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, header, English, no suppression, it() comments).
- Never read secrets from env/argv; never print secrets; never add the script to CI.
- The written file stays in the workspace container (the prompt says "Do not push"); no cleanup needed — the workspace is reaped by idle GC.

Verification:
- `pnpm test -- --coverage` — scripts project green at 100 %
- `pnpm smoke:openai --help`-style misuse prints usage and exits 2
- One real run exits 0 and the summary line is captured
- `pnpm lint && pnpm typecheck` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-3a-integration.md; append `- 3A.4 ✅ <date> — smoke: model=<id> steps=<n> duration=<s> (or "real run pending: <reason>")`; commit `feat(scripts): add pnpm smoke:openai real-model smoke test`.
````

---

## Task 3A.5 — UI polish pass against spec 10 §10 on real data; Lighthouse a11y ≥ 95; `pnpm doctor` final

**Status:** 📋 ToDo · **Priority:** P1 · **Size:** M · **Depends on:** 3A.3

**Description.** Walk the three screens with the real stack (fake provider is fine for data) through every item of the spec 10 §10 pre-delivery checklist, fix what fails, capture evidence (screenshots at 375/768/1024/1440 in both themes, Lighthouse accessibility reports for `/chats/new`, `/scheduled`, `/settings`), and produce the final `pnpm doctor` output for two instances.

**Acceptance criteria**
- [ ] Tokens only: `grep -rnE "#[0-9a-fA-F]{3,8}\b" apps/web/src apps/web/app --include=*.tsx --include=*.ts` returns nothing outside `app/globals.css`; both themes compared side by side (screenshots)
- [ ] Lucide icons only, no emoji in UI strings (`grep -rnP "[\x{1F300}-\x{1FAFF}]" apps/web/src apps/web/app` empty)
- [ ] Every interactive element has `cursor-pointer`, hover and focus-visible states (150–250 ms); verified on sidebar rows, composer buttons, tool rows, table rows, dialogs
- [ ] Keyboard-only walkthrough of the three flows (new chat → send → expand tool row → Stop; Scheduled → New job → save → open run; Settings → replace key → save) recorded as a short checklist with the focus order; roving tabindex in lists; `⌘K` search works
- [ ] `prefers-reduced-motion` verified (emulated in DevTools): no pulse/translate, opacity only; no layout-shifting animations
- [ ] Skeletons reserve space (CLS < 0.1 in Lighthouse); transcript > 500 rows and runs > 200 rows stay smooth (virtualised or windowed as W1-G/H built; fix if they are not)
- [ ] 375 / 768 / 1024 / 1440 px: no horizontal scroll; sidebar rail < 1024, drawer < 768; suggestion cards 4→2→1; tables scroll inside their container; composer sticks to the bottom
- [ ] Lighthouse accessibility ≥ 95 on `/chats/new`, `/scheduled`, `/settings` (desktop preset, real stack, dark theme); reports saved as JSON + PNG under `.github/assets/w3a/lighthouse-*.{json,png}`; screenshots at the four widths under `.github/assets/w3a/*.png` (optimised, ≤ 200 KB each) and referenced in the PR body
- [ ] Microcopy review: short, action-oriented, no container ids outside "Copy" actions; each change listed
- [ ] `pnpm doctor` final output for `default` and `test` instances pasted in the completion log (all ✓ except optional items that legitimately apply); every ✗ path prints the fix command (verified by stopping Redis once)
- [ ] 100 % coverage maintained for every component touched

**Files to modify**
`apps/web/src/features/**`, `apps/web/src/shared/**`, `apps/web/app/globals.css` (only tokens/base styles), `infra/scripts/doctor.sh` (only if a check is wrong), `.github/assets/w3a/**` (new).

**Agent prompt**

````
You are a senior frontend engineer with an accessibility focus working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: Next.js 16.3 App Router + React 19.2 · Tailwind v4 (`@theme` tokens in app/globals.css) · shadcn (Base UI) in src/shared/ui · lucide-react · Sonner · Vitest 4 + Testing Library · Lighthouse via `pnpm dlx lighthouse` or Chrome DevTools.
Branch feat/w3a-integration (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W3-A 🐳 — Task 3A.5 of 6 (MIDDLE)

PRECONDITIONS
- Tasks 3A.1–3A.3 done; the stack runs stably with the fake provider on AH_INSTANCE=w3a (`pnpm dev`).
- W1-G/W1-H built the screens against spec 10; this is a verification-and-fix pass, not a redesign.

REQUIRED READING (only these):
- docs/spec/10-ui-design.md § "10. Pre-delivery checklist" (the list you execute), § "2. Tokens" (contrast table), § "6. States", § "7. Motion", § "8. Accessibility", § "9. Responsive"
- docs/spec/05-local-dev.md § "4. First-run experience" (the `pnpm doctor` table)
- apps/web/app/globals.css, apps/web/src/features/** barrels (to find components)

TASK
Execute every item of the spec 10 §10 checklist on real data, fix failures at component level with tests, capture evidence, and produce the final `pnpm doctor` output.

DELIVERABLES

1. Checklist execution, in order, with a one-line result each in your notes: tokens only (grep + visual both themes) · Lucide only · cursor/hover/focus on every interactive element · keyboard-only walkthrough of the three flows (write the focus order you observed) · reduced motion · skeletons/CLS and list virtualisation · 375/768/1024/1440 · Lighthouse a11y on the three pages · microcopy.
2. Fixes: smallest component-level change per finding, each with a Testing Library test asserting the behaviour (role/label present, focus ring class from the real source, `aria-live` region text, disabled state). Hex values are only allowed in app/globals.css. No new dependencies.
3. Evidence: `.github/assets/w3a/` with `home-{375,768,1024,1440}-{dark,light}.png`, `chat-running-1440-dark.png`, `scheduled-1440-dark.png`, `settings-1440-dark.png`, `lighthouse-{chats-new,scheduled,settings}.png` (+ the JSON reports). Optimise PNGs (≤ 200 KB each; `pnpm dlx sharp-cli` or macOS `sips` are fine — nothing added to package.json). Generate Lighthouse with `pnpm dlx lighthouse http://127.0.0.1:$WEB_PORT/chats/new --only-categories=accessibility --preset=desktop --output=json,html --output-path=…` (or DevTools) against the real stack, dark theme; score ≥ 95 per page — fix and rerun until it is.
4. `pnpm doctor` final: run for `AH_INSTANCE=default` and `AH_INSTANCE=test`; paste both tables into the completion log; stop Redis once and confirm the ✗ row shows the fix command; fix infra/scripts/doctor.sh only if a row is wrong.
5. Microcopy: list each string you changed (before → after) in the completion log for W3-B.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no suppression, it() comments). 100 % coverage kept.
- Tokens, spacing and motion values come from spec 10; do not introduce new design decisions — if something in the spec is impossible, note it for W3-B's spec refresh.
- Screenshots must not contain real secrets (use canary-looking placeholders only via the fake provider/MSW; Settings shows masked values only).

Verification:
- `grep -rnE "#[0-9a-fA-F]{3,8}\b" apps/web/src apps/web/app --include=*.tsx --include=*.ts` — empty
- Lighthouse a11y ≥ 95 on the three pages (JSON `categories.accessibility.score ≥ 0.95`)
- `pnpm --filter web test -- --coverage` — 100 %; `pnpm lint && pnpm typecheck` — exit 0
- `ls .github/assets/w3a | wc -l` ≥ 14 files; each ≤ 200 KB

Completion Protocol: update status/AC/progress in docs/tasks/wave-3a-integration.md; append `- 3A.5 ✅ <date> — a11y <score1>/<score2>/<score3>; <n> fixes; doctor tables captured`; commit `fix(web): polish pass against the UI pre-delivery checklist` (+ `chore(assets): add W3-A evidence screenshots`).
````

---

## Task 3A.6 — CI all jobs green; close-out PR with S1–S6, S8 evidence

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** S · **Depends on:** 3A.1–3A.5

**Description.** Run the full gate set locally, make every CI job green on the branch (lint, typecheck, unit, integration, e2e, build, secret-scan), run the code review to zero findings, update the plan dashboard and task index, and open the PR whose body carries an evidence table for success criteria S1–S6 and S8 of spec 01 §5.

**Acceptance criteria**
- [ ] `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test -- --coverage` green locally; `pnpm test:integration` green with the test stack; `pnpm test:e2e -- --retries=0` green once more; `pnpm build` succeeds
- [ ] `/bymax-quality:code-review` run on the branch with zero open findings (no suppressions; every LOW either fixed or justified in the PR)
- [ ] CI on the PR: all jobs green — `lint`, `typecheck`, `unit`, `integration`, `e2e`, `build`, `secret-scan` (push, watch `gh pr checks --watch`; fix and re-run the review on every new commit before pushing again)
- [ ] `docs/plan.md` §12 row `W3-A 🐳` → 🟨 with branch + PR number (touch only that row); `docs/tasks/README.md` W3-A row → 🟨 (only that row); this file's header Status → 🟨 PR open
- [ ] PR body contains: summary, seams wired (with contract changes list), E2E 3× evidence, real OpenAI smoke section, polish evidence (image links to `.github/assets/w3a/**`), doctor tables, and the **success-criteria table** below filled with evidence links (test names, CI job URLs, screenshots, log excerpts)
- [ ] Returned to the orchestrator: `{ pr, branch, headSha, gates, coverage, contractChangeRequests }`

**Success-criteria evidence table (template for the PR body)**

| # | Criterion (spec 01 §5) | Evidence |
|---|---|---|
| S1 | clone → README → working chat ≤ 10 min on clean macOS | first-run walkthrough timing on a fresh clone + `pnpm setup` log; README quick start (W3-B) |
| S2 | every turn in a non-shared container | `@docker` two-workspace isolation test (W1-B) + E2E `chat-create-run` container labels; `docker inspect` excerpt |
| S3 | archive → restore reproduces checkout + conversation | E2E `chat-archive-restore` 3× green; restore notice screenshot |
| S4 | one-minute cron job: new workspace per run, output recorded, no container left | E2E `scheduled-job-run`; `/api/health` `workspaces.live = 0` after run; worker `finally` destroy unit test |
| S5 | secrets ciphertext-only; last 4 in UI; no plaintext in logs/image | E2E `settings-save-mask`; canary grep of worker logs; `docker history`/`inspect` of the image shows no env secrets; CI `secret-scan` green |
| S6 | SSE streaming with reconnect/replay | `@redis` SSE replay/tail/heartbeat integration test (W2-A); cancel round-trip test (3A.2) |
| S8 | two instances concurrently with independent DB/Redis/ports/containers | `pnpm doctor` tables for `default` + `test` (3A.5); `docker ps` showing both compose projects |

(S7 — mutation score — is Wave 4 and is listed as "pending W4-A/W4-B" in the PR.)

**Files to modify**
`docs/plan.md` (§12 W3-A row only), `docs/tasks/README.md` (W3-A row only), `docs/tasks/wave-3a-integration.md` (header, log).

**Agent prompt**

````
You are a senior engineer closing out the integration lane of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 · Node 24 · Next 16.3 · Prisma 7.9 · BullMQ 6 · Vitest 4 · Playwright 1.62 · GitHub Actions.
Branch feat/w3a-integration (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W3-A 🐳 — Task 3A.6 of 6 (LAST)

PRECONDITIONS
- Tasks 3A.1–3A.5 done and committed on this branch; evidence files exist under .github/assets/w3a/.

REQUIRED READING (only these):
- docs/spec/01-overview.md § "5. Success criteria"
- docs/spec/06-testing.md § "6. CI pipeline"
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard"
- docs/tasks/wave-3a-integration.md (this file: completion log entries 3A.1–3A.5 — they are your evidence)

TASK
Run all gates and the code review to zero findings, get every CI job green, update the dashboards, and open the PR with the S1–S6, S8 evidence table.

DELIVERABLES

1. Gates locally: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test -- --coverage` (100 % in every package incl. the scripts project), `AH_INSTANCE=test pnpm test:integration`, `pnpm test:e2e -- --retries=0`, `pnpm build`. Fix anything red.
2. Rebase on latest main (W3-B may have merged docs changes; resolve only conflicts in docs/plan.md §12 / docs/tasks/README.md by keeping both rows).
3. Run `/bymax-quality:code-review` on `main..HEAD`; fix every finding (CRITICAL/HIGH/MEDIUM/LOW) — no suppressions; for any LOW you deliberately keep, write the justification into the PR body. Re-run gates after fixes. Repeat the review on every subsequent commit before pushing.
4. Dashboards: docs/plan.md §12 row `W3-A 🐳` → `🟨 PR open` with `feat/w3a-integration` / PR number and Notes "S1–S6, S8 evidence in PR"; docs/tasks/README.md W3-A row → 🟨; this file's header Status → 🟨, Progress 6/6.
5. Push, open the PR: `gh pr create --base main --title "feat: end-to-end wiring, stabilisation and polish (W3-A)" --body-file <generated>`. Body sections: Summary · Seams wired (+ Contract changes list) · Coverage scope change (src/** everywhere; src/shared/ui decision) · E2E evidence (3× durations, flakes fixed) · Real OpenAI smoke · UI polish evidence (image links) · `pnpm doctor` tables · Success criteria S1–S6, S8 table (template in docs/tasks/wave-3a-integration.md Task 3A.6) with S7 marked pending W4 · Gate results · Review findings kept (if any, with justification).
6. Watch CI: `gh pr checks --watch`; on any red job, fix at the root, re-run the review, push, watch again until all jobs are green (lint, typecheck, unit, integration, e2e, build, secret-scan). Do not merge.
7. Return to the orchestrator: `{ pr, branch, headSha, gates: { lint, typecheck, unit, integration, e2e, build, secretScan }, coverage: { core, agentRuntime, web, worker, scripts }, contractChangeRequests: [] }` (contract changes were applied directly in this lane — list them under `notes`).

Constraints:
- English; Conventional Commits; no AI attribution anywhere (commits, PR, comments).
- Do not merge; do not resolve review threads that the orchestrator owns.

Verification:
- `gh pr view --json number,headRefOid,statusCheckRollup` — PR exists; every check `SUCCESS`
- `git log --format=%B main..HEAD | grep -i "co-authored-by\|generated with"` — empty

Completion Protocol: update status/AC/progress in docs/tasks/wave-3a-integration.md (header Status → 🟨 PR open); append `- 3A.6 ✅ <date> — PR #<n> opened, CI green`; commit `chore: close out W3-A integration lane` before opening the PR (amend the dashboard row with the PR number in a follow-up `docs:` commit after `gh pr create`).
````

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)

- 3A.2 ✅ 2026-08-20 — measured first: the Stop button, the cancel round trip, the restore notice, the settings gate (`SECRETS_MISSING`, not `settings_missing` — the codebase spells every error code in SCREAMING_SNAKE and the contract is frozen), the env pill, the health dialog and `ALLOWED_REPO_HOSTS` were all already wired and are left untouched. Built only the four gaps: `healthResponse.checks.worker` (`{ ok, detail?, lastSeenAt? }`) so a stopped worker stops being reported as `docker ✗`; the composer's infrastructure notice required by spec 10 §6, which locks Send and names the dependency and its command; `HEALTH_CHECK_FIX` beside each failing probe in the environment dialog; and `.env.example` gaining `ALLOWED_REPO_HOSTS` and `GITHUB_API_BASE_URL`. `useHealth` moved to `apps/web/src/shared/health/**` so the composer reads it without a cross-feature import, and the heartbeat key/TTL/interval/schema are now imported from `packages/core` instead of mirrored in `apps/worker` (half of R8). **Not built, deliberately:** `workspaces: { live, byKind }` on the health response — no screen in spec 10 renders it, the heartbeat already carries a container count, and `byKind` needs either a new Prisma aggregate or a change to `WorkspaceRunner.list`'s return type; a field nobody reads is speculative generality, so it is left for whoever first needs it. ALLOWED_REPO_HOSTS: requested and already implemented end to end by earlier lanes; only `.env.example` was missing it.
- 3A.4 ✅ 2026-08-20 — smoke: model=gpt-5.6-sol steps=5 duration=14.7s tokens=4231/351, tool calls list_dir · read_file · run_shell ×2 · write_file(SMOKE.md) · read_file · run_shell, all SUCCEEDED exit=0; workspace released (`pnpm ws:list` empty afterwards)

**How to run it (README pointer for W3-B, "Testing → Real model smoke").** `pnpm smoke:openai` drives one real turn through the running instance's public HTTP API: it checks `/api/health`, confirms `/api/settings` reports both credentials as stored, opens a chat on a small public repository, sends one prompt that makes the agent list the files and write `SMOKE.md`, follows the turn's event stream, and finally deletes the chat so the workspace is torn down. Preconditions: the instance is up (`pnpm dev`), Docker is running with the workspace image built, and the GitHub PAT and OpenAI key have been entered **in Settings** — the script reads no credential from the environment, from a file or from an argument, and refuses with exit code 2 and "Enter your keys in Settings first" when either is missing. Flags: `--base-url` (default `http://127.0.0.1:$WEB_PORT`), `--repo` with `--branch` (default `https://github.com/octocat/Hello-World` on `master`; naming a repository requires naming its branch, since the default branch of an arbitrary repository cannot be discovered through this API), `--timeout` in seconds (default 300) and `--keep` to leave the chat in place. Exit codes: 0 the turn completed and both halves were proven, 1 the turn ran and something was not proven, 2 the instance or Settings were not ready. What it proves that no automated suite does: every other check in this repository runs against the scripted provider, so this is the only thing that exercises the real OpenAI path end to end — model composition, credential decryption, container, tools and event stream. It is deliberately **not** in CI: it spends the operator's own tokens and needs their own credentials.
