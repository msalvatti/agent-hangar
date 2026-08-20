# Wave 1 — Lane W1-F: Scheduling, workspace lifecycle, restore context, queue factories (core)

| | |
|---|---|
| **Lane** | W1-F (Wave 1, parallel with W1-A … W1-I) |
| **Status** | 🟩 Merged |
| **Progress** | 5/5 tasks |
| **Branch** | `feat/w1f-scheduling-workspace` |
| **Owned paths** | `packages/core/src/scheduling/**` (except the frozen `types.ts`), `packages/core/src/workspace/**` (except the frozen `types.ts`), `packages/core/src/restore/**`, `packages/core/src/queues/queues.ts`, `packages/core/src/queues/schedulers.ts` (+ their `*.test.ts` / `*.integration.test.ts`; `queues/contracts.ts` is frozen) — plus two append-only exceptions: `packages/core/vitest.config.ts` (`coverage.include` only) (the root `packages/core/src/index.ts` is frozen — it already re-exports `./scheduling/index.js`, `./workspace/index.js`, `./restore/index.js`, `./queues/index.js`; this lane adds exports only to those folder barrels) |
| **Depends on** | W0 merged to `main` |
| **Unblocks** | W2-A (cron validation + `nextRunAt` + scheduler upsert in `/api/jobs`, `describeCron` for the UI preview), W2-B (ensure-workspace decision, state machine, restore/turn-request builder, queue/worker factories, reconcile on boot) |
| **Source** | [docs/plan.md §6 W1-F](../plan.md) · spec [02 §4](../spec/02-data-model.md) · [03 §5](../spec/03-interfaces.md) · [04 (b)(c)](../spec/04-flows.md) · [06 §2–3](../spec/06-testing.md) |
| **Last updated** | 2026-08-20 |

## Context

W0 froze `CronSpec`, `SchedulerKey`, `ReconcilePlan`, `OverlapPolicy` in `packages/core/src/scheduling/types.ts`; the status unions (`WorkspaceStatus`, `TurnStatus`, `JobRunStatus`, `MessageRole`, …), `RestoreContext` and `EnsureWorkspaceDecision` in `packages/core/src/workspace/types.ts`; `TurnRequest` + `turnRequestSchema` in `packages/core/src/agent-protocol/**`; `QUEUE_NAMES`, `JOB_NAMES` and payload schemas in `packages/core/src/queues/contracts.ts`; `InvalidCronError`, `IllegalTransitionError`, `WorkspaceImageMissing` in `errors.ts`; `WorkspaceHandle` in `runner/types.ts`; the repository ports; `FakeClock` and in-memory repositories in `testing/**`. `cron-parser`, `bullmq` and `ioredis` are installed in `packages/core`.

This lane fills in the pure domain logic that W2-A (API) and W2-B (worker) orchestrate: cron validation / next-run computation / human-readable description, the overlap policy, the DB ↔ scheduler reconcile diff, the workspace lifecycle state machine, the "ensure workspace" decision, idle-TTL and orphan selection, the restore-context / `TurnRequest` builder (history window, `TOOL_SUMMARY` compaction, restoration notice, `expectedHeadSha`), and the thin BullMQ factories (queues, worker, Job Scheduler wrappers) with integration tests against the compose Redis.

## Rules of this lane

1. Edit only the owned paths. `scheduling/types.ts`, `workspace/types.ts`, `queues/contracts.ts`, `agent-protocol/**`, `errors.ts`, `runner/types.ts`, `persistence/ports.ts`, `testing/**` are frozen — a needed change becomes a `contractChangeRequests[]` entry in the PR summary; meanwhile use a local wrapper type inside your owned folder.
2. No new dependencies. `cron-parser`, `bullmq`, `ioredis` are already in `packages/core`; `node:*` for the rest. Stop and report if something is missing.
3. `packages/core/src/queues/queues.ts` and `schedulers.ts` are the **only** files in `packages/core` that import `bullmq`/`ioredis` at runtime (plan §6 W1-F). Everything under `scheduling/`, `workspace/`, `restore/` is pure (no I/O, no timers, `Date` passed in).
4. Extend `packages/core/vitest.config.ts` `coverage.include` with `src/scheduling/**`, `src/workspace/**`, `src/restore/**`, `src/queues/queues.ts`, `src/queues/schedulers.ts`. Thresholds stay 100/100/100/100. Unit tests alone (fake queue objects) must reach 100 % on the queue files — the `@redis` integration suite is additional proof, not the coverage source.
5. Integration tests live in `*.integration.test.ts`, `describe` tagged `@redis`, run by `pnpm test:integration` (and by `pnpm test` when `REDIS_URL` is set — same convention W0 used for `@db`). In CI (`CI=1`) an unreachable Redis **fails** the suite with instructions; it is never silently skipped. Local runs use the compose instance `AH_INSTANCE=test` (`REDIS_URL` from `infra/scripts/env.sh --print` with `AH_INSTANCE=test`). Every integration test uses a unique BullMQ `prefix` and obliterates its queues in `afterAll`.
6. No `enum`, no suppression comments, JSDoc on every export + file header, test header + block comment on every `it()`, English only. Canaries from `@agent-hangar/core/testing` if a secret-looking value is ever needed (it should not be in this lane).
7. Conventional Commits, English, no AI-attribution trailers. Branch `feat/w1f-scheduling-workspace`, one PR at the end (Task 1F.5).

## Reference docs

- [docs/plan.md](../plan.md) § "2. Reuse scan" (BullMQ Job Schedulers, `maxRetriesPerRequest: null` on workers only), § "3", § "6. Wave 1" (W1-F), § "11", § "12"
- [spec 02 — Data model](../spec/02-data-model.md) § "2" (`Workspace`, `ScheduledJob`, `JobRun`, `Message`, `ToolCallLog` models), § "3. Invariants" items 2, 3, 5, § "4. What workspace context must be persisted" (the restore table — notice text is normative)
- [spec 03 — Interface contracts](../spec/03-interfaces.md) § "3" (`TurnRequest` fields/defaults), § "5. Queue contracts (BullMQ)"
- [spec 04 — Flows](../spec/04-flows.md) § "(b) Archive → restore", § "(c) Scheduled job" (Guarantees: overlap policy text, reconcile on boot, manual run), § "(a)" "Second and later messages" + worker-crash edge case (stalled recovery)
- [spec 06 — Testing](../spec/06-testing.md) § "2" (scheduling/, workspace lifecycle/), § "3" (Queues bullets)
- [spec 10 — UI design](../spec/10-ui-design.md) § "4.3" (cron preview wording: "every day at 02:00 UTC", "Runs every weekday at 09:00 (next: Mon 09:00)")
- Contract files: `packages/core/src/scheduling/types.ts`, `workspace/types.ts`, `queues/contracts.ts`, `agent-protocol/{schemas,types}.ts`, `runner/types.ts`, `persistence/ports.ts`, `errors.ts`, `config/schema.ts` (`WORKSPACE_IDLE_TTL_MIN`, `WORKER_TURN_CONCURRENCY`, `REDIS_URL`), `testing/{fake-clock,in-memory-repositories,index}.ts`, `persistence/testing/db.ts` (integration-test env convention to mirror)
- Vault reference (read-only, for behaviour): `~/Documents/MyApps/obsidian/Brain/03 - Resources/BullMQ/Gotchas.md` — Job Schedulers API and the per-role `maxRetriesPerRequest` rule

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 1F.1 | Scheduling: cron validation, `nextRunAt` (tz/DST), `describeCron`, overlap policy, reconcile diff, scheduler keys | ✅ | P0 | M | — |
| 1F.2 | Workspace lifecycle: transition tables + `assertTransition`, `ensureWorkspaceDecision`, idle-TTL selection, orphan reconcile | ✅ | P0 | M | — |
| 1F.3 | Restore context: history window, `TOOL_SUMMARY` compaction text, restoration notice, `buildRestoreContext`, `buildTurnRequest` | ✅ | P0 | M | 1F.2 |
| 1F.4 | BullMQ factories: queues, worker connection, Job Scheduler wrappers, `@redis` integration tests | ✅ | P0 | M | 1F.1 |
| 1F.5 | Close-out: gates, code review, dashboard, PR | ✅ | P0 | S | 1F.1–1F.4 |

---

## Task 1F.1 — Scheduling: cron validation, `nextRunAt`, `describeCron`, overlap, reconcile, keys

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** Pure scheduling helpers over `cron-parser`: validate a 5-field cron + IANA timezone (`InvalidCronError`), compute `nextRunAt`/`nextRuns` with timezone and DST correctness, produce the human-readable description the UI preview shows, decide the overlap policy (`skip`), diff DB jobs against existing schedulers into a `ReconcilePlan`, and centralise the scheduler-key convention (key = `ScheduledJob.id`).

**Acceptance criteria**
- [x] `validateCronSpec(spec)` accepts exactly 5 whitespace-separated fields parsable by `cron-parser`, rejects 6-field/seconds, `@macros`, empty, unparsable, and invalid/unknown IANA timezones — always `InvalidCronError` with the offending value and reason in the message
- [x] `nextRunAt(spec, from)` returns the first instant strictly after `from`; `nextRuns(spec, from, count)` strictly increasing; DST tests: `0 12 * * *` in `Europe/Berlin` across 2026-03-29 → consecutive runs 23 h apart in UTC, across 2026-10-25 → 25 h apart; `30 2 * * *` in `America/New_York` on 2026-03-08 (non-existent wall time) yields an instant after the gap and the run on 2026-03-09 is at 02:30 local; results identical for `UTC` vs `Etc/UTC`
- [x] `describeCron(spec)` covers: every minute; every N minutes; every hour at :MM; every day at HH:MM; every weekday at HH:MM; specific weekdays (`Mon, Wed`); day-of-month; fallback ``on schedule `<cron>` ``; always suffixed by the timezone (e.g. `every day at 02:00 UTC`)
- [x] `decideOverlap({ runningRun })` → `{ action: 'run' }` or `{ action: 'skip', reason: OVERLAP_SKIP_REASON }` with `OVERLAP_SKIP_REASON === 'previous run still running'`
- [x] `reconcile(dbJobs, schedulers)` → `ReconcilePlan`: `upsert` = enabled jobs whose scheduler is missing or differs in `pattern`/`tz`; `remove` = scheduler keys with no enabled job; deterministic order (by id/key); unchanged schedulers untouched
- [x] `toSchedulerKey(jobId)` / `jobIdFromSchedulerKey(key)` identity helpers with JSDoc explaining why (spec 03 §5)
- [x] 100 % coverage on `src/scheduling/**` (types.ts excluded by config)

**Files to create**
`packages/core/src/scheduling/cron.ts`, `cron.test.ts`, `describe.ts`, `describe.test.ts`, `overlap.ts`, `overlap.test.ts`, `reconcile.ts`, `reconcile.test.ts`, `keys.ts`, `keys.test.ts`, `index.ts`; modify `packages/core/vitest.config.ts` (+ the owned folder `index.ts`).

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core is framework-free; `cron-parser` installed. Vitest 4 with @vitest/coverage-v8.
Branch feat/w1f-scheduling-workspace (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-F (Scheduling, workspace lifecycle, restore context, queues) — Task 1F.1 of 5 (FIRST)

PRECONDITIONS
- W0 merged to main; branch off latest main; contracts exist at packages/core/src/scheduling/types.ts (CronSpec, SchedulerKey, ReconcilePlan, OverlapPolicy and the job-ref type used by ReconcilePlan.upsert), errors.ts (InvalidCronError), testing/fake-clock.ts.
- `pnpm install --frozen-lockfile && pnpm typecheck` green on main.

REQUIRED READING (only these):
- CLAUDE.md (root)
- packages/core/src/scheduling/types.ts (implement against these names; note the exact element type of `ReconcilePlan.upsert`)
- packages/core/src/errors.ts (InvalidCronError constructor)
- docs/spec/03-interfaces.md § "5. Queue contracts (BullMQ)" (scheduler keys = ScheduledJob.id)
- docs/spec/04-flows.md § "(c)" Guarantees (overlap policy wording, reconcile on boot)
- docs/spec/10-ui-design.md § "4.3" (preview wording)
- docs/spec/06-testing.md § "2" → `scheduling/` bullet
- Installed `cron-parser`: `node -e "console.log(require('cron-parser/package.json').version)"` in packages/core, then its README/typings — v5+ exposes `CronExpressionParser.parse(expr, { currentDate, tz })`, v4 exposes `parseExpression`. Use whichever is installed; do not downgrade.

TASK
Implement the pure scheduling module used by the API (validation + nextRunAt + preview text) and by the worker (overlap decision, reconcile plan).

DELIVERABLES

1. `packages/core/src/scheduling/cron.ts`
   ```ts
   export const CRON_FIELD_COUNT = 5;
   export function validateCronSpec(spec: CronSpec): CronSpec          // returns the trimmed spec; throws InvalidCronError
   export function isValidTimezone(tz: string): boolean               // new Intl.DateTimeFormat('en-US', { timeZone: tz }) inside try/catch (RangeError → false); empty → false
   export function nextRunAt(spec: CronSpec, from: Date): Date         // strictly after `from`
   export function nextRuns(spec: CronSpec, from: Date, count: number): Date[]  // count ≥ 1; strictly increasing
   ```
   - `validateCronSpec`: `cron.trim()`; must not start with `@`; `split(/\s+/).length === CRON_FIELD_COUNT` else `InvalidCronError` ("expected 5 fields (minute hour day-of-month month day-of-week), got N"); `isValidTimezone(timezone)` else `InvalidCronError` ("unknown IANA timezone: <tz>"); then parse with cron-parser inside try/catch — any parser error → `InvalidCronError` with the parser's message appended. Message always includes the offending expression.
   - `nextRunAt`: parse with `{ currentDate: from, tz: spec.timezone }` and return `.next().toDate()`. Validate first (reuse `validateCronSpec`). If cron-parser returns a date equal to `from` (it should not for `currentDate`), advance once more — write the test that proves strictness instead of assuming.
2. `packages/core/src/scheduling/describe.ts` — `export function describeCron(spec: CronSpec): string`, table-driven over the five fields (after `validateCronSpec`):
   - `* * * * *` → `every minute`
   - `*/N * * * *` → `every N minutes`
   - `M * * * *` → `every hour at :MM`
   - `M H * * *` → `every day at HH:MM`
   - `M H * * 1-5` → `every weekday at HH:MM`
   - `M H * * <list or single dow>` (e.g. `1,3`, `0`, `7`, `MON`) → `every Mon, Wed at HH:MM` (names from `['Sun','Mon','Tue','Wed','Thu','Fri','Sat']`, 7 → Sun, accept 3-letter names case-insensitively)
   - `M H D * *` → `on day D of every month at HH:MM`
   - anything else → ``on schedule `<cron>` ``
   - Always append ` ` + `spec.timezone` (e.g. `every day at 02:00 UTC`, `every weekday at 09:00 Europe/Berlin`). HH/MM zero-padded.
3. `packages/core/src/scheduling/overlap.ts`
   ```ts
   export const OVERLAP_POLICY: OverlapPolicy = 'skip';
   export const OVERLAP_SKIP_REASON = 'previous run still running';
   export type OverlapDecision = { action: 'run' } | { action: 'skip'; reason: typeof OVERLAP_SKIP_REASON };
   export function decideOverlap(input: { runningRun: { id: string } | null }): OverlapDecision
   ```
4. `packages/core/src/scheduling/reconcile.ts`
   ```ts
   export interface ExistingScheduler { key: SchedulerKey; pattern?: string; tz?: string }
   export function reconcile(dbJobs: readonly <ScheduledJobRef>[], schedulers: readonly ExistingScheduler[]): ReconcilePlan
   ```
   where `<ScheduledJobRef>` is the element type W0 used in `ReconcilePlan.upsert` (must carry `id`, `cron`, `timezone`, `enabled` — if `enabled` is not on that type, accept `(ScheduledJobRef & { enabled: boolean })[]` and document). Algorithm: `enabled = dbJobs.filter(j => j.enabled)`; `byKey = Map(schedulers by key)`; `upsert` = enabled jobs where `!byKey.has(id) || existing.pattern !== cron || existing.tz !== timezone`, sorted by id; `remove` = scheduler keys not in `enabled` ids, sorted. Disabled jobs with an existing scheduler → removed. Pure; no mutation of inputs.
5. `packages/core/src/scheduling/keys.ts` — `toSchedulerKey(jobId: string): SchedulerKey` (identity; throws `RangeError` on empty), `jobIdFromSchedulerKey(key: SchedulerKey): string` (identity), `GC_SCHEDULER_KEY = 'reap-idle'`, `GC_CRON = '*/5 * * * *'` (spec 03 §5: every 5 min). JSDoc: keys equal job ids so `upsertJobScheduler` is idempotent per job and reconcile is a set diff.
6. `packages/core/src/scheduling/index.ts` barrel (re-export types too); the root `packages/core/src/index.ts` already re-exports `./scheduling/index.js` (frozen in W0) — do not edit it. `vitest.config.ts`: add `'src/scheduling/**'`.
7. Tests (each it() with a block comment):
   - cron.test.ts: valid `* * * * *`, `0 9 * * 1-5` UTC; rejects `* * * * * *` (6 fields), `@daily`, `''`, `'   '`, `'60 * * * *'`, `'* * * * 8'`, `'a b c d e'`; rejects timezone `''`, `'Mars/Olympus'`, `'utc '` (trailing space — do not trim tz silently; if `isValidTimezone` accepts it via Intl, trim in validate and test that the returned spec is trimmed); accepts `'UTC'`, `'Etc/UTC'`, `'America/Sao_Paulo'`; `isValidTimezone` direct cases; `nextRunAt` strictly after `from` when `from` is exactly on a tick; `nextRuns(…, 3)` strictly increasing; the four DST assertions from the acceptance criteria (compute `Date.UTC` constants by hand and assert `.getTime()` differences: Berlin noon Mar 28 = 11:00Z, Mar 29 = 10:00Z → 23 h; Oct 24 = 10:00Z, Oct 25 = 11:00Z → 25 h; New York: from `2026-03-08T05:00:00Z` (00:00 EST), next `30 2 * * *` must be > `2026-03-08T07:00:00Z` (gap start) and the following run equals `2026-03-09T06:30:00Z` (02:30 EDT)); UTC vs Etc/UTC equality; timezone affects the result (`0 9 * * *` from a fixed instant differs between `UTC` and `Asia/Tokyo` by 9 h).
   - describe.test.ts: one it() per row above, incl. `0 0 * * 0`, `0 0 * * 7`, `0 0 * * MON`, `15 * * * *`, `*/15 * * * *`, `0 2 * * *` UTC → `every day at 02:00 UTC`, `0 9 * * 1-5` Europe/Berlin → `every weekday at 09:00 Europe/Berlin`, `0 3 1 * *` → `on day 1 of every month at 03:00 UTC`, fallback for `0 3 1 6 *` and `0 */2 * * *`; invalid spec throws `InvalidCronError`.
   - overlap.test.ts: null → run; running → skip with the exact reason; `OVERLAP_POLICY === 'skip'`.
   - reconcile.test.ts: empty/empty → empty plan; enabled job, no scheduler → upsert; enabled job with identical scheduler → nothing; changed pattern → upsert; changed tz → upsert; scheduler without job → remove; disabled job with scheduler → remove (not upsert); mixed set → both lists sorted; inputs not mutated; applying the plan's effect and reconciling again yields an empty plan (simulate by building the scheduler list from the plan).
   - keys.test.ts: identity, empty throws, constants.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- Pure module: no `Date.now()`, no timers, no I/O. `cron-parser` is the only non-stdlib import.
- Do not modify `scheduling/types.ts` or `errors.ts`.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green; 100 % on `src/scheduling/**`
- `pnpm typecheck && pnpm lint` — exit 0
- `TZ=America/Los_Angeles pnpm --filter @agent-hangar/core test src/scheduling` — still green (tests must not depend on the process timezone)

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-1f-scheduling-workspace.md (task block and task index row)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/5 tasks`)
4. Append a completion log entry at the end of the file: `- 1F.1 ✅ <YYYY-MM-DD> — <one-line summary incl. cron-parser version>`
5. Commit: `feat(core): add cron validation, next-run computation, description and reconcile plan`
````

---

## Task 1F.2 — Workspace lifecycle: transitions, `ensureWorkspaceDecision`, idle-TTL, orphan reconcile

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** Pure workspace domain logic: the allowed-transition tables for `WorkspaceStatus` (and the shared `TurnStatus`/`JobRunStatus` run lifecycle) with `IllegalTransitionError`, the "ensure workspace" decision (reuse live READY → `reuse`; none → `create` + restore; image missing → `WorkspaceImageMissing`; CREATING/BUSY/STOPPING → `WorkspaceBusyError` so the worker runs stalled recovery first), idle-TTL selection for GC, and the orphan reconcile plan from `runner.list()` vs DB live rows.

**Acceptance criteria**
- [x] `WORKSPACE_TRANSITIONS` table exactly: CREATING→{READY, FAILED, DESTROYED}; READY→{BUSY, STOPPING, DESTROYED, FAILED}; BUSY→{READY, STOPPING, FAILED, DESTROYED}; STOPPING→{DESTROYED, FAILED}; FAILED→{DESTROYED}; DESTROYED→{} ; `RUN_TRANSITIONS` (Turn/JobRun): QUEUED→{PREPARING, FAILED, CANCELLED}; PREPARING→{RUNNING, FAILED, CANCELLED}; RUNNING→{SUCCEEDED, FAILED, CANCELLED}; terminal→{}
- [x] `canTransition`, `assertTransition` (throws `IllegalTransitionError` naming subject, from, to), `LIVE_WORKSPACE_STATUSES` = CREATING/READY/BUSY/STOPPING (mirrors the partial unique index), `isLiveWorkspaceStatus`, `isTerminalRunStatus`
- [x] `ensureWorkspaceDecision({ liveWorkspace, imagePresent, restore })` returns `EnsureWorkspaceDecision` exactly as typed in W0; `imagePresent === false` → throws `WorkspaceImageMissing` before anything else; READY → `{ action: 'reuse', workspaceId }`; `null`/DESTROYED/FAILED → `{ action: 'create', clone: true, restore }`; CREATING/BUSY/STOPPING → `WorkspaceBusyError` (local `AgentHangarError` subclass, code `WORKSPACE_BUSY`)
- [x] `selectIdleWorkspaces(candidates, { now, idleTtlMin })` → ids of READY workspaces with `now − lastActiveAt > ttl` (strict), any kind; stable order by `lastActiveAt` asc
- [x] `planOrphanReconcile({ runnerHandles, dbLive })` → `{ destroyOrphans: WorkspaceHandle[] (runner has it, DB has no live row for workspaceId), markGone: string[] (DB live row, runner does not list it) }`, sorted deterministically
- [x] 100 % coverage on `src/workspace/**` (types.ts excluded)

**Files to create**
`packages/core/src/workspace/lifecycle.ts`, `lifecycle.test.ts`, `errors.ts`, `errors.test.ts`, `ensure.ts`, `ensure.test.ts`, `idle.ts`, `idle.test.ts`, `orphans.ts`, `orphans.test.ts`, `index.ts`; modify `packages/core/vitest.config.ts` (+ the owned folder `index.ts`).

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core is framework-free. Vitest 4 with @vitest/coverage-v8.
Branch feat/w1f-scheduling-workspace (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-F (Scheduling, workspace lifecycle, restore context, queues) — Task 1F.2 of 5 (MIDDLE)

PRECONDITIONS
- W0 merged to main; branch off latest main; contracts exist at packages/core/src/workspace/types.ts (WorkspaceStatus, TurnStatus, JobRunStatus, WorkspaceKind, RestoreContext, EnsureWorkspaceDecision), runner/types.ts (WorkspaceHandle), errors.ts (IllegalTransitionError, WorkspaceImageMissing, AgentHangarError), testing/fake-clock.ts.
- Independent of 1F.1.

REQUIRED READING (only these):
- packages/core/src/workspace/types.ts (unions and `EnsureWorkspaceDecision` — return exactly that shape)
- packages/core/src/runner/types.ts (WorkspaceHandle)
- packages/core/src/errors.ts (IllegalTransitionError, WorkspaceImageMissing constructor signatures; AgentHangarError subclass pattern)
- docs/spec/02-data-model.md § "2" (`Workspace` model: status, kind, lastActiveAt) and § "3. Invariants" items 2–3
- docs/spec/04-flows.md § "(a)" worker-crash edge case, "Second and later messages"; § "(b)" (restore is not a special path); § "(c)" Guarantees (GC by label)
- docs/spec/06-testing.md § "2" → `workspace lifecycle/` bullet (except restore-context, which is Task 1F.3)

TASK
Implement the pure workspace-lifecycle rules the worker applies on every turn, GC tick and boot, so the persistence layer (W1-E) and the processors (W2-B) never encode transitions ad hoc.

DELIVERABLES

1. `packages/core/src/workspace/lifecycle.ts`
   ```ts
   export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;
   export const WORKSPACE_TRANSITIONS: TransitionTable<WorkspaceStatus>   // table from the acceptance criteria
   export const RUN_TRANSITIONS: TransitionTable<TurnStatus>               // TurnStatus and JobRunStatus are the same union; export `RUN_TRANSITIONS` typed on TurnStatus and a type alias `RunStatus = TurnStatus` with a compile-time check that JobRunStatus is assignable both ways
   export const LIVE_WORKSPACE_STATUSES: readonly WorkspaceStatus[]       // ['CREATING','READY','BUSY','STOPPING']
   export function isLiveWorkspaceStatus(s: WorkspaceStatus): boolean
   export function isTerminalRunStatus(s: RunStatus): boolean              // SUCCEEDED | FAILED | CANCELLED
   export function canTransition<S extends string>(table: TransitionTable<S>, from: S, to: S): boolean
   export function assertTransition<S extends string>(table: TransitionTable<S>, from: S, to: S, subject: string): void   // throws IllegalTransitionError(`${subject}: ${from} → ${to} is not allowed`)
   export const assertWorkspaceTransition = (from, to, workspaceId) => assertTransition(WORKSPACE_TRANSITIONS, from, to, `workspace ${workspaceId}`)
   export const assertRunTransition = (from, to, runId) => …
   ```
   Self-transitions are illegal (not in any list). The tables are exhaustive `Record`s so adding a status to the union fails typecheck here.
2. `packages/core/src/workspace/errors.ts` — `export class WorkspaceBusyError extends AgentHangarError { readonly code = 'WORKSPACE_BUSY'; constructor(workspaceId: string, status: WorkspaceStatus) }` message: `workspace <id> is <status>; resolve it (stalled recovery or wait) before ensuring a workspace for this chat`.
3. `packages/core/src/workspace/ensure.ts`
   ```ts
   export interface EnsureWorkspaceInput {
     liveWorkspace: { id: string; status: WorkspaceStatus } | null;   // result of WorkspaceRepository.findLiveByChat (may be a stale non-live row defensively)
     imagePresent: boolean;
     restore: RestoreContext;   // built by Task 1F.3's buildRestoreContext; passed in so this function stays pure
   }
   export function ensureWorkspaceDecision(input: EnsureWorkspaceInput): EnsureWorkspaceDecision
   ```
   Order: image check first (throw `WorkspaceImageMissing` — use the W0 constructor so the message carries `pnpm infra:image`); then `liveWorkspace === null` or status DESTROYED/FAILED → `{ action: 'create', clone: true, restore }`; READY → `{ action: 'reuse', workspaceId }`; CREATING/BUSY/STOPPING → throw `WorkspaceBusyError`. Exhaustive `switch` with `assertNever`. JSDoc documents that restore is not a special path (spec 04 (b)): a missing live workspace after archive, idle GC, or crash all yield the same `create` decision.
4. `packages/core/src/workspace/idle.ts`
   ```ts
   export interface IdleCandidate { id: string; status: WorkspaceStatus; kind: WorkspaceKind; lastActiveAt: Date }
   export function idleCutoff(now: Date, idleTtlMin: number): Date          // now − ttl; ttl must be > 0 (RangeError otherwise)
   export function selectIdleWorkspaces(candidates: readonly IdleCandidate[], opts: { now: Date; idleTtlMin: number }): string[]
   ```
   READY only (BUSY is never reaped by TTL; CREATING/STOPPING are transient), `lastActiveAt < cutoff` (strictly older than TTL), both kinds, sorted by `lastActiveAt` ascending then id.
5. `packages/core/src/workspace/orphans.ts`
   ```ts
   export interface OrphanReconcileInput { runnerHandles: readonly WorkspaceHandle[]; dbLive: readonly { id: string; runnerRef: string | null }[] }
   export interface OrphanReconcilePlan { destroyOrphans: WorkspaceHandle[]; markGone: string[] }
   export function planOrphanReconcile(input: OrphanReconcileInput): OrphanReconcilePlan
   ```
   Match on `handle.workspaceId === row.id`. `destroyOrphans` = handles whose workspaceId is not a live DB row (worker crashed after create, or DB row already DESTROYED) sorted by workspaceId; `markGone` = live DB rows whose id no runner handle lists (container vanished) sorted by id. JSDoc: the worker then `runner.destroy(handle)` each orphan and transitions each `markGone` row → FAILED (reason "container not found") or DESTROYED — the decision of which status is W2-B's; this function only classifies.
6. `packages/core/src/workspace/index.ts` barrel (+ re-export types); the root `packages/core/src/index.ts` already re-exports `./workspace/index.js` — do not edit it. `vitest.config.ts`: add `'src/workspace/**'`.
7. Tests:
   - lifecycle.test.ts: every allowed edge in both tables (`it.each` over a flattened list is fine — one it() per edge with a generated comment is NOT fine; use one `it` per table that asserts the full table with a block comment, plus individual `it`s for: CREATING→READY→BUSY→READY→DESTROYED happy path; DESTROYED→READY throws; READY→READY throws; `IllegalTransitionError` message contains subject/from/to and `instanceof AgentHangarError`; `isLiveWorkspaceStatus` for all six; `isTerminalRunStatus` for all six run statuses; `assertRunTransition` QUEUED→SUCCEEDED throws).
   - ensure.test.ts: image missing wins over everything (throws even with a READY workspace); null → create with the same `restore` reference and `clone: true`; DESTROYED/FAILED → create; READY → reuse with the id; CREATING/BUSY/STOPPING → `WorkspaceBusyError` with code and message containing id + status; `assertNever` guard via an impossible status cast through `unknown`.
   - idle.test.ts: exactly-at-TTL not selected; 1 ms older selected; BUSY/CREATING/STOPPING/DESTROYED/FAILED never selected; both kinds selected; ordering; `idleTtlMin <= 0` → RangeError; uses `FakeClock` for `now`.
   - orphans.test.ts: empty/empty; orphan container; vanished container; both; exact match → empty plan; ordering; inputs not mutated.
   - errors.test.ts: WorkspaceBusyError fields.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- Pure module: no I/O, no `Date.now()`.
- Do not modify `workspace/types.ts`, `errors.ts`, `runner/types.ts`.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green; 100 % on `src/workspace/**`
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1f-scheduling-workspace.md; append `- 1F.2 ✅ <date> — <summary>`; commit `feat(core): add workspace lifecycle state machine, ensure decision, idle and orphan selection`.
````

---

## Task 1F.3 — Restore context: history window, compaction, notice, `buildRestoreContext`, `buildTurnRequest`

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 1F.2

**Description.** Implement `packages/core/src/restore/**`: the history window (last N messages within a char budget, always keeping the first USER message, with a compaction item when messages are dropped), the exact `TOOL_SUMMARY` text format, the exact restoration notice text from spec 02 §4, `buildRestoreContext` (chat + ordered messages → `RestoreContext` with `expectedHeadSha` when `workBranch` + `lastPushedSha` exist), and `buildTurnRequest` (→ a Zod-validated `TurnRequest` with default limits for chats and jobs).

**Acceptance criteria**
- [x] `buildHistoryWindow(messages, budget)` returns `ConversationItem[]` in seq order; roles mapped USER→user, ASSISTANT→assistant, SYSTEM/TOOL_SUMMARY→system; honours `maxMessages` and `maxChars` (counting content length, newest first); always keeps the first USER message; when anything is dropped, inserts one `system` compaction item right after the anchor: `"<N> earlier messages omitted to fit the context window.\nEarlier tool activity:\n- <TOOL_SUMMARY lines of dropped messages, max 20, oldest first>"` (second part only when any were tool summaries)
- [x] `toolSummaryText(entry)` formats exactly: run_shell → ``ran `<command ≤ 80 chars, "…" when cut>` → exit <code> (<duration>)``, TIMED_OUT → ``ran `<cmd>` → timed out after <duration>``, FAILED with null exit → ``ran `<cmd>` → failed (<duration>)``; write_file → `wrote <path> (<bytes> bytes)`; read_file → `read <path>`; list_dir → `listed <path or "/">`; duration humanised `350 ms` / `12 s` / `2 min 3 s`
- [x] `restorationNotice({ at, workBranch })` with workBranch → exactly `` Workspace recreated from history at <ISO>. Uncommitted changes from the previous workspace are gone; pushed work on `<workBranch>` is checked out. ``; without → `Workspace recreated from history at <ISO>. Uncommitted changes from the previous workspace are gone; no pushed work was found, so the base branch is checked out.`
- [x] `buildRestoreContext({ chat, messages, now, budget? })` fills every field of W0's `RestoreContext`; `expectedHeadSha` is set only when `workBranch` and `lastPushedSha` are both present
- [x] `buildTurnRequest(input)` returns `turnRequestSchema.parse(...)` output; `prepare.clone` is `true` for `create` decisions and `false` for `reuse`; `repo.expectedHeadSha` only on create with a sha; `repo.workBranch` = `chat.workBranch ?? defaultWorkBranch(chat.id)`; limits default `DEFAULT_CHAT_TURN_LIMITS` (40 steps, 20 min, 5 min tool, 32 KiB) / `DEFAULT_JOB_TURN_LIMITS` (30 min) with per-call overrides; `buildJobTurnRequest` builds the single-user-item request for scheduled runs
- [x] 100 % coverage on `src/restore/**`

**Files to create**
`packages/core/src/restore/history.ts`, `history.test.ts`, `compaction.ts`, `compaction.test.ts`, `notice.ts`, `notice.test.ts`, `build.ts`, `build.test.ts`, `limits.ts`, `limits.test.ts`, `index.ts`; modify `packages/core/vitest.config.ts` (+ the owned folder `index.ts`).

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core is framework-free (zod available). Vitest 4 with @vitest/coverage-v8.
Branch feat/w1f-scheduling-workspace (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-F (Scheduling, workspace lifecycle, restore context, queues) — Task 1F.3 of 5 (MIDDLE)

PRECONDITIONS
- W0 merged to main; branch off latest main; contracts exist at packages/core/src/workspace/types.ts (RestoreContext, EnsureWorkspaceDecision, MessageRole, ToolCallStatus), agent-protocol/{schemas,types}.ts (TurnRequest, turnRequestSchema, ToolName), model/types.ts (ConversationItem), persistence/ports.ts (domain Message/Chat/ToolCallLog types), testing/fake-clock.ts.
- Task 1F.2 done (`ensureWorkspaceDecision` consumes `RestoreContext`; this task builds it).

REQUIRED READING (only these):
- packages/core/src/workspace/types.ts (RestoreContext fields — fill ALL of them; EnsureWorkspaceDecision)
- packages/core/src/agent-protocol/schemas.ts and types.ts (TurnRequest shape and defaults)
- packages/core/src/model/types.ts (ConversationItem)
- packages/core/src/persistence/ports.ts (domain types for Chat, Message, ToolCallLog — import types; define local structural input types that are subsets so tests need no full rows)
- docs/spec/02-data-model.md § "4. What workspace context must be persisted" (restore table — notice text and TOOL_SUMMARY examples are normative)
- docs/spec/03-interfaces.md § "3" (TurnRequest: limits defaults 40 / 20 min (jobs 30 min) / 5 min / 32 KB; `repo.workBranch`, `expectedHeadSha`, `prepare.clone`)
- docs/spec/04-flows.md § "(a)" "Second and later messages" (clone=false on reuse) and § "(b)" restore sequence (clone=true, workBranch, expectedHeadSha)
- docs/spec/07-build-plan.md line mentioning `workBranch` (`agent/<short-id>`)

TASK
Implement the restore-context and TurnRequest builders the worker uses for every turn (fresh, continued, restored) and for scheduled runs.

DELIVERABLES

1. `packages/core/src/restore/limits.ts`
   ```ts
   export const DEFAULT_CHAT_TURN_LIMITS: TurnRequest['limits'] = { maxSteps: 40, maxTurnMs: 20 * 60_000, toolTimeoutMs: 5 * 60_000, maxToolOutputBytes: 32 * 1024 };
   export const DEFAULT_JOB_TURN_LIMITS: TurnRequest['limits'] = { ...DEFAULT_CHAT_TURN_LIMITS, maxTurnMs: 30 * 60_000 };
   export const DEFAULT_HISTORY_BUDGET: HistoryBudget = { maxMessages: 60, maxChars: 48_000 };   // ≈ 12k tokens at 4 chars/token; no tokenizer dependency (documented)
   export function defaultWorkBranch(chatOrRunId: string, prefix = 'agent/'): string   // `agent/${id.slice(0, 8)}`; throws RangeError on empty id
   ```
2. `packages/core/src/restore/compaction.ts`
   ```ts
   export interface ToolCallSummaryInput { toolName: ToolName; args: unknown; exitCode: number | null; status: ToolCallStatus; durationMs: number | null; resultBytes?: number | null }
   export function humanDuration(ms: number | null): string     // null → 'n/a'; < 1000 → '<n> ms'; < 60000 → '<s> s' (rounded); else '<m> min <s> s' (omit ' 0 s')
   export function toolSummaryText(entry: ToolCallSummaryInput): string   // formats from the acceptance criteria; args parsed defensively: missing/invalid → '?'
   export const MAX_SUMMARY_COMMAND_CHARS = 80;
   ```
   `write_file` bytes = `Buffer.byteLength(args.content)` when `args.content` is a string, else `resultBytes ?? 0`. Path values are used as-is (the agent-runtime already confines them); command text has newlines collapsed to spaces.
3. `packages/core/src/restore/notice.ts` — `export function restorationNotice(input: { at: Date; workBranch: string | null }): string` with the two exact strings from the acceptance criteria (`at.toISOString()`); export the two templates as constants for tests (`RESTORATION_NOTICE_WITH_BRANCH`, `RESTORATION_NOTICE_WITHOUT_BRANCH`) if that keeps the function a single template substitution; `export function archivedNotice(input: { uncommittedChanges: number }): string` → `Workspace archived; <N> uncommitted changes discarded.` / `Workspace archived; no uncommitted changes.` (spec 04 (b) step 8 — used by W2-B's destroy processor).
4. `packages/core/src/restore/history.ts`
   ```ts
   export interface HistoryMessage { seq: number; role: MessageRole; content: string }
   export interface HistoryBudget { maxMessages: number; maxChars: number }
   export interface HistoryWindow { items: ConversationItem[]; dropped: number; kept: number }
   export function toConversationItem(message: HistoryMessage): ConversationItem   // role mapping from the acceptance criteria; exhaustive switch
   export function buildHistoryWindow(messages: readonly HistoryMessage[], budget?: HistoryBudget): HistoryWindow
   ```
   Algorithm: sort by `seq` asc (copy); `anchor` = first USER message (may be undefined for an empty history); walk from newest to oldest adding messages while `kept < maxMessages` and `chars + content.length <= maxChars` (the anchor is reserved first: its length counts toward the budget and it is always kept even if it alone exceeds the budget); everything not kept is `dropped`; output = `[anchor, compactionItem?, ...keptInSeqOrder]` with the anchor not duplicated; compaction item present iff `dropped > 0`: `system` with the text from the acceptance criteria, where the tool lines are the contents of dropped `TOOL_SUMMARY` messages (oldest first, max 20, then a final line `- … <M> more`). Pure, no mutation.
5. `packages/core/src/restore/build.ts`
   ```ts
   export interface ChatRestoreSource { id: string; repoUrl: string; baseBranch: string; workBranch: string | null; lastPushedSha: string | null }
   export function buildRestoreContext(input: { chat: ChatRestoreSource; messages: readonly HistoryMessage[]; now: Date; budget?: HistoryBudget }): RestoreContext
   export interface BuildTurnRequestInput {
     turnId: string; model: string; instructions: string;
     chat: ChatRestoreSource; messages: readonly HistoryMessage[];
     decision: EnsureWorkspaceDecision;
     limits?: Partial<TurnRequest['limits']>; budget?: HistoryBudget;
   }
   export function buildTurnRequest(input: BuildTurnRequestInput): TurnRequest
   export interface BuildJobTurnRequestInput { runId: string; model: string; instructions: string; job: { repoUrl: string; branch: string; prompt: string }; limits?: Partial<TurnRequest['limits']> }
   export function buildJobTurnRequest(input: BuildJobTurnRequestInput): TurnRequest
   ```
   - `buildRestoreContext`: populate every field declared on W0's `RestoreContext` (repo fields from chat; history items from `buildHistoryWindow`; the restoration notice text via `restorationNotice({ at: now, workBranch })`; `expectedHeadSha` = `lastPushedSha` only when `workBranch` is non-null, else omitted). If W0's `RestoreContext` lacks a field you need, do NOT edit types.ts — keep the extra data in the `TurnRequest` build path and add a contractChangeRequest.
   - `buildTurnRequest`: `items` = `buildHistoryWindow(messages, budget).items`; on `create` decisions append a final `{ role: 'system', content: decision.restore.<notice field> }` ONLY if the notice is not already the last SYSTEM message in `messages` (the API inserts a SYSTEM notice row on restore per spec 04 (b); on idle-GC recreation nobody inserted one — the test covers both); `repo = { url: chat.repoUrl, baseBranch, workBranch: chat.workBranch ?? defaultWorkBranch(chat.id), ...(create && expectedHeadSha ? { expectedHeadSha } : {}) }`; `limits = { ...DEFAULT_CHAT_TURN_LIMITS, ...input.limits }`; `prepare = { clone: decision.action === 'create' }`; `protocolVersion: 1`; return `turnRequestSchema.parse(request)` so any drift from the frozen schema throws here, not inside the container.
   - `buildJobTurnRequest`: `items = [{ role: 'user', content: job.prompt }]`, `repo = { url, baseBranch: branch, workBranch: defaultWorkBranch(runId, 'agent/job-') }`, limits `DEFAULT_JOB_TURN_LIMITS` + overrides, `prepare.clone: true`, `turnId: runId`, parsed by the schema.
6. `packages/core/src/restore/index.ts` barrel; the root `packages/core/src/index.ts` already re-exports `./restore/index.js` — do not edit it. `vitest.config.ts`: add `'src/restore/**'`.
7. Tests:
   - compaction.test.ts: each tool/status combination from the acceptance criteria with exact strings; command > 80 chars truncated with `…`; multi-line command collapsed; invalid args (`null`, string, missing keys) → `?`; `humanDuration` for null, 0, 350, 999, 1000, 12_000, 59_499, 60_000, 123_000, 3_600_000.
   - notice.test.ts: exact strings for both branches (use a fixed `Date`); `archivedNotice` 0 / 1 / 5.
   - history.test.ts: role mapping for all four roles; empty history → empty items, dropped 0; under budget → all items in seq order, no compaction; `maxMessages` = 3 with 10 messages → anchor + compaction + last 3, dropped 6; `maxChars` boundary (a message that exactly fits is kept; one char more drops it); anchor kept even when it alone exceeds `maxChars`; anchor not duplicated when it is also within the window; compaction lists dropped TOOL_SUMMARY contents oldest first, max 20 then `- … N more`; no tool lines when none dropped were TOOL_SUMMARY; unsorted input is sorted by seq; input array not mutated; default budget used when omitted.
   - build.test.ts: `buildRestoreContext` field-by-field for a chat with/without workBranch+sha (expectedHeadSha presence); `buildTurnRequest` reuse → `prepare.clone false`, no `expectedHeadSha`, no appended notice; create (idle-GC case: no SYSTEM notice in messages) → `clone true`, `expectedHeadSha` from restore, notice appended as last item; create (archive-restore case: notice already last SYSTEM in messages) → not duplicated; workBranch default `agent/<8 chars>`; limits defaults and override merge; the returned object passes `turnRequestSchema.safeParse` and an invalid `model: ''`-style input (if the schema requires non-empty) throws a ZodError — pick a field the schema actually constrains; `buildJobTurnRequest` single user item, job branch prefix, 30-min limit, clone true.
   - limits.test.ts: constants values; `defaultWorkBranch` slice and prefix; empty id throws.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- Pure module; `Date` always injected. No tokenizer, no new dependencies.
- Do not modify frozen contract files.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green; 100 % on `src/restore/**`
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1f-scheduling-workspace.md; append `- 1F.3 ✅ <date> — <summary>`; commit `feat(core): add restore context and turn request builders`.
````

---

## Task 1F.4 — BullMQ factories: queues, worker connection, Job Scheduler wrappers, `@redis` integration

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 1F.1

**Description.** Thin, typed BullMQ wrappers in `packages/core/src/queues/{queues,schedulers}.ts`: connection factories with the per-role `maxRetriesPerRequest` policy (null on worker/blocking connections only), `Queue` factories per `QUEUE_NAMES`, a `Worker` factory, Job Scheduler wrappers (`upsertJobScheduler(jobId, { pattern, tz }, { name, data })`, `removeJobScheduler`, `getJobSchedulers` → `ExistingScheduler[]`), `applyReconcilePlan`, and the GC scheduler; unit-tested to 100 % with duck-typed fakes and proven against real Redis in a `@redis` integration suite.

**Acceptance criteria**
- [x] `createQueueConnection(redisUrl)` → ioredis with default retry policy; `createWorkerConnection(redisUrl)` → ioredis with `maxRetriesPerRequest: null`; both `lazyConnect: false`, `enableReadyCheck` default; `closeConnection(conn)` quits safely
- [x] `createQueue(name, { connection, prefix? })` → `Queue` for a `QueueName`; `createQueues({ connection, prefix? })` → `{ chatTurns, scheduledJobs, workspaceGc }`; `createWorker(name, processor, { connection, concurrency?, prefix? })` → `Worker` (throws `ConfigError` if the connection's `maxRetriesPerRequest !== null`)
- [x] `enqueueRunTurn(queue, { turnId })` uses `jobId: turnId`; `enqueueManualJobRun(queue, { jobId })` adds `run-scheduled-job` with `trigger: 'MANUAL'`; `enqueueDestroyChatWorkspace(queue, { chatId })`; payloads validated with the W0 Zod schemas before `add`
- [x] `upsertScheduledJob(queue, { id, cron, timezone })` → `queue.upsertJobScheduler(id, { pattern: cron, tz: timezone }, { name: JOB_NAMES.runScheduledJob, data: { jobId: id, trigger: 'SCHEDULE' } })`; `removeScheduledJob(queue, jobId)`; `listSchedulers(queue)` → `ExistingScheduler[]` (`{ key, pattern, tz }`) sorted by key; `applyReconcilePlan(queue, plan)` → `{ upserted: string[]; removed: string[] }`; `upsertGcScheduler(queue)` key `reap-idle`, pattern `*/5 * * * *`, job `reap-idle`, data `{}`
- [x] `@redis` integration (`schedulers.integration.test.ts`, `queues.integration.test.ts`): upsert creates exactly one scheduler per job; re-upsert with a new pattern → still one, pattern updated; remove deletes; `applyReconcilePlan` twice converges (second run no-ops and `listSchedulers` equals the enabled set); worker connection `maxRetriesPerRequest === null` and queue connection not; a `Worker` from the factory processes one `run-turn` job end-to-end; suite FAILS with instructions when `CI=1` and Redis is unreachable
- [x] 100 % coverage on `queues.ts` and `schedulers.ts` from unit tests alone

**Files to create**
`packages/core/src/queues/queues.ts`, `queues.test.ts`, `queues.integration.test.ts`, `schedulers.ts`, `schedulers.test.ts`, `schedulers.integration.test.ts`, `redis.integration-helper.ts` (shared Redis env/ping helper for the two integration files; excluded from coverage by the `*.integration-helper.ts` name); modify `packages/core/vitest.config.ts` (+ the owned folder `index.ts`).

**Agent prompt**

````
You are a senior backend engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core; BullMQ 6 + ioredis 6 (installed); Redis 8 via `infra/docker-compose.yml`. Vitest 4 with @vitest/coverage-v8.
Branch feat/w1f-scheduling-workspace (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-F (Scheduling, workspace lifecycle, restore context, queues) — Task 1F.4 of 5 (MIDDLE)

PRECONDITIONS
- W0 merged to main; branch off latest main; contracts exist at packages/core/src/queues/contracts.ts (QUEUE_NAMES, JOB_NAMES, payload schemas, stream/channel key helpers), config/schema.ts (REDIS_URL, WORKER_TURN_CONCURRENCY), errors.ts (ConfigError), persistence/testing/db.ts (env convention for integration tests — mirror it).
- Task 1F.1 done (`ReconcilePlan` producer, `ExistingScheduler`, `GC_SCHEDULER_KEY`, `GC_CRON`).
- `infra/docker-compose.yml` + `infra/scripts/env.sh` exist (W0 0.6). For local integration runs: `AH_INSTANCE=test AH_PORT_BASE=3100 bash infra/scripts/env.sh --print` to get a `REDIS_URL`, bring the test instance up with `docker compose -f infra/docker-compose.yml --env-file <that env> up -d redis --wait` (or `pnpm infra:up` with those variables exported).

REQUIRED READING (only these):
- packages/core/src/queues/contracts.ts (names, payload schemas, `turnEventsStreamKey` — implement against these verbatim)
- packages/core/src/scheduling/{reconcile,keys}.ts (your own API)
- docs/spec/03-interfaces.md § "5. Queue contracts (BullMQ)"
- docs/spec/04-flows.md § "(c)" Guarantees (upsert idempotent by key, disable removes, boot reconcile, manual run)
- docs/spec/06-testing.md § "3" → Queues bullet
- ~/Documents/MyApps/obsidian/Brain/03 - Resources/BullMQ/Gotchas.md (entries "Job Schedulers" and "maxRetriesPerRequest: null only on the Worker connection") — read-only
- Installed BullMQ types: `Queue.upsertJobScheduler`, `Queue.removeJobScheduler`, `Queue.getJobSchedulers`, `Worker` constructor options, `QueueOptions.prefix`; ioredis `Redis` constructor options and `.options`

TASK
Provide the only BullMQ/ioredis code in packages/core: tiny factories and wrappers that encode the connection policy and the scheduler conventions once, so apps/web (producers) and apps/worker (consumers) cannot get them wrong.

DELIVERABLES

1. `packages/core/src/queues/queues.ts` (runtime imports: `bullmq`, `ioredis`)
   ```ts
   export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];   // adapt to how W0 typed QUEUE_NAMES
   export interface QueueConnectionOptions { prefix?: string }   // BullMQ key prefix; tests use a unique one
   export function createQueueConnection(redisUrl: string): Redis                 // new Redis(url) — default retries so producers fail fast (vault gotcha)
   export function createWorkerConnection(redisUrl: string): Redis                // new Redis(url, { maxRetriesPerRequest: null }) — blocking commands
   export async function closeConnection(conn: Redis): Promise<void>              // quit(); ignore 'Connection is closed' errors
   export function createQueue<TData = unknown>(name: QueueName, opts: { connection: Redis } & QueueConnectionOptions): Queue<TData>
   export function createQueues(opts: { connection: Redis } & QueueConnectionOptions): { chatTurns: Queue; scheduledJobs: Queue; workspaceGc: Queue }
   export function createWorker<TData = unknown>(name: QueueName, processor: Processor<TData>, opts: { connection: Redis; concurrency?: number } & QueueConnectionOptions): Worker<TData>
   export async function enqueueRunTurn(queue: Queue, payload: RunTurnPayload): Promise<string>            // jobId = turnId (idempotent); returns job id
   export async function enqueueManualJobRun(queue: Queue, payload: { jobId: string }): Promise<string>   // name JOB_NAMES.runScheduledJob, data { jobId, trigger: 'MANUAL' }
   export async function enqueueDestroyChatWorkspace(queue: Queue, payload: DestroyChatWorkspacePayload): Promise<string>   // jobId = `destroy-${chatId}`
   ```
   - `createWorker` guards: `(opts.connection.options.maxRetriesPerRequest ?? 0) !== null` → throw `ConfigError('worker connections require maxRetriesPerRequest: null — use createWorkerConnection()')`. Concurrency default 1. `Worker` options: `{ connection, concurrency, prefix }` only — no `autorun` tricks.
   - Every `enqueue*` validates its payload with the W0 schema (`.parse`) before `queue.add(name, data, { jobId, removeOnComplete: 1000, removeOnFail: 5000 })`; the option values are constants exported from this file.
2. `packages/core/src/queues/schedulers.ts` (runtime import: `bullmq` types only + the `Queue` instance passed in)
   ```ts
   export interface SchedulerQueue {   // structural subset so unit tests use a fake; bullmq Queue satisfies it
     upsertJobScheduler(key: string, repeat: { pattern: string; tz?: string }, template: { name: string; data: unknown }): Promise<unknown>;
     removeJobScheduler(key: string): Promise<boolean>;
     getJobSchedulers(): Promise<Array<{ key: string; pattern?: string | null; tz?: string | null }>>;
   }
   export async function upsertScheduledJob(queue: SchedulerQueue, job: { id: string; cron: string; timezone: string }): Promise<void>
   export async function removeScheduledJob(queue: SchedulerQueue, jobId: string): Promise<boolean>
   export async function listSchedulers(queue: SchedulerQueue): Promise<ExistingScheduler[]>   // excludes GC_SCHEDULER_KEY; maps null → undefined; sorted by key
   export async function applyReconcilePlan(queue: SchedulerQueue, plan: ReconcilePlan): Promise<{ upserted: string[]; removed: string[] }>
   export async function upsertGcScheduler(queue: SchedulerQueue): Promise<void>   // key GC_SCHEDULER_KEY, { pattern: GC_CRON }, { name: JOB_NAMES.reapIdle, data: {} }
   ```
   Check the installed BullMQ signature of `getJobSchedulers()` (it may take pagination args and return `JobSchedulerJson` with `key`, `pattern`, `tz`, `every`, `next`, `template`) and adapt the structural type minimally. `upsertScheduledJob` validates `{ jobId, trigger: 'SCHEDULE' }` with the W0 payload schema before the call.
3. Barrel: add `export * from './queues.js'; export * from './schedulers.js';` to `packages/core/src/queues/index.ts` (the folder barrel created by W0; contracts are already exported there — do not duplicate; the root `src/index.ts` is frozen). `vitest.config.ts`: add `'src/queues/queues.ts'`, `'src/queues/schedulers.ts'` to `coverage.include`; add `'**/*.integration.test.ts'` and `'**/*.integration-helper.ts'` to `coverage.exclude` (if W0 already excludes `**/*.test.ts` the first is redundant — keep the helper exclusion).
4. Unit tests (no Redis):
   - `queues.test.ts`: `vi.mock('bullmq')` and `vi.mock('ioredis')` with constructor spies; `createQueueConnection` passes no `maxRetriesPerRequest`; `createWorkerConnection` passes `null`; `createQueue` passes `{ connection, prefix }` and the exact name; `createQueues` names match `QUEUE_NAMES`; `createWorker` passes concurrency/prefix and throws `ConfigError` for a connection whose `options.maxRetriesPerRequest` is a number or undefined; `enqueueRunTurn` calls `add('run-turn', { turnId }, { jobId: turnId, … })` and rejects an invalid payload with ZodError before calling `add`; `enqueueManualJobRun` data has `trigger: 'MANUAL'`; `enqueueDestroyChatWorkspace` jobId; `closeConnection` swallows "Connection is closed" and rethrows other errors.
   - `schedulers.test.ts` with an in-memory `SchedulerQueue` fake (Map by key, records calls): upsert args exact; remove returns the fake's boolean; `listSchedulers` maps/sorts/excludes the GC key and turns nulls into undefined; `applyReconcilePlan` calls upsert for each `plan.upsert` and remove for each `plan.remove`, returns the two lists, awaits sequentially (order recorded); `upsertGcScheduler` exact args; invalid job (bad cron? no — cron validity is 1F.1's concern; here test the payload schema path with an empty id if the schema rejects it).
5. `packages/core/src/queues/redis.integration-helper.ts`: `requireRedisUrl(): string | null` — returns `process.env.REDIS_URL` or `null`; `describeRedis(name, fn)` wrapper: if no URL and `process.env.CI` → `describe(name, () => { it('fails loudly: Redis required in CI', () => { throw new Error('REDIS_URL is not set; CI must provide Redis (see .github/workflows/ci.yml integration job)'); }); })`; if no URL locally → `describe.skip(name + ' (set REDIS_URL to run)', fn)`; else `describe(name, fn)`. Also `uniquePrefix()` → `ah-test-${randomUUID()}`; `pingOrFail(conn)` → `PING` with a 5 s timeout, throwing a message with the URL's host:port and `pnpm infra:up` hint (never the full URL if it ever carried credentials — it does not here, but strip userinfo anyway).
6. Integration tests (`describe` names start with `@redis`):
   - `schedulers.integration.test.ts`: real `createQueue(QUEUE_NAMES.scheduledJobs, { connection, prefix })`; upsert job A (`*/5 * * * *`, UTC) → `getJobSchedulers()` has exactly one with that key/pattern/tz; upsert A again with `0 * * * *` → still exactly one, pattern updated; upsert B; `listSchedulers` → [A, B] sorted; `removeScheduledJob(A)` → true, list → [B]; `applyReconcilePlan(reconcile(dbJobs, await listSchedulers()))` with jobs {B enabled, C enabled, D disabled-with-stale-scheduler} → upserts C, removes D (pre-create D), second application → `{ upserted: [], removed: [] }` and list equals {B, C}; `upsertGcScheduler` then `listSchedulers` still excludes it while `getJobSchedulers()` includes it; `afterAll`: `queue.obliterate({ force: true })`, close queue and connections.
   - `queues.integration.test.ts`: `createWorkerConnection(url).options.maxRetriesPerRequest === null` and `createQueueConnection(url).options.maxRetriesPerRequest !== null`; `createWorker` with the queue connection → `ConfigError` (no Worker constructed); round trip: `enqueueRunTurn(queue, { turnId })` then a `createWorker(QUEUE_NAMES.chatTurns, processor)` that resolves a promise with `job.data` and `job.id === turnId`; enqueue the same turnId twice → one job (idempotent jobId); `afterAll` close worker/queue/connections and obliterate.
   - Both files: `beforeAll` → `pingOrFail`; timeouts 30 s.
7. `packages/core/package.json`: confirm `test:integration` runs `vitest run --config vitest.config.ts src/**/*.integration.test.ts` (W0 created it for `@db`; if the glob already covers `*.integration.test.ts`, change nothing).

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- `bullmq`/`ioredis` runtime imports only in these two files (+ helper/integration tests). No new dependencies.
- Never mutate a shared ioredis client's options; never set `maxRetriesPerRequest: null` on the producer connection.
- Do not modify `queues/contracts.ts`.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` (no REDIS_URL) — green; 100 % on `src/queues/queues.ts`, `src/queues/schedulers.ts`
- `REDIS_URL=redis://127.0.0.1:<test-port> pnpm --filter @agent-hangar/core test:integration` — `@redis` suites green; Redis key scan after the run shows no `ah-test-*` keys left (`redis-cli -p <port> --scan --pattern 'ah-test-*' | wc -l` → 0)
- `CI=1 REDIS_URL= pnpm --filter @agent-hangar/core test:integration` — fails with the "Redis required in CI" message (proves loud failure), then unset
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1f-scheduling-workspace.md; append `- 1F.4 ✅ <date> — <summary incl. bullmq version>`; commit `feat(core): add BullMQ queue, worker and job scheduler factories`.
````

---

## Task 1F.5 — Close-out: gates, code review, dashboard, PR

**Status:** ✅ Done · **Priority:** P0 · **Size:** S · **Depends on:** 1F.1–1F.4

**Description.** Run every gate for the lane's owned paths (unit + `@redis` integration), run the code review to zero findings, update the plan dashboard and tasks index, open the PR and return the structured summary.

**Acceptance criteria**
- [x] `pnpm lint && pnpm format:check && pnpm typecheck` exit 0; `pnpm --filter @agent-hangar/core test -- --coverage` green with 100 % ×4 on `src/scheduling/**`, `src/workspace/**`, `src/restore/**`, `src/queues/queues.ts`, `src/queues/schedulers.ts`; `pnpm --filter @agent-hangar/core test:integration` green against the test-instance Redis
- [x] `/bymax-quality:code-review` zero open findings
- [x] `docs/plan.md` §12 row W1-F → 🟨 with branch/PR/coverage; `docs/tasks/README.md` row updated
- [x] PR opened; structured summary returned

**Files to modify**
`docs/plan.md` (§12 row only), `docs/tasks/README.md` (lane row only), `docs/tasks/wave-1f-scheduling-workspace.md` (header + log).

**Agent prompt**

````
You are a senior engineer closing out lane W1-F of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 · Node 24 · Vitest 4 · BullMQ 6 · Redis 8 (compose) · GitHub CLI.
Branch feat/w1f-scheduling-workspace (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-F (Scheduling, workspace lifecycle, restore context, queues) — Task 1F.5 of 5 (LAST)

PRECONDITIONS
- Tasks 1F.1–1F.4 done and committed on this branch; working tree clean; the `AH_INSTANCE=test` Redis is reachable (or start it as described in 1F.4).

REQUIRED READING (only these):
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard"
- docs/tasks/README.md (W1-F row)
- CLAUDE.md "Gates before any PR"

TASK
Run all gates for the owned paths (unit and @redis integration), review to zero findings, update dashboards, open the PR, return the summary. Do not merge, do not wait for CI.

DELIVERABLES

1. Gates (fix, never suppress):
   - `pnpm lint && pnpm format:check && pnpm typecheck`
   - `pnpm --filter @agent-hangar/core test -- --coverage` → 100×4 on the five owned include globs (confirm `coverage.include`)
   - `REDIS_URL=<test instance> pnpm --filter @agent-hangar/core test:integration` → `@redis` green; no `ah-test-*` keys left
   - `grep -rln "from 'bullmq'\|from 'ioredis'" packages/core/src | grep -v "^packages/core/src/queues/"` → empty (type-only imports elsewhere are fine; check they are `import type`)
   - `git diff --name-only main...HEAD` → only owned paths + `packages/core/vitest.config.ts` (+ `packages/core/package.json` only if the `test:integration` glob needed the `*.integration.test.ts` pattern) + this task file (+ the two dashboard rows). Revert anything else.
2. `/bymax-quality:code-review` (full) on `main...HEAD`; resolve CRITICAL/HIGH/MEDIUM/LOW; unresolved items need a written justification in the PR "Review notes". Re-run gates after fixes. If the pre-push hook requires a cleared review, run `~/.claude/hooks/code-review-clear.sh` only when everything is resolved.
3. Dashboards: `docs/plan.md` §12 row `W1-F` → `🟨` with `feat/w1f-scheduling-workspace` / `#<PR>` + coverage; `docs/tasks/README.md` W1-F row → 🟨 PR open; this file's header Status → 🟨 PR open, Progress 5/5. Commit `docs(tasks): close out W1-F`.
4. Open the PR: `gh pr create --base main --head feat/w1f-scheduling-workspace --title "feat(core): scheduling, workspace lifecycle, restore builder and queue factories (W1-F)" --body-file <generated>`. Body: Summary · Files · How consumers use it (W2-A: `validateCronSpec`/`nextRunAt`/`describeCron` in `/api/jobs`, `upsertScheduledJob`/`removeScheduledJob`, `enqueueRunTurn`; W2-B: `ensureWorkspaceDecision` + `buildTurnRequest`, `assertWorkspaceTransition`, `selectIdleWorkspaces`, `planOrphanReconcile`, `createWorkerConnection`/`createWorker`, `applyReconcilePlan(reconcile(...))` on boot, `upsertGcScheduler`) · Decisions (TOOL_SUMMARY → system role; char budget as token proxy; `WorkspaceBusyError` for stalled recovery; reconcile upserts only changed schedulers) · Gates · Coverage · Integration results (Redis version) · Review notes · Contract change requests. English, no attribution.
5. Return: `{ pr, branch: 'feat/w1f-scheduling-workspace', headSha, gates: { lint, format, typecheck, unit, integration }, coverage: { lines, branches, functions, statements }, contractChangeRequests: [...] }`.

Constraints:
- English; Conventional Commits; no AI attribution anywhere. Do not touch paths outside the owned list except the two dashboard rows.

Verification:
- `gh pr view --json number,headRefOid,state` — PR exists, open
- `git status --porcelain` — empty

Completion Protocol: update status/AC/progress in docs/tasks/wave-1f-scheduling-workspace.md (lane header Status → 🟨 PR open); append `- 1F.5 ✅ <date> — PR #<n> opened`; push the final commit before opening the PR.
````

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)
- 1F.1 ✅ 2026-08-19 — cron validation/description/next-run over cron-parser 5.10.0, overlap policy, scheduler keys and reconcile plan; 46 unit tests, 100 % on `src/scheduling/**`
- 1F.2 ✅ 2026-08-19 — workspace and run transition tables, ensure-workspace decision with `WorkspaceBusyError`, idle-TTL selection and orphan reconcile; 33 unit tests, 100 % on `src/workspace/**`
- 1F.3 ✅ 2026-08-19 — history window with anchor and compaction item, TOOL_SUMMARY text, workspace notices, restore-context and turn-request builders; schema failures report field paths only, proven with canaries; 57 unit tests, 100 % on `src/restore/**`
- 1F.4 ✅ 2026-08-19 — BullMQ 6.1.2 / ioredis 6.0.0 connection, queue, worker and Job Scheduler factories; 30 unit tests reach 100 % without Redis, 7 `@redis` tests pass against compose Redis 8.10.0
- 1F.5 ✅ 2026-08-19 — PR #12 opened; gates green, code review and security review at zero findings
