# Wave 1 — Lane W1-H — Web UI: scheduled jobs + settings

| | |
|---|---|
| **Lane** | W1-H (one of nine parallel Wave 1 lanes; cap 5 concurrent) |
| **Status** | 🟨 PR open |
| **Progress** | 6/6 tasks |
| **Branch** | `feat/w1h-web-scheduled-settings` · PR #24 |
| **Owned paths** | `apps/web/src/features/scheduled/**` · `apps/web/src/features/settings/**` · `apps/web/src/mocks/scheduled.ts` (+ test) · `apps/web/src/mocks/settings.ts` (+ test) · `apps/web/app/(app)/scheduled/page.tsx` · `apps/web/app/(app)/scheduled/[id]/page.tsx` · `apps/web/app/(app)/settings/page.tsx` · `apps/web/vitest.config.ts` (`coverage.include` lines only) · one additive line in `apps/web/src/mocks/handlers.ts` (the marked W1-H append line) |
| **Depends on** | W0 merged to `main`; soft dependency on W1-G's shared modules (`@/shared/transcript`, `@/shared/repo-picker`, `@/shared/feedback`, `@/shared/shell/PageHeader`, `@/shared/api/use-api-query`, `@/mocks/*`) — stubbed locally until W1-G merges, swapped at the final rebase (plan §6 coordination note) |
| **Unblocks** | W2-C (E2E authoring needs the selectors); W3-A wiring |
| **Source** | [docs/plan.md §6 W1-H](../plan.md) · spec [10 §4.3–§4.4, §5–§9](../spec/10-ui-design.md) · [03 §4](../spec/03-interfaces.md) · [04 (c)(d)](../spec/04-flows.md) · [06 §2](../spec/06-testing.md) |
| **Last updated** | 2026-08-19 (PR open) |

## Context

W0 left `apps/web` with tokens, shadcn components in `src/shared/ui/`, the `(app)` layout with slots, placeholder pages for `/scheduled`, `/scheduled/[id]` and `/settings`, and a typed `apiFetch`/`createEventSource` client over the frozen `@agent-hangar/core` API contracts. Lane W1-G builds the shell, the chat pages, and — as shared, domain-free modules — the transcript (`@/shared/transcript`: `Transcript`, `StatusPill`, `useTurnEvents`, reducer types, format helpers), the repo/branch pickers (`@/shared/repo-picker`), the feedback components (`@/shared/feedback`: `ErrorCard`, `EmptyState`), the page header (`@/shared/shell/PageHeader`), the query hook (`@/shared/api/use-api-query`) and the MSW mock foundation (`@/mocks`: store, server, browser bootstrap, `createSseResponse`, scripted turn frames).

This lane builds the **Scheduled** screens (jobs table, job dialog with cron field/preview/timezone, job detail with runs table and a run drawer that reuses the shared transcript with live SSE) and the **Settings** screen (credentials card with masked secret fields and replace/remove, environment card from `/api/health`), plus the MSW handlers for jobs/runs/settings in files separate from W1-G's. Both lanes run in the same Wave 1 batch, so W1-H may start before W1-G's shared modules are on `main`: W1-H develops against local stubs that carry the exact export names W1-G publishes, and removes them at the final rebase.

Quality bar (same as every lane): TypeScript strict, zero `any`, zero suppression comments, no `enum`, JSDoc on every export + file header, English only, test headers + a block comment on every `it()`, **100 % coverage on lines/branches/functions/statements** for every owned `src/**` path, tokens only (no raw hex), Lucide icons only, shadcn components from `@/shared/ui`, a11y per spec 10 §8, motion per §7, responsive per §9.

## Rules of this lane

1. **Architecture.** `features/<feature>/{components,hooks,services,lib}` with an `index.ts` barrel exporting only the public API; pages import from barrels. No import from another `features/*` folder — `features/scheduled` imports `Transcript`, `StatusPill`, `useTurnEvents` from `@/shared/transcript`, `RepoPicker`/`BranchPicker` from `@/shared/repo-picker`, `ErrorCard`/`EmptyState` from `@/shared/feedback`, `PageHeader` from `@/shared/shell/PageHeader`, `useApiQuery`/`invalidateQueries` from `@/shared/api/use-api-query`. Never from `features/chats` or `features/shell`.
2. **Pages are server components** rendering one client feature component; all data fetching is client-side via feature hooks over `apiFetch`/`createEventSource`, so the MSW browser worker intercepts in dev (`NEXT_PUBLIC_API_MOCK=1`) and the node server in Vitest.
3. **Stubs (temporary, local).** If a shared module from W1-G is not on your branch, create it at the **same path with the same export names and signatures** listed in Task 1H.1's stub table, each file starting with `// TEMP-STUB(W1-H): replaced by W1-G at rebase — do not ship`. Stubs are deleted in the final rebase commit; the final PR diff touches only the owned paths above. Prefer copying W1-G's real files from `origin/feat/w1g-web-chats` when available (`git show origin/feat/w1g-web-chats:<path>`), still marked and still deleted at rebase.
4. **Mocks.** `src/mocks/scheduled.ts` (jobs, runs, run events SSE) and `src/mocks/settings.ts` (PUT/DELETE `/api/settings/:key`; GET is W1-G's `settings-status.ts` reading the shared `store.secrets`) are the only mock files this lane owns, plus one additive line in `src/mocks/handlers.ts` at the marked `// W1-H appends …` comment. Mock responses satisfy the core Zod schemas exactly.
5. **Core scheduling helpers.** `CronField`/`CronPreview` use `validateCron`, `describeCron` and `nextRunAt` from `@agent-hangar/core` (lane W1-F). All access goes through one adapter file, `features/scheduled/lib/cron.ts`; if W1-F is not merged yet, that file contains a local implementation behind the same signatures (marked `TEMP-STUB(W1-H)`) and is swapped to the core import at rebase. Nothing else in the lane imports cron helpers directly.
6. **No new dependencies.** Timezones come from `Intl.supportedValuesOf('timeZone')`; relative times from `relativeTime` in `@/shared/transcript`; toasts from `sonner`.
7. **Coverage.** Extend `apps/web/vitest.config.ts` `coverage.include` with `src/features/scheduled/**`, `src/features/settings/**`, `src/mocks/scheduled.ts`, `src/mocks/settings.ts` (thresholds stay 100×4; `src/shared/ui/**` excluded; `app/**` pages excluded — keep them trivially thin).
8. **Secrets in tests** use `GITHUB_CANARY`/`OPENAI_CANARY` from `@agent-hangar/core/testing`; assert the plaintext never appears in the DOM after save and never in mock GET responses.
9. Commit messages: Conventional Commits, English, no attribution trailers. One PR at the end (1H.6).

## Reference docs

- [docs/plan.md](../plan.md) § "3. Parallelism rules", § "6. Wave 1" (W1-F, W1-G, W1-H and the coordination note), § "11. Orchestrator protocol", § "12. Status dashboard"
- [spec 10 — UI design](../spec/10-ui-design.md) § "4.3 Scheduled", § "4.4 Settings", § "5. Components", § "6. States", § "7. Motion", § "8. Accessibility", § "9. Responsive"
- [spec 03 — Interface contracts](../spec/03-interfaces.md) § "4. HTTP API" (jobs, runs, settings, health routes; SSE framing), § "6. Secrets service" (`SecretKey`)
- [spec 04 — Flows](../spec/04-flows.md) (c) scheduled job (guarantees: overlap policy "stated in the UI", manual run), (d) secrets (UI controls: `type=password`, never pre-filled, `{set,last4}` only)
- [spec 06 — Testing](../spec/06-testing.md) § "2. Unit tests" apps/web (masked secret field), § "4" `settings-save-mask.spec` and `scheduled-job-run.spec` (selectors W2-C will need)
- Code: `packages/core/src/api/contracts.ts`, `packages/core/src/scheduling/**` (W1-F), `packages/core/src/secrets/types.ts`, `apps/web/src/shared/api/client.ts`, W1-G's `docs/tasks/wave-1g-web-chats.md` Tasks 1G.1–1G.3 (export names you consume)

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 1H.1 | MSW handlers for jobs/runs/settings (+ local stubs for W1-G shared modules if not merged) | ✅ | P0 | M | — |
| 1H.2 | `/scheduled` list: `JobsTable`, row menu, enabled switch, empty/loading/error, `useJobs`, page | ✅ | P0 | M | 1H.1 |
| 1H.3 | `JobDialog` + `CronField` + `CronPreview` + `TimezoneCombobox`, validation, `useJobMutations` | ✅ | P0 | L | 1H.2 |
| 1H.4 | `/scheduled/[id]` detail: `JobHeader`, `RunsTable`, `RunDrawer` (Sheet 720, Transcript read-only + live SSE + Stop, Raw output tab), page | ✅ | P0 | L | 1H.3 |
| 1H.5 | `/settings`: `CredentialsCard` + `SecretField` (mask, Replace/Remove, toasts), `EnvironmentCard` + `EnvSummary`, `useSettings`, page | ✅ | P0 | M | 1H.1 |
| 1H.6 | Close-out: gates, Lighthouse a11y, code review, stub removal at rebase, dashboard, PR | ✅ | P0 | S | 1H.1–1H.5 |

---

## Task 1H.1 — MSW handlers for jobs/runs/settings (+ local stubs)

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** Create `src/mocks/scheduled.ts` (in-file job/run store, handlers for every jobs/runs route of spec 03 §4, scripted `GET /api/runs/:id/events` reusing W1-G's `createSseResponse`/`scriptedTurnFrames`) and `src/mocks/settings.ts` (`PUT`/`DELETE /api/settings/:key` mutating the shared `store.secrets`), append them in `handlers.ts` at the marked line, and — only if W1-G's shared modules are not on the branch — create the temporary stubs listed below so the lane compiles and tests run against the same import paths.

**Acceptance criteria**
- [x] `src/mocks/scheduled.ts` handles `GET/POST /api/jobs`, `PATCH/DELETE /api/jobs/:id`, `POST /api/jobs/:id/run`, `GET /api/jobs/:id/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/events` with responses that parse with the core schemas; validation → 400, unknown → 404; `POST /run` while a run is RUNNING records a FAILED run with error `previous run still running` (spec 04 (c) overlap policy)
- [x] `src/mocks/settings.ts` handles `PUT /api/settings/:key { value }` (keys `GITHUB_PAT` | `OPENAI_API_KEY`; stores `last4` + `updatedAt` only — plaintext is discarded; empty value → 400) and `DELETE /api/settings/:key` (204); `GET /api/settings` (W1-G's handler) then reflects the change
- [x] `src/mocks/handlers.ts` gains exactly one additive line spreading `scheduledHandlers` and `settingsHandlers` at the marked comment (plus the two imports)
- [x] Stub table applied only for modules missing from the branch; every stub file starts with the `TEMP-STUB(W1-H)` marker; `grep -rn "TEMP-STUB(W1-H)"` output is recorded in the task completion log for removal in 1H.6
- [x] `vitest.config.ts` `coverage.include` gains `src/mocks/scheduled.ts` and `src/mocks/settings.ts`; handler tests reach 100×4

**Files to create/modify**
`apps/web/src/mocks/{scheduled.ts,scheduled.test.ts,scheduled-events.node.test.ts,settings.ts,settings.test.ts}`; modify `apps/web/src/mocks/handlers.ts` (one line + imports), `apps/web/vitest.config.ts`; temporary stubs (if needed) per the table in the prompt.

**Agent prompt**

````
You are a senior frontend engineer (React 19 / Next.js 16 / TypeScript strict / MSW 2) working on the Agent Hangar project.

PROJECT: Agent Hangar — a local-first web app where AI agents answer questions and perform coding tasks against GitHub repositories inside isolated, disposable Docker workspaces; plus cron-scheduled jobs that run in fresh workspaces, and a settings page with encrypted credentials (GitHub PAT, OpenAI API key).
Stack: pnpm 11 workspaces · TypeScript ~6.0.3 strict · Node 24 · Next.js 16.3 App Router + React 19.2 · Tailwind v4 + shadcn (Base UI) in `@/shared/ui` · Lucide · Vitest 4 + Testing Library + MSW 2 · `@agent-hangar/core` contracts (Zod).
Specification lives in docs/spec/ (01–10); execution plan in docs/plan.md. You are in a git worktree on branch feat/w1h-web-scheduled-settings.

CURRENT LANE: W1-H (Web UI: scheduled + settings) — Task 1H.1 of 6 (FIRST)

PRECONDITIONS
- W0 merged to main; branch off latest main. W0 created: app/(app)/layout.tsx with SidebarSlot/HeaderSlot, globals.css tokens, shadcn components in src/shared/ui, src/shared/api/client.ts (`apiFetch`, `createEventSource`, `ApiClientError`), src/shared/lib/cn.ts, vitest/playwright configs, placeholder pages for the routes.
- W1-G's first commits create `apps/web/src/shared/transcript/**` (and `shared/feedback`, `shared/repo-picker`, `shared/shell/PageHeader.tsx`, `shared/api/use-api-query.ts`, `src/mocks/{store,scenario,handlers,events,server,browser,vitest,MockProvider}`); if not yet merged, develop against local stubs (table below) and swap/delete at the final rebase (plan §6 coordination note). Check first: `git fetch origin && git ls-tree -r origin/main --name-only | grep apps/web/src/shared/transcript`; if absent, try `origin/feat/w1g-web-chats` and copy the real files as your stubs.

REQUIRED READING (only these):
- docs/plan.md § "6. Wave 1" (W1-G, W1-H, coordination note), § "3. Parallelism rules" items 1, 2, 5
- docs/spec/03-interfaces.md § "4. HTTP API" (jobs/runs/settings/health routes, SSE framing), § "6" (`SecretKey`)
- docs/spec/04-flows.md (c) "Guarantees" (overlap policy, manual run), (d) "Controls" table (UI row)
- packages/core/src/api/contracts.ts (`jobUpsertRequest`, `jobSummary`, `runSummary`, `runDetail`, `putSecretRequest`, `settingsStatus`, `apiError`, `routes`), packages/core/src/agent-protocol/schemas.ts
- docs/tasks/wave-1g-web-chats.md Task 1G.3 deliverables A (the mock foundation you extend) and Task 1G.1 deliverables 1–8 (the shared names you consume)
- apps/web/src/shared/api/client.ts, apps/web/vitest.config.ts

TASK
Add the mock handlers for jobs, runs and settings mutations; wire them into the composed handler list; if W1-G's shared modules are missing, create marked local stubs with identical export names so the rest of the lane compiles and tests run.

DELIVERABLES

1. `apps/web/src/mocks/scheduled.ts` — in-file store `jobs: JobSummary[]` (three seeded: "Nightly tests" `0 2 * * *` UTC `acme/api`/`main` enabled with last run SUCCEEDED 2 h ago; "Dep audit" `0 9 * * 1` UTC `acme/web`/`main` disabled with last run FAILED 6 d ago; "Changelog" `*/30 * * * *` `America/Sao_Paulo` `acme/api`/`main` enabled, last run 12 min ago) and `runs: RunDetail[]` (5–6 runs across jobs with trigger SCHEDULE/MANUAL, statuses SUCCEEDED/FAILED/RUNNING, usage tokens, `output`, tool call logs — one RUNNING run for "Nightly tests" so the drawer can stream), `resetScheduledStore()` registered into the shared reset path (call it from your tests' `afterEach`; and export it so W1-G's `vitest.ts` can call it after rebase — note in the PR). Handlers: `GET /api/jobs` (sorted by name; `jobSummary[]`), `POST /api/jobs` (`jobUpsertRequest.safeParse` → 400 `{ error: { code: 'VALIDATION', message } }`; invalid cron → 400 `{ error: { code: 'INVALID_CRON', message } }` using the same cron adapter the UI uses — import `validateCron` from `@/features/scheduled/lib/cron`? No: mocks must not import features; duplicate a minimal 5-field check here (`/^(\S+\s+){4}\S+$/`) and document it), computes `nextRunAt` naively (now + 1 h) for the mock, returns 201 `jobSummary`), `PATCH /api/jobs/:id` (partial update incl. `enabled` toggle; 404), `DELETE /api/jobs/:id` (204; also removes its runs), `POST /api/jobs/:id/run` (if a RUNNING run exists → create FAILED run with `error: 'previous run still running'` and return 409 `{ error: { code: 'RUN_IN_PROGRESS', message: 'previous run still running' } }`; else create RUN QUEUED → RUNNING with trigger MANUAL, return 201 `runSummary`), `GET /api/jobs/:id/runs` (newest first), `GET /api/runs/:id` (`runDetail`; 404), `GET /api/runs/:id/events` (reuse `createSseResponse(scriptedTurnFrames({ turnId: runId, prompt: job.prompt, scenario: getScenario() }), { from })` from `@/mocks/events`/`@/mocks/scenario`; when the run is already terminal, stream instantly; on completion flip the run to SUCCEEDED with `output` = final message via a helper mirroring W1-G's `turnFramesToStore`). Export `scheduledHandlers`.
2. `apps/web/src/mocks/settings.ts` — `PUT /api/settings/:key` (key must be a `SecretKey` else 404; body via `putSecretRequest.safeParse` → 400; trims; empty → 400; writes `store.secrets[key] = { last4: value.slice(-4), updatedAt: nowIso() }`; returns the contract's response — `{ set: true, last4 }` per spec 04 (d) or whatever contracts.ts defines), `DELETE /api/settings/:key` (204; unknown key 404). The plaintext must never be stored or echoed. Export `settingsHandlers`.
3. `apps/web/src/mocks/handlers.ts` — add `import { scheduledHandlers } from './scheduled';` and `import { settingsHandlers } from './settings';` and replace the marked comment line with `...scheduledHandlers, ...settingsHandlers,` keeping the comment above it (so the diff is additive and trivially mergeable).
4. Stub table — create ONLY the missing ones, each with the first line `// TEMP-STUB(W1-H): replaced by W1-G at rebase — do not ship`, minimal but type-correct implementations (render the essentials; tests of this lane must not depend on stub-internal behaviour beyond the signature):
   - `src/shared/api/use-api-query.ts`: `useApiQuery<T>(key: readonly string[], loader: (signal: AbortSignal) => Promise<T>, options?: { enabled?: boolean; refetchIntervalMs?: number; refetchOnWindowFocus?: boolean })` → `{ status: 'idle'|'loading'|'success'|'error'; data?: T; error?: Error; refetch(): Promise<void>; isRefetching: boolean }`; `invalidateQueries(prefix: readonly string[]): void`; `clearQueryRegistry(): void`.
   - `src/shared/transcript/index.ts` (+ minimal files): `Transcript({ items, phase, readOnly?, onStopTool?, emptyText?, className? })`, `StatusPill({ phase, startedAt, finishedAt?, onClick?, className? })`, `useTurnEvents({ url, enabled?, initialItems?, initialPhase?, lastEventId?, createEventSource?, now? })` → `{ state, dispatch, reconnect }`, types `TranscriptItem`, `TranscriptState`, `TurnPhase`, `ConnectionState`, helpers `relativeTime(iso, now?)`, `formatDuration(ms)`, `formatTokens(n)`, `formatBytes(n)`, `maskSecretShapes(text)`, `createInitialState`; `src/shared/transcript/testing/index.ts`: `FakeEventSource`, `createFakeEventSourceFactory()` → `{ factory, instances }`.
   - `src/shared/repo-picker/index.ts`: `RepoPicker({ value, onChange, disabled?, size?, className? })`, `BranchPicker({ repo, value, onChange, disabled?, className? })`.
   - `src/shared/feedback/index.ts`: `ErrorCard({ title, message, code?, actions?, variant?, className? })`, `EmptyState({ icon, title, description?, action?, className? })`.
   - `src/shared/shell/PageHeader.tsx`: `PageHeader({ title, leading?, actions?, navTrigger?, className? })`.
   - `src/mocks/{store.ts,scenario.ts,events.ts,server.ts,browser.ts,vitest.ts,MockProvider.tsx,handlers.ts}`: `store` (with `secrets`, `model`, `health`), `resetStore()`, `nowIso()`, `nextId()`; `getScenario()/setScenario()`; `createSseResponse(frames, { from })`, `scriptedTurnFrames({ turnId, prompt, scenario })`; `server = setupServer(...handlers)`; `vitest.ts` setup (listen/reset/close + relative-URL fetch shim) added to `vitest.config.ts` `setupFiles`; `MockProvider` used by the layout (only needed if you also stub the layout — do NOT touch `app/(app)/layout.tsx`; in dev without W1-G the worker will not start, so dev verification for this lane happens after rebase or on a local checkout of W1-G's branch — state this in the PR).
   Stubs are excluded from coverage via `coverage.exclude` entries that you remove in 1H.6 together with the stubs.
5. Tests: `scheduled.test.ts` (every route: schema parse of each success body, sorting, validation 400 incl. invalid cron, 404s, PATCH enabled toggle, DELETE cascades runs, POST run happy path and overlap 409 + FAILED run recorded, runs newest first), `scheduled-events.node.test.ts` (`/** @vitest-environment node */` — environment directive, not a suppression; fetch the run stream, assert frames and `from` replay, terminal run streams instantly), `settings.test.ts` (PUT with `GITHUB_CANARY`/`OPENAI_CANARY` from `@agent-hangar/core/testing` → response has `set: true` + last4 only; subsequent `GET /api/settings` shows `set`/`last4` and never the canary; empty → 400; unknown key 404; DELETE → GET shows `set: false`).
6. `vitest.config.ts`: `coverage.include` += `src/mocks/scheduled.ts`, `src/mocks/settings.ts`; temporary `coverage.exclude` entries for stub paths (marked with a comment `TEMP-STUB(W1-H)`).

Constraints:
- Follow /bymax-workflow:standards: TS strict, JSDoc + file headers, English, no `enum`, no suppression comments, test headers and a block comment on every it().
- Mocks never import from `features/**`; never store or echo secret plaintext; no secret-looking literals outside canaries in tests.
- Only the files listed above (+ stubs) are touched; `handlers.ts` change is one additive line plus imports.

Verification:
- `pnpm --filter web test -- --coverage` — green; 100×4 on `src/mocks/scheduled.ts` and `src/mocks/settings.ts`
- `pnpm typecheck && pnpm lint` — exit 0
- `grep -rn "TEMP-STUB(W1-H)" apps/web/src` — list recorded in the completion log entry

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-1h-web-scheduled-settings.md (header block and task index row)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/6 tasks`)
4. Append a completion log entry at the end of the file: `- 1H.1 ✅ <YYYY-MM-DD> — <one-line summary incl. which stubs were created>`
5. Commit: `feat(web): add MSW handlers for scheduled jobs, runs and settings mutations`
````

---

## Task 1H.2 — `/scheduled` list: `JobsTable`, row actions, enabled switch, states, page

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 1H.1

**Description.** Implement spec 10 §4.3's table: dense 44 px rows with Name, Schedule (cron mono + human-readable tooltip + timezone), Repo · Branch, Last run (status icon + text + relative time), Next run (relative, absolute tooltip), Enabled switch, and a row menu (Run now / Edit / Delete with AlertDialog). Row click navigates to the detail page. Empty state, loading skeletons, error card. `useJobs` + `useJobActions` (toggle, run now, delete) with optimistic toggle and toasts. The page header carries "+ New job" (dialog arrives in 1H.3 — wire a callback prop now).

**Acceptance criteria**
- [x] `/scheduled` renders the seeded jobs as in the §4.3 wireframe; cron in mono with a tooltip from `describeCron` ("every day at 02:00 UTC"); status shown as icon + text (never colour alone); enabled `Switch` labelled `Enable <name>`, optimistic with rollback + toast on error
- [x] Row menu (`⋯`, `aria-label="Actions for <name>"`): Run now (toast "Run started" → navigates to detail? no — stays, invalidates runs; 409 overlap → toast "Skipped: previous run still running"), Edit (calls `onEdit(job)`), Delete (AlertDialog "Delete job <name>?" → `DELETE`, toast "Job deleted")
- [x] Row click / Enter on the focused name link → `/scheduled/<id>`; interactive cells stop propagation; table scrolls horizontally inside its container below 1024 px; no page horizontal scroll at 375 px
- [x] Empty → `EmptyState` (`CalendarClock`, "No scheduled jobs yet.", "Jobs run your prompt in a fresh workspace on a cron schedule.", New job button); loading → 5 skeleton rows; error → `ErrorCard` + Retry
- [x] 100 % coverage on `src/features/scheduled/**` so far; `coverage.include` extended

**Files to create/modify**
`apps/web/src/features/scheduled/{components/ScheduledView.tsx,components/ScheduledView.test.tsx,components/JobsTable.tsx,components/JobsTable.test.tsx,components/JobRow.tsx,components/JobRowMenu.tsx,components/JobRowMenu.test.tsx,components/RunStatus.tsx,components/RunStatus.test.tsx,components/ScheduleCell.tsx,components/ScheduleCell.test.tsx,components/DeleteJobDialog.tsx,components/DeleteJobDialog.test.tsx,components/JobsEmptyState.tsx,components/JobsSkeleton.tsx,hooks/useJobs.ts,hooks/useJobs.test.ts,hooks/useJobActions.ts,hooks/useJobActions.test.ts,services/scheduled-api.ts,services/scheduled-api.test.ts,lib/cron.ts,lib/cron.test.ts,lib/status.ts,lib/status.test.ts,index.ts}`, `apps/web/app/(app)/scheduled/page.tsx`; modify `apps/web/vitest.config.ts`.

**Agent prompt**

````
You are a senior frontend engineer (React 19 / Next.js 16 / TypeScript strict) working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: Next.js 16.3 App Router + React 19.2 · Tailwind v4 tokens · shadcn (Base UI) in `@/shared/ui` (Table, Switch, DropdownMenu, AlertDialog, Tooltip, Button, Skeleton, Badge) · Lucide · Sonner · Vitest 4 + Testing Library + MSW.
Branch feat/w1h-web-scheduled-settings (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-H — Task 1H.2 of 6 (MIDDLE)

PRECONDITIONS
- Task 1H.1 done (mock handlers for jobs; shared modules available or stubbed: `@/shared/feedback`, `@/shared/shell/PageHeader`, `@/shared/api/use-api-query`, `@/shared/transcript` helpers `relativeTime`/`formatTokens`).
- Core scheduling helpers from W1-F (`validateCron`, `describeCron`, `nextRunAt` in `@agent-hangar/core`) may or may not be merged — see deliverable 1.

REQUIRED READING (only these):
- docs/spec/10-ui-design.md § "4.3 Scheduled" (table bullets, empty state), § "2. Tokens" (tabular numerals, mono), § "6. States", § "8. Accessibility", § "9. Responsive"
- docs/spec/04-flows.md (c) Guarantees (overlap policy stated in the UI; manual run; disable removes scheduler)
- docs/spec/03-interfaces.md § "4" (`GET /api/jobs`, `PATCH`, `DELETE`, `POST /api/jobs/:id/run`)
- packages/core/src/api/contracts.ts (`jobSummary`, `jobUpsertRequest` — for the PATCH body), packages/core/src/scheduling/** (if present: exact export names), apps/web/src/shared/feedback/index.ts, apps/web/src/shared/shell/PageHeader.tsx

TASK
Build the scheduled-jobs list feature and its page.

DELIVERABLES

1. `lib/cron.ts` — the single cron adapter: `export { validateCron, describeCron, nextRunAt } from '@agent-hangar/core'` when W1-F is merged; otherwise a `TEMP-STUB(W1-H)` local implementation with the same signatures: `validateCron(cron: string): { ok: true } | { ok: false; reason: string }` (5 fields, each matching `[\d*,\-/]+|[A-Za-z]{3}` ranges), `describeCron(cron: string, timezone?: string): string` (covers `* * * * *`, `*/N * * * *`, `M H * * *`, `M H * * D[-D|,D]`, `M H D * *`, fallback "Runs on schedule <cron>"; always ends with the timezone when given), `nextRunAt({ cron, timezone }: { cron: string; timezone: string }, from?: Date): Date | null` (minute-stepping search up to 366 days using `Intl.DateTimeFormat` parts in the tz). Keep UI code agnostic: import only from `./cron` / `../lib/cron`. `lib/status.ts` — `runStatusPresentation(status: JobRunStatus): { label: string; icon: LucideIcon; tone: 'success' | 'destructive' | 'warning' | 'accent' | 'muted' }` (SUCCEEDED → "ok" `CircleCheck` success; FAILED → "fail" `CircleX` destructive; RUNNING/PREPARING → "running" `CircleDot` accent (pulse); QUEUED → "queued" `Clock` muted; CANCELLED → "cancelled" `Ban` muted; TIMED_OUT if present → "timed out" destructive) and `isRunActive(status)`.
2. `services/scheduled-api.ts` — `listJobs`, `createJob`, `updateJob(id, patch)`, `deleteJob`, `runJob`, `listRuns(jobId)`, `getRun(id)`, `getJob(id)` (if the contract has `GET /api/jobs/:id`; otherwise derive from `listJobs` and note) over `apiFetch`.
3. Hooks: `useJobs()` → `useApiQuery(['jobs'], listJobs)`; `useJobActions()` → `{ toggleEnabled(job, enabled), runNow(job), remove(job), pending: Record<string, boolean> }` — toggle is optimistic (local override map until the query refetches), `updateJob(id, { enabled })`, on error rollback + toast "Could not update job"; `runNow` → `runJob` → toast "Run started", `invalidateQueries(['runs', job.id])`, 409 → toast "Skipped: previous run still running"; `remove` → `deleteJob` → toast "Job deleted" → `invalidateQueries(['jobs'])`.
4. Components: `ScheduleCell({ cron, timezone })` — mono 13 px cron + muted `(tz)` + `Tooltip` with `describeCron(cron, timezone)`; `RunStatus({ status, at?, error? })` — icon 14 px + label text + optional `relativeTime(at)`; when `error === 'previous run still running'` add `Tooltip` "Skipped: the previous run was still running" (spec 04 (c)); `JobRowMenu({ job, onEdit, onRunNow, onDelete })` — `DropdownMenu` (`Ellipsis`, `aria-label="Actions for <name>"`) items Run now (`Play`), Edit (`Pencil`), separator, Delete (`Trash2`, destructive); `DeleteJobDialog({ job, open, onOpenChange, onConfirm, busy })` — `AlertDialog` "Delete job <name>?" body "Future runs stop; run history is deleted." Cancel/Delete; `JobRow({ job, onEdit, … })` — `TableRow` 44 px `cursor-pointer hover:bg-muted/50`, `onClick` → `router.push('/scheduled/<id>')`, cells: Name (`Link` with `font-medium`, focusable, `aria-label` name), `ScheduleCell`, `owner/repo · branch` (mono 12 px, `Box` icon), Last run (`RunStatus` with `lastRunStatus`/`lastRunAt` per contract; "—" when none), Next run (`relativeTime(nextRunAt)` tabular + tooltip absolute `toLocaleString`; "—" when disabled), Enabled (`Switch` `aria-label="Enable <name>"`, `onClick` stopPropagation), menu cell; `JobsTable({ jobs, … })` — `Table` inside `div.overflow-x-auto.rounded-[10px].border.border-border` with `caption` sr-only "Scheduled jobs", header cells uppercase 11 px muted; `JobsSkeleton` (5 rows, same columns); `JobsEmptyState({ onCreate })` (`EmptyState` icon `CalendarClock`, title "No scheduled jobs yet.", description "Jobs run your prompt in a fresh workspace on a cron schedule.", action Button "New job"); `ScheduledView({ onNewJob?, onEditJob? }: props used by 1H.3)` (`'use client'`) — `PageHeader title="Scheduled jobs" actions=<Button "New job" icon Plus>` → loading/empty/error/table.
5. `app/(app)/scheduled/page.tsx` — server component, metadata "Scheduled — Agent Hangar", renders `<ScheduledView />` from `@/features/scheduled`. `index.ts` barrel exports `ScheduledView` (and later `JobDetailView`).
6. Tests (MSW active; mock `next/navigation`): `cron.test.ts` (validate table incl. invalid, describe table for each supported shape + fallback + timezone suffix, nextRunAt for `0 9 * * 1` from a Wednesday in `America/Sao_Paulo` and in `UTC`, DST week in `Europe/Berlin`, null when unsatisfiable) — if you re-export core, still test the adapter indirectly through `ScheduleCell`/`CronPreview` and keep a thin `cron.test.ts` that asserts the exports exist; `status.test.ts`; `scheduled-api.test.ts`; `useJobs.test.ts`; `useJobActions.test.ts` (optimistic toggle + rollback on `server.use` 500, runNow success and 409 toast, remove invalidates); `ScheduleCell.test.tsx` (tooltip text), `RunStatus.test.tsx` (each status icon+text, overlap tooltip), `JobRowMenu.test.tsx`, `DeleteJobDialog.test.tsx`, `JobsTable.test.tsx` (rows, row click navigates, switch click does not navigate, name link focusable, caption), `ScheduledView.test.tsx` (loading skeleton, seeded rows, empty state with emptied store, error + retry, New job callback, delete flow end-to-end against MSW, toggle flow).
7. `vitest.config.ts`: `coverage.include` += `src/features/scheduled/**`.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- Tokens only; Lucide only; shadcn from `@/shared/ui`; no imports from `features/chats`/`features/shell`; cron helpers only via `lib/cron.ts`.
- Status is always icon + text; targets ≥ 40 px (switch and menu button hit areas padded).

Verification:
- `pnpm --filter web test -- --coverage` — green; 100×4 on `src/features/scheduled/**`
- `pnpm typecheck && pnpm lint` — exit 0
- (When W1-G's mock bootstrap is present) `NEXT_PUBLIC_API_MOCK=1 pnpm --filter web dev` → `/scheduled` shows the three jobs; toggling, Run now, Delete work; 375 px: table scrolls inside its container

Completion Protocol: update status/AC/progress in docs/tasks/wave-1h-web-scheduled-settings.md; append `- 1H.2 ✅ <date> — <summary>`; commit `feat(web): add scheduled jobs table with row actions and states`.
````

---

## Task 1H.3 — `JobDialog` + `CronField` + `CronPreview` + `TimezoneCombobox` + validation

**Status:** ✅ Done · **Priority:** P0 · **Size:** L · **Depends on:** 1H.2

**Description.** The create/edit dialog of spec 10 §4.3: shadcn `Dialog` 520 px with Name, Repository + Branch pickers (from `@/shared/repo-picker`), Cron input (mono) with a live preview line *"Runs every weekday at 09:00 (next: Mon 09:00)"* and inline error for invalid expressions, Timezone combobox (IANA list, default system), Prompt textarea (6 rows), Enabled switch, Save. Inline validation via the core `jobUpsertRequest` schema plus `validateCron`; `useJobMutations` for create/update with toasts and list invalidation. Wired into `ScheduledView` ("New job", row Edit).

**Acceptance criteria**
- [x] `JobDialog` opens in create mode (empty, enabled on, tz = system) and edit mode (prefilled); all fields have visible labels; errors under fields linked via `aria-describedby` + `aria-invalid`; Save disabled while invalid or submitting (spinner); Esc/Cancel closes without saving; focus returns to the trigger
- [x] `CronField` shows `CronPreview` live: valid → `describeCron` text + `(next: <weekday HH:mm>)` from `nextRunAt` in the selected timezone; invalid → `text-destructive` "Invalid cron expression: <reason>" and no next-run; debounce ≤ 150 ms; mono 13 px input with placeholder `0 9 * * 1-5`
- [x] `TimezoneCombobox` searchable (`Command` in a `Popover`), lists `Intl.supportedValuesOf('timeZone')` with the system zone pinned first, keyboard navigable, `aria-label="Timezone"`
- [x] Save → `POST /api/jobs` / `PATCH /api/jobs/:id` with the contract body; success → toast "Job saved", dialog closes, `invalidateQueries(['jobs'])`; API 400/409 → `ErrorCard` inside the dialog (message shown, fields keep values)
- [x] 100 % coverage on the new files

**Files to create/modify**
`apps/web/src/features/scheduled/{components/JobDialog.tsx,components/JobDialog.test.tsx,components/CronField.tsx,components/CronField.test.tsx,components/CronPreview.tsx,components/CronPreview.test.tsx,components/TimezoneCombobox.tsx,components/TimezoneCombobox.test.tsx,components/FormField.tsx,components/FormField.test.tsx,hooks/useJobMutations.ts,hooks/useJobMutations.test.ts,hooks/useJobForm.ts,hooks/useJobForm.test.ts,lib/job-form.ts,lib/job-form.test.ts,lib/timezones.ts,lib/timezones.test.ts}`; modify `components/ScheduledView.tsx` (+ test).

**Agent prompt**

````
You are a senior frontend engineer (React 19 / Next.js 16 / TypeScript strict) working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: Next.js 16.3 App Router + React 19.2 · Tailwind v4 tokens · shadcn (Base UI) in `@/shared/ui` (Dialog, Input, Textarea, Switch, Command, Popover, Button, Tooltip) · Lucide · Sonner · Zod (core contracts) · Vitest 4 + Testing Library + MSW.
Branch feat/w1h-web-scheduled-settings (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-H — Task 1H.3 of 6 (MIDDLE)

PRECONDITIONS
- Tasks 1H.1–1H.2 done (`lib/cron.ts` adapter, services, `useJobs`, `ScheduledView` with `onNewJob`/`onEditJob` props; `@/shared/repo-picker` real or stubbed).

REQUIRED READING (only these):
- docs/spec/10-ui-design.md § "4.3 Scheduled" (Job dialog bullet), § "6. States" (Error row), § "7. Motion" (dialog enter/exit), § "8. Accessibility" (errors via aria-describedby, visible labels)
- docs/spec/04-flows.md (c) steps 1–6 (validate cron, compute nextRunAt)
- packages/core/src/api/contracts.ts (`jobUpsertRequest` — exact field names: name, repoUrl, baseBranch, cron, timezone, prompt, enabled or as defined), apps/web/src/shared/repo-picker/index.ts, apps/web/src/features/scheduled/lib/cron.ts

TASK
Build the job create/edit dialog with live cron preview, timezone combobox, inline validation and mutations; wire it into the list view.

DELIVERABLES

1. `lib/timezones.ts` — `listTimezones(): string[]` (`Intl.supportedValuesOf('timeZone')` guarded with a fallback list of ~20 common zones when unavailable), `systemTimezone()` (`Intl.DateTimeFormat().resolvedOptions().timeZone` fallback `UTC`), `formatNextRun(date: Date, timezone: string): string` → `Mon 09:00` (weekday short + HH:mm in tz; adds the date `Mon 12 Aug 09:00` when more than 6 days away). `lib/job-form.ts` — `JobFormValues { name: string; repo: string | null; branch: string | null; cron: string; timezone: string; prompt: string; enabled: boolean }`, `emptyJobForm()`, `jobToForm(job: JobSummary)` (repo from `parseRepoUrl`-like logic local to this lane: derive `owner/repo` from `repoUrl`), `formToRequest(values): z.infer<typeof jobUpsertRequest>` (builds `repoUrl` `https://github.com/<repo>.git`), `validateJobForm(values): Partial<Record<keyof JobFormValues, string>>` (name required ≤ 80; repo required; branch required; cron via `validateCron` reason; timezone must be in `listTimezones()`; prompt required ≤ 4000; then `jobUpsertRequest.safeParse(formToRequest(values))` issues mapped back to fields) — pure and fully tested.
2. `hooks/useJobForm(initial?: JobSummary)` → `{ values, setField, errors, touched, touch, isValid, reset }` (validation runs on change; errors shown for touched fields or after submit attempt). `hooks/useJobMutations()` → `{ save(values, jobId?): Promise<boolean>; busy; error; clearError }` calling `createJob`/`updateJob` with `formToRequest`, toast "Job saved", `invalidateQueries(['jobs'])` and `['job', id]`; `ApiClientError` → `error` (message) and returns false.
3. `components/FormField.tsx` — `{ id, label, hint?, error?, children(render props: { id, describedBy, invalid }) }` rendering `<label htmlFor>`, hint 12 px muted, error 12 px `text-destructive` with `id=<id>-error` `role="alert"`; used by every field so aria wiring is uniform. `components/CronPreview.tsx` — `{ cron, timezone }` → memoised `validateCron`; valid → `Clock` icon + `describeCron(cron, timezone)` + ` (next: ${formatNextRun(nextRunAt({cron,timezone}), timezone)})` in 13 px muted; invalid → `TriangleAlert` + "Invalid cron expression: <reason>" `text-destructive`; empty → "Enter a cron expression (5 fields)."; `aria-live="polite"`. `components/CronField.tsx` — `FormField` + mono `Input` (`placeholder="0 9 * * 1-5"`, `spellCheck=false`, `autoComplete="off"`, `inputMode="text"`), 150 ms debounced value to `CronPreview`; quick examples row of 3 small ghost buttons (`Every day 02:00` → `0 2 * * *`, `Weekdays 09:00` → `0 9 * * 1-5`, `Every 30 min` → `*/30 * * * *`) that set the value. `components/TimezoneCombobox.tsx` — `{ value, onChange, disabled? }` trigger outline `Button` (`Globe` icon + value, `aria-label="Timezone"`, `aria-haspopup="listbox"`), `Popover` + `Command` (`CommandInput` "Search timezones…"), system zone first under "System", then all; `Check` on selected; Enter selects, Esc closes.
4. `components/JobDialog.tsx` (`'use client'`) — `{ open, onOpenChange, job?: JobSummary | null, onSaved?(job): void }`; `Dialog` content `max-w-[520px]`, title "New job" / "Edit job", description "Runs your prompt in a fresh workspace on a schedule."; fields in order: Name (`Input`), Repository (`RepoPicker`) + Branch (`BranchPicker`) in a 2-col row, Cron (`CronField`), Timezone (`TimezoneCombobox`), Prompt (`Textarea rows=6`, hint "What the agent should do each run."), Enabled (`Switch` with label "Enabled" + hint "Disabled jobs keep their history but never run."); `ErrorCard` (compact) at the bottom when `error`; footer Cancel (ghost) + Save (primary; `disabled={!isValid || busy}`; `Loader2` spinner); Enter in single-line inputs submits; `onOpenChange(false)` resets form and error; on success `onSaved(job)` + close. Motion: shadcn defaults (200 ms fade + translate) — keep.
5. Wire into `ScheduledView`: local state `{ open, job }`; "New job" and empty-state button → open create; row `onEdit` → open edit; pass `onSaved` → nothing extra (invalidate already done).
6. Tests (MSW active; user-event; fake timers for the 150 ms debounce): `timezones.test.ts` (list, system fallback, `formatNextRun` same-week vs far), `job-form.test.ts` (every validation rule, request mapping, `jobToForm` round-trip), `useJobForm.test.ts`, `useJobMutations.test.ts` (create, update, 400 → error + false, toast), `FormField.test.tsx` (aria ids), `CronPreview.test.tsx` (valid text with next run, invalid reason, empty hint, live region), `CronField.test.tsx` (debounce, examples set value), `TimezoneCombobox.test.tsx` (opens, system first, search, select, keyboard), `JobDialog.test.tsx` (create: Save disabled until valid, fill all fields incl. picker selection via MSW, submit → mock receives the contract body (assert via `server.events.on('request:match')` or a handler spy) and dialog closes + toast; edit: prefilled values and PATCH; API 400 → ErrorCard and values retained; Esc closes; focus return), `ScheduledView.test.tsx` additions (New job opens dialog; Edit opens prefilled; list refreshes after save).

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- Tokens only; Lucide only; shadcn from `@/shared/ui`; pickers only from `@/shared/repo-picker`; cron helpers only via `lib/cron.ts`.
- Validation messages short and specific; never block typing; Save state reflects validity live.

Verification:
- `pnpm --filter web test -- --coverage` — green; 100×4 on `src/features/scheduled/**`
- `pnpm typecheck && pnpm lint` — exit 0
- (With mock bootstrap) `/scheduled` → New job → type `0 9 * * 1-5` → preview "Runs every weekday at 09:00 … (next: …)"; type `0 9 * *` → inline error; Save creates a row

Completion Protocol: update status/AC/progress in docs/tasks/wave-1h-web-scheduled-settings.md; append `- 1H.3 ✅ <date> — <summary>`; commit `feat(web): add job dialog with cron preview, timezone combobox and validation`.
````

---

## Task 1H.4 — `/scheduled/[id]` detail: header, runs table, run drawer with live transcript

**Status:** ✅ Done · **Priority:** P0 · **Size:** L · **Depends on:** 1H.3

**Description.** Job detail per spec 10 §4.3: header with name, schedule, enabled toggle, Run now and Edit/Delete; runs table (Started, Duration, Trigger, Status, Tokens) newest first; clicking a run opens `RunDrawer` (shadcn `Sheet`, 720 px) with tabs Transcript / Raw output. The transcript tab reuses `Transcript` from `@/shared/transcript` in read-only mode and streams live via `useTurnEvents` on `/api/runs/:id/events` while the run is active, with a Stop button; the header shows `StatusPill`. Runs live-refresh while a run is active. Empty and error states.

**Acceptance criteria**
- [x] `/scheduled/<id>` header: name (h1), `ScheduleCell`, enabled `Switch`, "Run now" button (busy spinner; 409 → toast "Skipped: previous run still running"), overflow Edit (opens `JobDialog`) / Delete (dialog → navigate to `/scheduled`); 404 → `ErrorCard` "Job not found" + link
- [x] `RunsTable`: rows 44 px, Started (absolute + relative tooltip), Duration (`formatDuration`, live for active runs), Trigger (`Badge` "Scheduled"/"Manual"), Status (icon + text; overlap-skipped runs explain in tooltip), Tokens (tabular, in+out); newest first; click/Enter opens the drawer; empty → `EmptyState` "No runs yet." with Run now; loading skeleton; polls every 10 s while any run is active
- [x] `RunDrawer` (Sheet right, `w-[720px] max-w-[100vw]`): header with job name, started time, `StatusPill`, Stop button while active (confirm `AlertDialog` → `POST /api/turns/:id/cancel` with the run id — TurnRequest.turnId is the JobRun id; note if contracts.ts has a dedicated run cancel route), Copy run id; `Tabs`: Transcript (shared `Transcript readOnly` fed by `mapRunDetail` items + `useTurnEvents` while active; reconnect bar text when `reconnecting`) and Raw output (`pre` mono with `run.output` or "No output yet." + copy); Esc closes; focus trapped and returned
- [x] 100 % coverage on `src/features/scheduled/**`; `JobDetailView` exported from the barrel; page thin

**Files to create/modify**
`apps/web/src/features/scheduled/{components/JobDetailView.tsx,components/JobDetailView.test.tsx,components/JobHeader.tsx,components/JobHeader.test.tsx,components/RunsTable.tsx,components/RunsTable.test.tsx,components/RunRow.tsx,components/RunDrawer.tsx,components/RunDrawer.test.tsx,components/RunRawOutput.tsx,components/RunRawOutput.test.tsx,components/StopRunDialog.tsx,components/StopRunDialog.test.tsx,components/RunsSkeleton.tsx,hooks/useJob.ts,hooks/useJob.test.ts,hooks/useRuns.ts,hooks/useRuns.test.ts,hooks/useRun.ts,hooks/useRun.test.ts,hooks/useRunActions.ts,hooks/useRunActions.test.ts,lib/map-run-detail.ts,lib/map-run-detail.test.ts}`, `apps/web/app/(app)/scheduled/[id]/page.tsx`; modify `features/scheduled/index.ts`, `services/scheduled-api.ts` (+ `cancelRun`).

**Agent prompt**

````
You are a senior frontend engineer (React 19 / Next.js 16 / TypeScript strict) working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: Next.js 16.3 App Router + React 19.2 · Tailwind v4 tokens · shadcn (Base UI) in `@/shared/ui` (Sheet, Tabs, Table, Badge, Switch, DropdownMenu, AlertDialog, Button, Tooltip, Skeleton) · Lucide · Sonner · Vitest 4 + Testing Library + MSW.
Branch feat/w1h-web-scheduled-settings (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-H — Task 1H.4 of 6 (MIDDLE)

PRECONDITIONS
- Tasks 1H.1–1H.3 done. `@/shared/transcript` (real or stub) exposes `Transcript`, `StatusPill`, `useTurnEvents`, `createInitialState`, types, `formatDuration`, `formatTokens`, `relativeTime`, and `@/shared/transcript/testing` exposes `createFakeEventSourceFactory`. Mock `GET /api/runs/:id/events` streams the scripted turn.

REQUIRED READING (only these):
- docs/spec/10-ui-design.md § "4.3 Scheduled" (Job detail bullet), § "5. Components" (`RunsTable`, `RunDrawer`, Tabs usage), § "6. States", § "7. Motion" (sheet), § "8. Accessibility"
- docs/spec/04-flows.md (c) steps 8–17 and Guarantees; (a) edge cases reconnect/expired (apply to run streams)
- docs/spec/03-interfaces.md § "4" (`GET /api/jobs/:id/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/events`, `POST /api/turns/:id/cancel`), § "3" (`TurnRequest.turnId` = JobRun.id)
- packages/core/src/api/contracts.ts (`runSummary`, `runDetail`, `routes`), apps/web/src/shared/transcript/index.ts (export names), docs/tasks/wave-1g-web-chats.md Task 1G.6 deliverable 1 (`mapChatDetail` — mirror its approach for runs)

TASK
Build the job detail page with the runs table and the run drawer that reuses the shared transcript with live SSE.

DELIVERABLES

1. `lib/map-run-detail.ts` — `mapRunDetail(run: RunDetail, job?: JobSummary): { items: TranscriptItem[]; phase: TurnPhase; startedAt: number | null; finishedAt: number | null }`: first item `user` with the job prompt (from `run.prompt` if the contract stores it, else `job.prompt`), tool call logs → `tool` items (status mapping like chats), `run.output` → final `assistant` item when present, `run.error` → `error` item (+ overlap-skipped runs get a `notice` tone warning "Skipped: previous run still running"); status → phase (`QUEUED→queued`, `PREPARING→preparing`, `RUNNING→running`, `SUCCEEDED→succeeded`, `FAILED→failed`, `CANCELLED→cancelled`). Field names per contracts.ts.
2. Services: add `cancelRun(runId)` → `POST /api/turns/:id/cancel` with the run id (if `routes` has a dedicated run cancel route, use it and note). Hooks: `useJob(id)` → `useApiQuery(['job', id], …)` (+ `notFound`); `useRuns(jobId, { live })` → `useApiQuery(['runs', jobId], …, { refetchIntervalMs: live ? 10_000 : undefined })`; `useRun(runId | null)` → enabled when set; `useRunActions()` → `{ runNow(job), stop(runId), copyId(runId) }` with toasts ("Run started", "Stop requested", "Run id copied") and invalidations (`['runs', jobId]`, `['run', runId]`).
3. Components: `JobHeader({ job, onEdit, onDelete, onToggle, onRunNow, busy })` — `PageHeader` with `leading` back link (`ArrowLeft`, `aria-label="Back to scheduled jobs"`, `/scheduled`), title = name, actions: `ScheduleCell`, `Switch` (`aria-label="Enable <name>"`), `Button "Run now"` (`Play`, spinner when busy), `DropdownMenu` (`Ellipsis`, "Job actions": Edit, Delete destructive); `RunRow({ run, onOpen })` — `TableRow` clickable + Enter on the focused Started cell link-button; cells: Started (`toLocaleString` + tooltip relative), Duration (`formatDuration(finishedAt - startedAt)` or live ticking for active runs via a 1 s interval hook local to the row — or reuse `useElapsed` if exported by the shared barrel), Trigger (`Badge variant="outline"` "Scheduled"/"Manual"), Status (`RunStatus`), Tokens (`formatTokens(input + output)` tabular; "—" when absent); `RunsTable({ runs, onOpen })` in `overflow-x-auto` container with sr-only caption "Runs"; `RunsSkeleton`; `RunRawOutput({ output })` — `pre` mono 13 px `bg-muted` rounded, `max-h-[60vh] overflow-auto`, copy button (`aria-label="Copy output"`), "No output yet." when empty; `StopRunDialog` — `AlertDialog` "Stop this run?" Keep running / Stop; `RunDrawer({ runId, job, open, onOpenChange, createEventSource? })` (`'use client'`) — `Sheet side="right"` content `sm:max-w-[720px] w-full p-0 flex flex-col`, `SheetHeader`: job name (title), "Started <absolute>" muted, `StatusPill(phase, startedAt, finishedAt)`, Stop button while `preparing|running` (`Square`, opens `StopRunDialog` → `stop(runId)`), Copy run id icon button; `Tabs defaultValue="transcript"`: "Transcript" → `useRun(runId)` loading skeleton / error card / `Transcript readOnly items={state.items} phase={state.phase}` where `state` comes from `useTurnEvents({ url: active ? <runs events path for runId> : null, initialItems, initialPhase, createEventSource })` (dispatch `reset` when the run detail refetches); thin "Reconnecting…" bar (same treatment as spec 10 §4.2) when `state.connection === 'reconnecting'`; on `expired` → `refetch` run detail once; "Raw output" → `RunRawOutput` with `run.output` (or, while active, the last assistant item text); on terminal phase reached via SSE → `invalidateQueries(['runs', job.id])` so the table updates. `JobDetailView({ jobId })` — `useJob` (404 → `PageHeader "Job"` + `ErrorCard "Job not found"` with link `/scheduled`; loading skeleton), `useRuns(jobId, { live: anyActive })`, `JobHeader`, runs section (`h2` "Runs" 11 px uppercase) → table/empty (`EmptyState` `History` icon "No runs yet." "Run now to start one in a fresh workspace." action Run now)/error; `JobDialog` for Edit; `DeleteJobDialog` → `router.push('/scheduled')`; `RunDrawer` state `{ runId | null }`; `?run=<id>` query param opens the drawer on load (useSearchParams) and is updated on open/close (`router.replace`).
4. `app/(app)/scheduled/[id]/page.tsx` — server component with async `params` → `<JobDetailView jobId={id} />`; metadata "Job — Agent Hangar". Barrel exports `JobDetailView`.
5. Tests (MSW active; fake EventSource injected through `RunDrawer`/`JobDetailView` `createEventSource` prop): `map-run-detail.test.ts` (every status, prompt source precedence, output/error/overlap notice), `useJob/useRuns/useRun/useRunActions.test.ts` (incl. live polling with fake timers, 409 on runNow, stop toast), `JobHeader.test.tsx` (actions, toggle, busy), `RunsTable.test.tsx` (rows newest first, trigger badges, tokens format, active duration ticks, click/Enter opens), `RunRawOutput.test.tsx` (empty, copy), `StopRunDialog.test.tsx`, `RunDrawer.test.tsx` (opens with header + pill, transcript from persisted run, live stream via fake EventSource: tool row running → done, final text, pill Done; stop flow hits cancel endpoint; reconnecting bar; expired → refetch; raw tab shows output and copies; Esc closes and focus returns; `sm:max-w-[720px]` class present), `JobDetailView.test.tsx` (loading, not found, header + runs, empty runs state, Run now adds a row, row click opens drawer, `?run=` deep link, edit dialog prefilled, delete navigates).

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- Tokens only; Lucide only; shadcn from `@/shared/ui`; `Transcript`/`StatusPill`/`useTurnEvents` only from `@/shared/transcript` — never from `features/chats`.
- Sheet width 720 px per spec; tables scroll inside their container; Esc handling must not fight the Sheet's own Esc (Stop dialog only opens from the button).

Verification:
- `pnpm --filter web test -- --coverage` — green; 100×4 on `src/features/scheduled/**`
- `pnpm typecheck && pnpm lint` — exit 0
- (With mock bootstrap) `/scheduled` → "Nightly tests" → runs table; open the RUNNING run → transcript streams, Stop asks for confirmation; Raw output tab works; Run now on the same job → "Skipped…" toast

Completion Protocol: update status/AC/progress in docs/tasks/wave-1h-web-scheduled-settings.md; append `- 1H.4 ✅ <date> — <summary>`; commit `feat(web): add job detail with runs table and live run drawer`.
````

---

## Task 1H.5 — `/settings`: credentials card with masked secret fields, environment card

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 1H.1

**Description.** Settings per spec 10 §4.4: a **Credentials** card (GitHub Personal Access Token, OpenAI API key) where each `SecretField` is `type=password`, never pre-filled, shows `••••••••<last4>` in mono once set with "updated <relative>" and switches to Replace/Remove (Remove confirms in an `AlertDialog`), Save shows a toast ("GitHub token saved"), errors inline; helper text states the required scopes and that values only leave the machine to GitHub/OpenAI; model line from `OPENAI_MODEL`; an **Environment** card (`EnvSummary`) rendering the `/api/health` summary (instance · ports · docker ✓). `useSettings` + `useSecretMutations` + `useHealthSummary`.

**Acceptance criteria**
- [x] `/settings` shows both cards; `SecretField` states: loading skeleton · unset (password input, Save disabled until non-empty) · set (mask `••••••••<last4>` mono + "updated 3 days ago" + Replace/Remove) · replacing (input + Save/Cancel) · saving (spinner, disabled) · error (inline under the field, `aria-describedby`); after save the input is cleared and the mask shows the new last4; canary plaintext never appears in the DOM after save (test)
- [x] Remove → `AlertDialog` "Remove <label>?" body "Workspaces will start without it until you add a new one." Cancel/Remove → `DELETE` → toast "<label> removed" → unset state
- [x] Helper texts: GitHub — "Needs repo scope (read + push) for the repositories you want to use."; both — "Stored encrypted on this machine. Only sent to GitHub / OpenAI." (card description: "Stored encrypted on this machine. Injected into workspaces at start."); inputs `autoComplete="off"`, `spellCheck=false`, visible labels
- [x] Model line "Model <mono id> (from OPENAI_MODEL)"; `EnvSummary` renders instance and each dependency as icon + text from `healthResponse` (no `ports` field: the frozen contract's `healthResponse` carries `ok`/`instance`/`checks` only, no port numbers — flagged as a contract-change-request candidate, not added speculatively); infra-down scenario → destructive items; loading skeleton; error → `ErrorCard` + Retry
- [x] 100 % coverage on `src/features/settings/**`; `coverage.include` extended; page thin; Lighthouse a11y ≥ 95 on `/settings` deferred to 1H.6's single batch run across all three pages

**Files to create/modify**
`apps/web/src/features/settings/{components/SettingsView.tsx,components/SettingsView.test.tsx,components/CredentialsCard.tsx,components/CredentialsCard.test.tsx,components/SecretField.tsx,components/SecretField.test.tsx,components/RemoveSecretDialog.tsx,components/RemoveSecretDialog.test.tsx,components/ModelLine.tsx,components/EnvironmentCard.tsx,components/EnvSummary.tsx,components/EnvSummary.test.tsx,hooks/useSettings.ts,hooks/useSettings.test.ts,hooks/useSecretMutations.ts,hooks/useSecretMutations.test.ts,hooks/useHealthSummary.ts,hooks/useHealthSummary.test.ts,services/settings-api.ts,services/settings-api.test.ts,lib/secrets.ts,lib/secrets.test.ts,lib/health.ts,lib/health.test.ts,index.ts}`, `apps/web/app/(app)/settings/page.tsx`; modify `apps/web/vitest.config.ts`.

**Agent prompt**

````
You are a senior frontend engineer (React 19 / Next.js 16 / TypeScript strict) working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: Next.js 16.3 App Router + React 19.2 · Tailwind v4 tokens · shadcn (Base UI) in `@/shared/ui` (Card, Input, Button, AlertDialog, Skeleton, Tooltip, Separator) · Lucide · Sonner · Vitest 4 + Testing Library + MSW.
Branch feat/w1h-web-scheduled-settings (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-H — Task 1H.5 of 6 (MIDDLE)

PRECONDITIONS
- Task 1H.1 done (mock `PUT`/`DELETE /api/settings/:key`; W1-G's `GET /api/settings` and `GET /api/health` real or stubbed; `@/shared/feedback`, `@/shared/shell/PageHeader`, `@/shared/api/use-api-query`, `relativeTime` from `@/shared/transcript`).

REQUIRED READING (only these):
- docs/spec/10-ui-design.md § "4.4 Settings" (wireframe + bullet), § "6. States", § "8. Accessibility"
- docs/spec/04-flows.md (d) SAVE steps 1–8 and the "Controls" table (UI, Transport rows)
- docs/spec/03-interfaces.md § "4" (`GET /api/settings`, `PUT`/`DELETE /api/settings/:key`, `GET /api/health`), § "6" (`SecretKey`)
- docs/spec/06-testing.md § "4" `settings-save-mask.spec` row (selectors W2-C will use — expose `data-testid="secret-field-<key>"` and `data-testid="secret-mask-<key>"`)
- packages/core/src/api/contracts.ts (`settingsStatus`, `putSecretRequest`, `healthResponse`), packages/core/src/secrets/types.ts

TASK
Build the settings feature: credentials card with masked secret fields and replace/remove, model line, environment card, hooks and page.

DELIVERABLES

1. `lib/secrets.ts` — `SECRET_FIELDS: readonly { key: SecretKey; label: string; placeholder: string; helper: string; toastName: string; statusKey: 'githubPat' | 'openaiKey' }[]` (GitHub Personal Access Token: placeholder `ghp_…`, helper "Needs repo scope (read + push) for the repositories you want to use.", toastName "GitHub token"; OpenAI API key: placeholder `sk-…`, helper "Used by the agent inside workspaces to call OpenAI.", toastName "OpenAI API key") — map `statusKey` to the exact `settingsStatus` field names; `maskSecret(last4: string | undefined): string` → `••••••••` + last4 (8 bullets; empty last4 → 8 bullets only); `validateSecretInput(value): string | null` (trimmed non-empty, no whitespace inside, ≤ 512 chars; no shape validation — tokens vary). `lib/health.ts` — `summarizeHealth(h: HealthResponse): { instance?: string; ports?: { web; postgres; redis }; checks: { id: string; label: string; ok: boolean; detail?: string }[]; allOk: boolean }` mapping the contract fields (Postgres, Redis, Docker, Workspace image).
2. `services/settings-api.ts` — `getSettings(signal)`, `putSecret(key, value)`, `deleteSecret(key)`, `getHealth(signal)` over `apiFetch`. Hooks: `useSettings()` → `useApiQuery(['settings'], getSettings)`; `useSecretMutations()` → `{ save(key, value): Promise<boolean>; remove(key): Promise<boolean>; pending: Partial<Record<SecretKey, 'saving' | 'removing'>>; errors: Partial<Record<SecretKey, string>>; clearError(key) }` with toasts "<toastName> saved" / "<toastName> removed", `invalidateQueries(['settings'])` (the composer gate in chats reads the same key), `ApiClientError` → field error; `useHealthSummary()` → `useApiQuery(['health'], getHealth, { refetchIntervalMs: 30_000 })` + `summarizeHealth`.
3. Components: `SecretField({ field, status: { set: boolean; last4?: string; updatedAt?: string } | undefined, loading, pending, error, onSave(value), onRemove(), onClearError })` (`'use client'`): `data-testid="secret-field-<key>"`; visible `<label>` 14 px/500; loading → `Skeleton` input; **unset**: `Input type="password"` (`autoComplete="off"`, `spellCheck={false}`, `placeholder`, `aria-describedby` helper + error ids, `aria-invalid` when error), Save button (disabled until `validateSecretInput` passes; `Loader2` while saving); **set**: mono 13 px box (`data-testid="secret-mask-<key>"`, `aria-label="<label> ending in <last4>"`) with `maskSecret(last4)`, muted "updated <relativeTime(updatedAt)>" (or "set" when no date), buttons Replace (`RefreshCw`, switches to replacing) and Remove (`Trash2`, `text-destructive`, opens `RemoveSecretDialog`); **replacing**: input + Save + Cancel (returns to set, clears value); after a successful save the local input value is cleared (`useEffect` on `status.last4` change) and state returns to set; error text `text-destructive` 12 px `role="alert"`; helper 12 px muted; Enter in the input submits. `RemoveSecretDialog({ field, open, onOpenChange, onConfirm, busy })` — `AlertDialog` title "Remove <label>?" body "Workspaces will start without it until you add a new one." Cancel / Remove (destructive). `ModelLine({ model })` — "Model" label + mono `model` + muted "(from OPENAI_MODEL)". `CredentialsCard({ settings, loading, error, refetch })` — `Card` title "Credentials", description "Stored encrypted on this machine. Injected into workspaces at start.", both `SecretField`s separated by `Separator`, footer note 12 px muted "Values never leave this machine except to GitHub and OpenAI.", `ModelLine`; error → `ErrorCard` + Retry. `EnvSummary({ summary })` — line "Instance <name> · web :<port> · postgres :<port> · redis :<port>" (tabular mono) when present, then a compact list of checks: icon (`CircleCheck` success / `CircleX` destructive) + label + detail; `role="list"`. `EnvironmentCard` — `Card` title "Environment", description "Read-only summary of this instance. Run `pnpm doctor` for details.", `EnvSummary` / skeleton / `ErrorCard` + Retry. `SettingsView` (`'use client'`) — `PageHeader title="Settings"`, column `max-w-[840px] mx-auto p-6 gap-6` with both cards.
4. `app/(app)/settings/page.tsx` — server component, metadata "Settings — Agent Hangar", renders `<SettingsView />`. Barrel exports `SettingsView`.
5. Tests (MSW active; canaries `GITHUB_CANARY`/`OPENAI_CANARY` from `@agent-hangar/core/testing` as the typed values): `secrets.test.ts` (fields table completeness, mask table incl. empty, validation table), `health.test.ts` (mapping, `allOk`, missing optional fields), `settings-api.test.ts`, `useSettings.test.ts`, `useSecretMutations.test.ts` (save success → toast + invalidate; 400 → error; remove; pending states), `useHealthSummary.test.ts` (interval with fake timers; `infra-down` scenario), `SecretField.test.tsx` (every state; Save disabled/enabled; Enter submits; after save the input value is empty and the mask shows the canary's last4 while the full canary is absent from `document.body.innerHTML`; Replace → input → Cancel; Remove opens dialog; error aria wiring; `type="password"` and `autocomplete=off` attributes), `RemoveSecretDialog.test.tsx`, `EnvSummary.test.tsx` (ok/fail rendering, instance/ports line present/absent), `CredentialsCard.test.tsx`, `SettingsView.test.tsx` (end-to-end against MSW: start with `missing-settings` scenario → both unset → save both → masks → reload query shows set → remove one → unset; health card content; error + retry).
6. `vitest.config.ts`: `coverage.include` += `src/features/settings/**`.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- Tokens only; Lucide only; shadcn from `@/shared/ui`; no imports from `features/*`.
- Inputs are never pre-filled; no secret value is kept in React state after a successful save; never log or toast the value.

Verification:
- `pnpm --filter web test -- --coverage` — green; 100×4 on `src/features/settings/**`
- `pnpm typecheck && pnpm lint` — exit 0
- (With mock bootstrap) `/settings` → paste a canary → Save → mask with last4 + toast → Replace/Remove work → Environment card shows instance/ports; `ah-mock-scenario=infra-down` → destructive checks

Completion Protocol: update status/AC/progress in docs/tasks/wave-1h-web-scheduled-settings.md; append `- 1H.5 ✅ <date> — <summary>`; commit `feat(web): add settings page with masked credentials and environment summary`.
````

---

## Task 1H.6 — Close-out: gates, Lighthouse a11y, code review, stub removal at rebase, dashboard, PR

**Status:** ✅ Done · **Priority:** P0 · **Size:** S · **Depends on:** 1H.1–1H.5

**Description.** Rebase onto `main` after W1-G (and W1-F) merged, delete every `TEMP-STUB(W1-H)` file and swap `lib/cron.ts` to the core exports, run every gate, capture Lighthouse accessibility ≥ 95 for `/scheduled`, `/scheduled/[id]` and `/settings` with mocks, run `/bymax-quality:code-review` to zero findings, update the plan dashboard and the tasks index, open the PR with screenshots, and return the structured summary.

**Acceptance criteria**
- [x] Branch rebased on latest `main` containing W1-G; `grep -rn "TEMP-STUB(W1-H)" apps/web` → no matches; temporary `coverage.exclude` entries removed; `lib/cron.ts` delegates to `@agent-hangar/core`
- [x] `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` green; coverage 100/100/100/100 on every owned `src/**` path listed in `vitest.config.ts`
- [x] Lighthouse accessibility 100 on `/scheduled`, a seeded `/scheduled/<id>` and `/settings` (mocks on), with no failing audit; 375/768/1024/1440 px checked in both themes; no horizontal page scroll
- [x] Code review run with the findings resolved; `docs/plan.md` §12 row W1-H → 🟨 with branch + PR; `docs/tasks/README.md` row updated; this file's header Status → 🟨 PR open
- [x] PR opened; returned `{ pr, branch, headSha, gates, coverage, contractChangeRequests }`

**Files to create/modify**
`docs/plan.md` (§12 row W1-H), `docs/tasks/README.md` (W1-H row), `docs/tasks/wave-1h-web-scheduled-settings.md` (header/log), stub deletions under `apps/web/src/**`, `apps/web/vitest.config.ts` (remove temporary excludes), `apps/web/src/features/scheduled/lib/cron.ts` (swap to core).

**Agent prompt**

````
You are a senior engineer closing out the W1-H lane of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 · Node 24 · Next.js 16.3 + React 19.2 · Tailwind v4 + shadcn · Vitest 4 + Testing Library + MSW 2 · GitHub CLI.
Branch feat/w1h-web-scheduled-settings (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-H — Task 1H.6 of 6 (LAST)

PRECONDITIONS
- Tasks 1H.1–1H.5 done and committed on this branch.
- W1-G merged to main (plan §11 merge order: "W1-G before W1-H's final rebase"); if it is not merged yet, stop and report to the orchestrator instead of opening a PR with stubs.

REQUIRED READING (only these):
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard", § "6. Wave 1" W1-H DONE line and the coordination note
- docs/spec/10-ui-design.md § "10. Pre-delivery checklist"
- docs/tasks/README.md, apps/web/vitest.config.ts, apps/web/src/mocks/handlers.ts (the append line after rebase)

TASK
Rebase onto main, remove every temporary stub, run all gates and the code review, capture accessibility evidence, update dashboards, open the PR, return the structured summary. Do not wait for CI; do not merge.

DELIVERABLES

1. Rebase: `git fetch origin && git rebase origin/main`; resolve conflicts in `apps/web/src/mocks/handlers.ts` (keep W1-G's list + your additive spreads), `apps/web/vitest.config.ts` (union of `coverage.include`; drop your temporary `coverage.exclude` stub entries), and delete every file whose first line contains `TEMP-STUB(W1-H)` (`grep -rln "TEMP-STUB(W1-H)" apps/web/src | xargs git rm`); swap `features/scheduled/lib/cron.ts` to `export { validateCron, describeCron, nextRunAt } from '@agent-hangar/core';` (adjust names to W1-F's actual exports; if signatures differ, adapt inside this single file and keep the UI untouched); if W1-G's `src/mocks/vitest.ts` resets stores, wire `resetScheduledStore()` through your own tests' `afterEach` only (do not edit W1-G's file; mention in the PR that W3-A may centralise it). Re-run the whole suite.
2. Gates: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm --filter web test -- --coverage` — green; paste the coverage table for `src/features/scheduled/**`, `src/features/settings/**`, `src/mocks/scheduled.ts`, `src/mocks/settings.ts` into the PR.
3. Spec 10 §10 checklist on the mocked app (`NEXT_PUBLIC_API_MOCK=1 pnpm --filter web dev`): tokens only (`grep -rn "#[0-9a-fA-F]\{3,8\}" apps/web/src/features/scheduled apps/web/src/features/settings` → none), Lucide only, `cursor-pointer` + hover/focus on interactive elements, keyboard-only walkthrough (jobs table → menu → dialog → save; detail → run row → drawer → tabs → stop; settings → save → replace → remove), `prefers-reduced-motion` emulation, widths 375/768/1024/1440 (tables scroll inside containers; sheet ≤ 100vw), both themes side by side. Fix what fails.
4. Lighthouse: `pnpm dlx lighthouse http://127.0.0.1:<WEB_PORT>/scheduled --only-categories=accessibility --chrome-flags="--headless=new" --output=html --output-path=./reports/lighthouse-scheduled.html`, same for a seeded `/scheduled/<id>` and `/settings`; ≥ 95 each (fix and re-run otherwise); attach screenshots to the PR description after creation and write the numeric scores in the body.
5. Run `/bymax-quality:code-review` (full) on `main..HEAD`; fix every finding (CRITICAL, HIGH, MEDIUM, LOW) without suppressions; re-run gates after fixes; unfixed findings need a one-line justification under "Review notes". Ensure `git log main..HEAD` messages are Conventional Commits, English, no attribution trailers; confirm the diff touches only owned paths + the `handlers.ts` append line + `vitest.config.ts` include lines (`git diff --stat origin/main..HEAD`).
6. Dashboards: `docs/plan.md` §12 row W1-H → `🟨 PR open` with `feat/w1h-web-scheduled-settings / #<n>`; `docs/tasks/README.md` W1-H row; this file's header `Status` → 🟨 PR open and `Progress` 6/6.
7. `gh pr create --base main --title "feat(web): scheduled jobs and settings screens against mocked API (W1-H)" --body-file <generated>`; body: Summary · Shared modules consumed from W1-G (list) and the one-line `handlers.ts` append · How to run (`NEXT_PUBLIC_API_MOCK=1 pnpm dev`; scenarios `missing-settings`, `infra-down`) · Screenshots (jobs table 1440/375, job dialog with preview + validation error, job detail with run drawer streaming, settings unset/set/replace/remove dialog, light theme) · Lighthouse scores + screenshots · Gate results + coverage table · Review notes · Contract change requests (e.g. dedicated run-cancel route, `GET /api/jobs/:id` if absent) · Known gaps (run virtualisation > 200 rows → W3-A; real API wiring → W2-A).
8. Return to the orchestrator: `{ pr, branch, headSha, gates: { lint, format, typecheck, unit }, coverage: { lines, branches, functions, statements }, contractChangeRequests: [...] }`.

Constraints:
- English; Conventional Commits; no AI attribution anywhere (commits, PR, comments).
- Do not edit paths outside the lane's owned list except `docs/plan.md` §12 row and `docs/tasks/README.md` row.
- Do not wait for CI; do not merge.

Verification:
- `grep -rn "TEMP-STUB(W1-H)" apps/web` — no output
- `gh pr view --json number,headRefOid,url` — PR exists and matches the returned values
- `git status --porcelain` — clean; `git diff --stat origin/main..HEAD` — only owned paths

Completion Protocol: update status/AC/progress in docs/tasks/wave-1h-web-scheduled-settings.md (lane header Status → 🟨 PR open); append `- 1H.6 ✅ <date> — PR #<n> opened`; commit `chore(web): close out W1-H lane` before opening the PR.
````

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)
- 1H.1 ✅ 2026-08-19 — Added `src/mocks/{scheduled,settings}.ts` + tests (100×4) over local `TEMP-STUB(W1-H)` copies/minimal implementations of W1-G's not-yet-merged shared modules (`shared/api/use-api-query.ts`; `shared/transcript/{types,reducer,lib/format,lib/redact-display,hooks/useTurnEvents,testing/*,components/{Transcript,StatusPill},index}.ts(x)`; `shared/repo-picker/*`; `shared/feedback/*`; `shared/shell/PageHeader.tsx`; `mocks/{store,scenario,events,server,vitest}.ts`) and a real (non-stub) `src/mocks/handlers.ts`; stub list: `apps/web/src/mocks/{events,scenario,server,store,vitest}.ts`, `apps/web/src/shared/api/use-api-query.ts`, `apps/web/src/shared/feedback/{EmptyState.tsx,ErrorCard.tsx,index.ts}`, `apps/web/src/shared/repo-picker/{BranchPicker.tsx,RepoPicker.tsx,index.ts}`, `apps/web/src/shared/shell/PageHeader.tsx`, `apps/web/src/shared/transcript/{components/StatusPill.tsx,components/Transcript.tsx,hooks/useTurnEvents.ts,index.ts,lib/format.ts,lib/redact-display.ts,reducer.ts,testing/fake-event-source.ts,testing/index.ts,types.ts}`.
- 1H.2 ✅ 2026-08-19 — Added `JobsTable` (+ `JobRow`, `JobRowMenu`, `RunStatus`, `ScheduleCell`, `DeleteJobDialog`, empty/skeleton states), `useJobs`/`useJobActions`, the `scheduled-api` service, the local `lib/cron.ts` adapter (`TEMP-STUB(W1-H)`, swapped to `@agent-hangar/core` once W1-F merges) and `lib/status.ts`, and wired `ScheduledView` into `/scheduled`; fixed a real bug found along the way in the `TEMP-STUB(W1-H)` `use-api-query.ts` (an unmemoized loader made `run`'s identity change every render, re-running the fetch effect on every render) — held the latest loader in a ref instead so `run`/`refetch` stay referentially stable.
- 1H.3 ✅ 2026-08-19 — Added `JobDialog` (+ `FormField`, `CronField`, `CronPreview`, `TimezoneCombobox`), `useJobForm`/`useJobMutations`, `lib/job-form.ts` and `lib/timezones.ts`; wired create/edit into `ScheduledView` (replacing the 1H.2 placeholder `onNewJob`/`onEditJob` props with an internal dialog state). `TimezoneCombobox` uses the existing dialog-based `Command` composition instead of a `Command`-in-`Popover` (spec 10 §4.3's literal ask) — `@/shared/ui` has no `Popover` primitive yet; noted as a contract/spec-drift item for the PR body. Fixed two more real bugs found writing tests: `listTimezones()` didn't guarantee `UTC` itself (only `Intl.supportedValuesOf('timeZone')`'s entries, which on this runtime omits bare `UTC`) even though the app's own mocks/defaults use it; and `CommandDialog` (shared/ui) doesn't wrap its children in the `Command` root itself, so every consumer must do so.
- 1H.4 ✅ 2026-08-19 — Added `JobDetailView` (+ `JobHeader`, `RunsTable`/`RunRow`, `RunsSkeleton`, `RunDrawer`, `RunRawOutput`, `StopRunDialog`), `useJob`/`useRuns`/`useRun`/`useRunActions`, `lib/map-run-detail.ts`, and `cancelRun` on the `scheduled-api` service; wired into `/scheduled/[id]`. `RunDrawer` reuses `@/shared/transcript`'s `Transcript`/`StatusPill`/`useTurnEvents` read-only, streaming live via SSE while a run is active and falling back to the persisted `RunDetail` otherwise. Reaching 100 % branch coverage surfaced a recurring, genuinely dead-branch pattern (an `error?.message ?? ''`/`output ?? ''` fallback whose non-null side is unreachable once gated behind the same status check that guarantees it) — resolved by hoisting each fallback to an unconditional per-render `const`, which lets both sides get exercised naturally across the existing test suite instead of needing an artificial test or a suppression.
- 1H.5 ✅ 2026-08-19 — Added `SettingsView` (+ `CredentialsCard`, `SecretField`, `RemoveSecretDialog`, `ModelLine`, `EnvironmentCard`, `EnvSummary`), `useSettings`/`useSecretMutations`/`useHealthSummary`, `lib/secrets.ts`/`lib/health.ts`, and the `settings-api` service; wired into `/settings`. Added two more `TEMP-STUB(W1-H)` mock handlers this lane didn't own before — `src/mocks/settings-status.ts` (`GET /api/settings`) and `src/mocks/health.ts` (`GET /api/health`), copied in spirit from W1-G's not-yet-merged versions but reading the local stub `store`/`scenario` — since neither existed yet on this branch and `useSettings`/`useHealthSummary` need them; both excluded from the coverage gate like the other foundation stubs and deleted at the 1H.6 rebase. `SecretField`'s reset-on-save-effect (`useEffect` calling `setValue`/`setReplacing` when `status.last4` changes) tripped the `react-hooks/set-state-in-effect` rule; fixed by adjusting the state during render instead (comparing against a tracked `syncedLast4`), React's documented alternative to an effect for "reset state when a prop changes". The `healthResponse` contract has no `ports` field (only `ok`/`instance`/`checks`), so `EnvSummary` renders instance + the four dependency checks without a ports line — flagged as a contract-change-request candidate for 1H.6 rather than added speculatively. Caught and fixed two literal secret-shaped test strings (`'ghp_abcd1234'`, `'sk-abcd1234'`) that slipped in before the canary-only rule was re-checked; replaced with `GITHUB_CANARY`/`OPENAI_CANARY`.
- 1H.6 ✅ 2026-08-19 — Rebased onto `main` with W1-G merged and deleted every `TEMP-STUB(W1-H)` file, taking `main`'s real modules wholesale; the placeholders' interfaces turned out to differ from the real ones in six places, each fixed on the screen side rather than by bending the shared module: `relativeTime(iso, now)` takes an explicit clock (call sites anchor to a mount-time instant via `useState`, since reading the clock during render is impure), `StatusPill` requires `startedAt`, `RepoPicker` hands back a `RepoSummary` rather than a name (reduced by a new `repoFullName` helper), `mocks/vitest.ts` is a global setup file with no `registerMockServer` export, `scriptedTurnFrames` takes `baseMs` and no `prompt` and its frames carry `unknown` payloads (parsed with `agentEventSchema` instead of asserted), and the seeded mock store already holds both credentials (the settings tests that need an empty instance now select the `missing-settings` scenario). `lib/cron.ts` stopped being a local cron implementation and became a thin adapter over `@agent-hangar/core`'s scheduler: core throws `InvalidCronError` where the screens need a value, so the adapter is the one place that converts, and `CronPreview` collapsed to a single path — a schedule with no next run is exactly a schedule that has no description either. Two defects surfaced and were fixed: the run-cancel mock shadowed the chat mock on the shared `POST /api/turns/:id/cancel` route (it now returns nothing for ids it does not own and is ordered ahead of the chat handler, which owns the turn case), and the jobs table's row-menu column had an empty header, leaving its cells unassociated (`td-has-header`) — now an `sr-only` "Actions" header. Lighthouse accessibility 100 on `/scheduled`, `/scheduled/job-nightly-tests` and `/settings` with no failing audit; no horizontal page scroll at 375/768/1024/1440 px in either theme. `healthResponse` still has no `ports` field on `main` — it exists only on the unmerged W2-A branch — so the environment card still cannot render the instance's ports line; carried forward as a contract change request rather than guessed at.
- 1H.6 (review) ✅ 2026-08-19 — Applied the review findings. The optimistic `enabled` override was never cleared on success, so a later save through the job dialog was permanently shadowed by the stale toggle; the override now records the `updatedAt` it was applied to and `resolveEnabled` discards it the moment the server returns a newer revision (and `toggleEnabled` invalidates `['job', id]` as well as `['jobs']`, which prefix matching does not cover). The detail page's enable switch had no in-flight guard, unlike the list row — a second click could race the first; it is disabled while a toggle is pending. Reopening the run drawer on the same run kept showing the transcript as of the moment it was closed, because the reseed was keyed only on the run id while the query is disabled and the stream disconnected in between; the seed is now forgotten on close. A schema-level rejection was reported under the Prompt textarea whatever field it concerned; issues are now mapped to their own field through `formFieldForIssue`. `map-run-detail.ts` asserted `call.toolName as ToolName` over a contract that types it as a free string; it parses with `toolNameSchema` and falls back to a known tool, matching the chat mapper. Four headers naming "another lane" were rewritten as timeless statements.
- 1H.6 (PR) ✅ 2026-08-19 — PR #24 opened against `main`.
- 1H.6 (PR review) ✅ 2026-08-20 — Six findings from the pull request; five verified real and fixed, one not reproducible. Fixed: the runs table opened a run only through a row-level pointer handler, so no run could be opened by keyboard or switch access — the started-at cell now carries a real button (`Open run from …`) that stops propagation so a pointer click still opens the run once. `remove` swallowed a deletion failure and resolved normally, so the list closed its confirmation and the detail page navigated back while the job still existed; it returns a boolean and both callers act on it. A failed job load rendered the bare header for ever with the query's error unused; it now shows the same `ErrorCard` with Retry the runs query beside it already used. "Is this run active" had two answers — the drawer excluded queued while `isRunActive` and the cancel mock included it, so a queued run could be neither streamed nor stopped; one list of active statuses now backs both predicates, with the phase set derived through `PHASE_BY_STATUS` so they cannot drift. The row menu stayed usable while the switch was disabled, so latency allowed a second run or a delete for the same job; Run now and Delete are disabled while a mutation is in flight, Edit stays available because it only opens a dialog. Not reproducible: the report said `0 0 30 2 *` passes cron validation and enables Save. It does not — `validateCron` returns `{ ok: false, reason: 'Invalid explicit day of month definition' }`, because the core scheduler's parser rejects an impossible day at parse time. A scan of 2286 parse-valid expression/timezone combinations (every day-of-month × month, weekday variants, six zones including half-hour and lop-sided DST ones) found zero cases where the expression parses but has no next occurrence, so adding a second next-run gate would have been an unreachable branch, failing the coverage gate for no behavioural gain. Recorded rather than changed.
- 1H.6 (CI) ✅ 2026-08-20 — The `unit` job timed out on five tests; investigated before changing anything and it is neither a hang nor a defect in the row-menu change. Ruled the suspect out on two independent grounds: the same job also failed on the previous head, before that change existed, and there it failed on a different test entirely — `shared/repo-picker/useRepos.test.ts > debounces rapid query changes into a single search`, a file this branch never touches, whose assertion is a 200 ms debounce window; and `JobDialog.test.tsx` never mounts `JobRowMenu` at all, while the `ScheduledView` case opens the dialog from the header button. Ruled out shared setup too: the same file's five other tests pass and cost 20–250 ms while sharing every `beforeAll` stub, the MSW server and the `afterEach` reset. What the five have in common is that each drives a `cmdk` command palette (the timezone one mounts 419 items) or types a whole form. Reproduced the difference by loading the machine: under load averages of 29–52 they scale proportionally — 2902 / 2675 / 1875 / 1749 / 1336 ms against 20–250 ms for their neighbours — and every one of them completes, which a condition that never becomes true would not do. The runner is about seven times slower (web suite 307.6 s there against 43.8 s here, with 391 s of setup alone), which puts the most expensive tests in the suite at or over the 5 s default. Measured two candidate fixes and rejected one: `userEvent.setup({ delay: null })` made no difference under matched load (1598/1643 ms against 1493/1440 ms), and `validateJobForm` costs 0.27 ms per render, so neither the artificial event delay nor the per-keystroke validation is where the time goes. Gave exactly those five tests a documented 20 s budget in their own files rather than raising `testTimeout` globally — the config is not this lane's to loosen, and a global change would hide a genuine hang in any of the other 991 tests.
