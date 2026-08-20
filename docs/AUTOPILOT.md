# Autopilot Config — Agent Hangar

> Per-project parameters for /bymax-workflow:autopilot. Reviewed and
> approved by the operator before the first run. The planning docs own WHAT
> to build; this file owns HOW the chain runs.
>
> **Operator decision recorded at init (2026-08-19):** this roadmap was
> designed for *parallel* lanes (plan §3–§4, §13) and the operator asked
> the chain to optimise wall-clock. The autopilot default "one implementer
> at a time" is therefore **overridden** by the Concurrency policy below,
> with the memory/Docker guardrails that make the override safe. Everything
> else in the autopilot skill (preflight, merge gate, watchers, thread
> resolution, worktree discipline, anti-hallucination) applies unchanged —
> per PR.

## Identity

- **Project root**: /Users/maximiliano/Documents/MyApps/general/agent-hangar
- **GitHub repo**: bymaxone/agent-hangar (visibility: private)
- **Default branch**: main
- **Product summary**: Agent Hangar — a local-first web app where AI agents
  answer questions and perform coding tasks against GitHub repositories
  inside isolated, disposable Docker workspaces; cron-scheduled jobs run in
  fresh workspaces; Settings stores encrypted credentials (GitHub PAT,
  OpenAI key). Stack: pnpm 11 workspaces · TypeScript ~6.0.3 strict ·
  Node 24 · Next.js 16 App Router + React 19 · Tailwind v4 + shadcn (Base
  UI) · Postgres 18 + Prisma 7 (adapter-pg) · Redis 8 + BullMQ 6 ·
  dockerode 5 · openai SDK (Responses API) · Vitest 4 · Playwright ·
  Stryker 10. Defining constraint: **100 % coverage on all four metrics
  per package, zero suppressions, secrets only as ciphertext in Postgres**.
- **Roadmap file**: docs/plan.md (§4 wave plan + dependency table, §12
  status dashboard)
- **Tasks index**: docs/tasks/README.md
- **Phases**: 17 lanes / 94 tasks (lane files `docs/tasks/wave-*.md`)

### Vocabulary mapping (this project speaks "lanes", the skill speaks "phases")

| Skill term | This project |
|---|---|
| phase | **lane** — `W0`, `W1-A` … `W1-I`, `W2-A` … `W2-C`, `W3-A`, `W3-B`, `W4-A`, `W4-B` |
| `{{PHASE_NUMBER}}` / `{{PHASE_NN}}` | lane id (`W1-A`) / lowercase slug (`w1a`) |
| `{{PHASE_FILE}}` | the lane file in the tasks index, e.g. `docs/tasks/wave-1a-secrets-redaction.md` |
| branch `feat/phase-NN-slug` | **the `Branch` value in the lane file header** (e.g. `feat/w1a-secrets-redaction`) — use it verbatim |
| PR title `…phase N…` | the `gh pr create --title` text of the lane's close-out task (e.g. `feat: foundation, frozen contracts and tooling (W0)`) |
| Progress Dashboard | `docs/plan.md` §12 (one row per lane) |
| phase-files table | `docs/tasks/README.md` (one row per lane) |
| phase header | the lane file header block (`Status`, `Progress`, `Last updated`) + `## Completion log` |
| Definition of Done | the lane's **DONE** line in plan §5–§9 + every acceptance criterion of its close-out task |

**Status legend — one vocabulary, the one the planning docs already use:**
📋 ToDo · 🟦 running (worktree) · 🟨 PR open · 🟩 merged · 🟥 blocked
· 🟡 deferred by decision. Mapping to the skill's generic legend:
📋=ToDo, 🟦=In Progress, 🟨=Review, 🟩=Done, 🟥=Blocked. **🟡 in this project
means deferred by decision — in the plan, scheduled later, not blocked and
not cancelled** (W4-A and W4-B carry it since 2026-08-20); it is *not* the
skill's "Partial". For Partial use **🟩 with a `partial: <outstanding item>`
note in the Notes column** — the lane counts as merged but not Done until
the note is cleared. `docs/plan.md` §12 used to show ⬜ for "not started";
it was normalised to 📋 on 2026-08-20 and ⬜ is no longer used as a status.
The one ⬜ left in `docs/tasks/` sits inside a completed acceptance criterion
of W3-B and is quoted as it was written; do not normalise that one.

## External preconditions

| Applies to | Check (exit 0 = OK) | On failure |
|---|---|---|
| launch | `command -v gh && gh auth status` | STOP — `gh auth login` |
| launch | `docker info` | STOP — operator starts Docker Desktop (needed by W0's image build, every 🐳 lane, `@db`/`@redis` compose stacks) |
| launch | `node -v \| grep -q '^v24\.' && pnpm -v \| grep -q '^11\.'` | STOP — Node 24 + pnpm 11 (`corepack enable`) |
| launch | `gh secret list -R bymaxone/agent-hangar \| grep -q GITLEAKS_LICENSE` | gitleaks-action requires a (free) license key for organisation repos; without it the `secret-scan` job fails on every PR. **Decision at launch (2026-08-19): the secret was not set, so the `secret-scan` job runs gitleaks from the official container image** (`docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8 git /repo --redact --no-banner` — full history on `push` to `main`, `--log-opts="origin/main..HEAD"`-style PR scope on pull requests) — no license needed. W0 implements it that way; switching back to `gitleaks/gitleaks-action@v2` is a later 1-line PR once the operator sets the secret. |
| launch | `df -g / \| awk 'NR==2 {exit ($4 < 30)}'` | STOP — ≥ 30 GB free (Playwright browsers, workspace image, ≤ 5 worktrees with `node_modules`, Stryker sandboxes) |
| launch | `gh api repos/bymaxone/agent-hangar/rules/branches/main --jq 'map(.type) \| index("pull_request")'` prints a number | informational — confirms `main` is PR-only (org ruleset `protect-default-branch`): **no direct pushes to `main` after the seed**, dashboard updates go through PRs (see Dashboard policy) |
| every lane spawn | `git ls-remote --heads origin <lane branch>` prints **nothing** | a leftover branch from a dead run — investigate (open PR? merged?) before re-spawning; never spawn onto an existing remote branch blindly |
| W3-A, task 3A.4 (real OpenAI smoke) | operator has entered a real OpenAI key + GitHub PAT in the Settings page of the W3-A instance (`http://127.0.0.1:3400/settings`, `AH_INSTANCE=w3a`) | **not blocking** — the task file itself says: implement + unit-test the script, mark the real run "pending" in the completion log and the PR. The orchestrator fires a `PushNotification` when W3-A is spawned so the operator can enter the keys while the lane runs; if the real run stays pending, W3-A merges, §12 gets `partial: real OpenAI smoke pending — run pnpm smoke:openai`, and the chain continues (W4 depends on the merge, not on the smoke). |
| W4-C (orchestrator follow-up) | both W4-A and W4-B merged with `break: 80` met on a full run (numbers in their PRs) | skip W4-C; README "Known gaps" keeps the mutation rows (W3-B wrote them). **Not reachable today:** W4-A and W4-B were deferred by decision on 2026-08-20 (plan §9), so this row waits on the operator and not on a check |

No lane depends on an npm publication or any other external event the repo
cannot influence — nothing to poll.

## Concurrency policy (project override of "ONE implementer at a time")

The plan's execution model (plan §3 rules 3–4, §4, §13) **is** the schedule:

- **Cap: 5 concurrent implementers.** A slot frees when an implementer
  returns (PR opened or stop-and-report); merge/fix cycles of an open PR do
  **not** hold a slot (fix sub-agents are short-lived and count toward the
  cap only while running).
- **≤ 1 🐳 lane at a time** (W1-B, W2-B, W3-A are the only 🐳 lanes). A 🐳
  lane builds the workspace image and runs real containers; a second one
  would collide on memory and on the Docker daemon. A lane that only needs
  compose Postgres/Redis (`@db`/`@redis`: W1-E, W1-F, W2-A, W2-C harness)
  is **not** 🐳 and runs concurrently, each on its own compose project via
  the per-lane instance below.
- **Pipeline, not batches.** A lane is spawned as soon as (a) every lane in
  its "Needs merged" row (plan §4 table, mirrored in the tasks index
  `Depends on`) is merged to `main`, (b) a slot is free, (c) the 🐳 slot is
  free if it is 🐳. Do not wait for a whole wave to finish. Suggested first
  fill after W0 merges: W1-A, W1-B 🐳, W1-C, W1-E, W1-F (5 slots); then
  W1-G, W1-H, W1-D, W1-I as slots free (W1-I only after W1-A, W1-C, W1-E
  are merged — plan §4). W2-A starts as soon as W1-A/E/F are merged even if
  other W1 lanes are still running; W2-C as soon as W1-G/H are merged; W2-B
  when W1-A…F are merged **and** the 🐳 slot is free. W3-B (docs) may start
  when W2-A and W2-B are merged while W3-A runs. W4-A and W4-B run in
  parallel (each `concurrency: 2`, the cap the lane files allow).
- **Memory guardrails (what makes the fan-out safe on this 36 GB / 18-core
  machine):** every `vitest.config.ts` sets `maxWorkers: 3` (W0 bakes it;
  CI runners have 4 cores so nothing is lost there); Playwright `workers: 2`
  locally; implementers run **one suite at a time** inside their own
  worktree (never unit + integration + e2e concurrently), export
  `NODE_OPTIONS=--max-old-space-size=4096`, and never spawn test agents.
  Budget: 5 lanes × (3 workers × ~0.5 GB + tsc/eslint ~1.5 GB) ≈ 15 GB +
  Docker Desktop. If the orchestrator observes swap pressure
  (`memory_pressure` → "WARN"/"CRITICAL", or `vm_stat` page-outs climbing),
  it lowers the cap to 3 for the next spawns and notes it in §12 Notes.
- **Per-lane instance (no port / compose collisions):** every implementer
  receives `AH_INSTANCE` and `AH_PORT_BASE` in its prompt and uses them for
  any local stack, dev server, Lighthouse run or integration suite. W0 and
  W1-I are the only lanes allowed on `default`/3000 (W1-I also uses
  `feat-x`/3100 per its own tasks).

  | Lane | `AH_INSTANCE` | `AH_PORT_BASE` | Needs locally |
  |---|---|---|---|
  | W0 | `default` | 3000 | compose (pg+redis), image build, `pnpm dev` smoke |
  | W1-A | `w1a` | 3200 | nothing (pure unit) |
  | W1-B 🐳 | `w1b` (containers use the lane's `AH_INSTANCE=test` conventions) | 3210 | Docker daemon, workspace image |
  | W1-C | `w1c` | 3220 | nothing |
  | W1-D | `w1d` | 3230 | nothing (git in tmp) |
  | W1-E | `w1e` | 3240 | compose Postgres |
  | W1-F | `w1f` | 3250 | compose Redis |
  | W1-G | `w1g` | 3260 | `pnpm dev` with MSW for Lighthouse |
  | W1-H | `w1h` | 3270 | `pnpm dev` with MSW for Lighthouse |
  | W1-I | `default` + `feat-x` | 3000 + 3100 | compose (two instances, per its tasks) |
  | W2-A | `w2a` | 3280 | compose Redis (`@redis` SSE suite) |
  | W2-B 🐳 | `w2b` + `w2b-test` | 3300 + 3310 (as its task file says) | Docker, compose pg+redis, image |
  | W2-C | `w2c` | 3320 | compose pg+redis, gitserver image, Chromium |
  | W3-A 🐳 | `w3a` + `test` | 3400 + 4000 (as its task file says) | full stack |
  | W3-B | — | — | nothing |
  | W4-A / W4-B | — | — | nothing (Stryker with integration env unset) |

- **Watchers scale with PRs:** one background watcher per open PR, each
  writing its own verdict file (`<scratchpad>/watch-<lane>.verdict`); the
  `ScheduleWakeup` fallback prompt lists **every** running lane and open PR
  with its state. Verdicts are handled one PR at a time, in arrival order;
  a merge never waits for another lane's PR.
- **Merges are serialised** (one `gh pr merge` at a time, each followed by
  `git pull` on `main`). After every merge, check every other open lane PR:
  `gh pr view <N> --json mergeStateStatus` — `CONFLICTING`/`DIRTY` → rebase
  it (fix sub-agent on that branch, or inline in a fresh worktree: the
  shared files are append-only by design — `vitest.config.ts`
  `coverage.include` lines, `packages/core/package.json` `exports`,
  `apps/web/src/mocks/handlers.ts` spreads, §12/README rows — take both
  sides), re-run the lane's gates, push. `BEHIND` alone needs no action
  (squash merges keep linear history without an up-to-date branch).

## Orchestrator-owned coordination actions (beyond the standard loop)

These come straight from plan §11 "MERGE ORDER" and the lane files. The
orchestrator performs them; implementers only describe them in PR bodies.

1. **W1-B ↔ W1-D Dockerfile lines.** W1-D's PR body carries verbatim the
   two `COPY` lines for `infra/workspace/Dockerfile`, the `infra:image`
   script change and the CI step. When merging the **later** of W1-B /
   W1-D, first commit those lines onto the later PR's branch (release the
   branch from its worktree, fresh worktree, `git switch` the branch, edit,
   `pnpm infra:image` builds, commit `build(workspace): bundle the agent
   runtime into the image`, push), let CI validate (`build` job), then
   merge under the normal gate.
2. **W1-H finalize after W1-G (and W1-F).** W1-H's close-out task 1H.6
   requires W1-G merged and stops-and-reports otherwise. When the W1-H
   implementer returns **without a PR** ("W1-G not merged"), verify the
   branch via `git` (commits ahead of `main`, clean tree), wait for the
   W1-G (and W1-F) merges, then spawn a *finalize* sub-agent on the same
   branch in a fresh worktree whose prompt is task 1H.6 only (rebase,
   delete every `TEMP-STUB(W1-H)`, swap `lib/cron.ts`, gates, Lighthouse,
   review, PR). Same pattern for any lane that stops at a precondition.
3. **Contract-change requests.** A lane that returns
   `contractChangeRequests: [...]` (additive only) or stops on a missing
   contract: the orchestrator opens a 1-file PR against
   `packages/core/src/**/types.ts` (+ Zod), merges it under the gate, then
   re-spawns the lane (same branch, fresh worktree, prompt = "continue from
   task N.k") — the dependants still running get a PR comment noting the
   new export.
4. **`chore(deps)` PRs.** A lane that truly needs a dependency stops and
   reports; the orchestrator adds it on `main` via a tiny PR, then
   re-spawns the lane. Lanes never touch `pnpm-lock.yaml`.
5. **Finalize-agent on context exhaustion** (plan §10 risk): a worktree
   with commits but no PR and a dead implementer → spawn a finalize
   sub-agent on the **same worktree path** to run the remaining tasks,
   gates, review and PR.
6. **W4-C** (after W4-A + W4-B merged): a tiny PR adding the `mutation` CI
   job (PR-scoped incremental + nightly full, `reports/mutation/`
   artifact) and the README mutation badge/section, removing the W4 rows
   from README "Known gaps". Orchestrator-authored, merged under the gate.
7. **W3-A real-smoke notification** (see External preconditions).

### Dashboard policy (because `main` is PR-only)

**The routine, in the order it must happen — this is part of the merge, not a separate errand.**
It slipped three times before being written down here: the board sat six merges behind reality
once, and went stale again within an hour of being fixed, because each flip was treated as its own
task to be scheduled later rather than as the last step of the merge in front of it.

Immediately after every **lane** merge, before picking the next lane:

1. `git switch docs/dashboard-rolling` (create it from `origin/main` if it does not exist) and
   flip the row that just changed — in `docs/plan.md` §12 and in `docs/tasks/README.md`.
2. Flip a lane to 🟦 in the same branch the moment it is spawned, so a running lane is never
   invisible.
3. Push. If the rolling pull request is already open, the push is the whole update. If not, open
   it. It merges under the ordinary gate like any other pull request.
4. Rebase the rolling branch after each lane merge; it edits the same two files every lane's
   close-out edits, so it conflicts by design and the resolution is always to keep the newer
   status.
5. The rolling pull request is not itself a trigger. Merging it changes no lane's status, so it
   starts no new cycle — the branch is simply gone until the next lane merge recreates it from
   `origin/main`. Without this stop the rule reads as self-triggering and the chain never ends.

**Read the state from `gh`, never from memory.** Three separate accuracy errors were caught by
doing that — a lane published as PR-open after it had merged, a note claiming Dockerfile lines had
landed when the file held one `COPY`, a progress note a whole task behind. The board is read by
people deciding what to start next, so a stale row is worse than an absent one.


The org ruleset forbids direct pushes to `main`, so `docs(plan): mark
<lane> merged` can never be pushed directly. Instead:

- Each implementer already writes its own rows: 🟦 at claim (STEP 0), 🟨 at
  PR open (close-out task), plus the lane file header/log — inside its PR.
- After a merge, the orchestrator flips that lane's rows to 🟩 (plan §12
  row with PR number, `docs/tasks/README.md` row, lane file header Status)
  on a branch `docs/dashboard` and opens/updates **one** rolling dashboard
  PR: if a dashboard PR is already open, push the new flip onto it; if not,
  open a new one (`docs(plan): mark <lanes> merged`). It merges under the
  same gate as any PR (CI green + no open threads + grace). A dashboard PR
  that conflicts with a just-merged lane row is rebased taking both sides.
- The chain's **source of truth is `gh`** (merged PRs per lane branch), not
  the dashboard — the dashboard lags by at most one rolling PR. STEP 0
  ("pick the next lane") reads merged state from
  `gh pr list --state merged --search "head:<branch>"` and the dependency
  table, then reconciles the dashboard.
- Audit before flipping 🟩: the lane's DONE line (plan §5–§9) and its
  close-out acceptance criteria are met **and** CI is green on `main` after
  the merge (`gh run list --branch main --limit 1`). Unmet bullet →
  `partial: …` note instead.

## Model policy

| Lane | Model | Rationale |
|---|---|---|
| W0 | inherit | first contact with the whole toolchain at once (TS 6 pin, Prisma 7 + adapter-pg, Next 16, Tailwind v4 + shadcn Base UI, Vitest 4, pnpm 11 CI); every later lane builds on its frozen contracts — invented APIs here cost nine lanes |
| W1-A | inherit | security-sensitive: AES-256-GCM envelope, master-key file perms, redaction shapes, logger redaction — the invariants every `/security-review` will probe |
| W1-B 🐳 | inherit | first contact with dockerode 5 + container hardening (security opts, limits, no socket inside, env never logged) |
| W1-C | inherit | first contact with the OpenAI Responses streaming API — event names must come from the shipped SDK types, not memory |
| W1-D | inherit | security-sensitive: path confinement, env scrubbing, `GIT_ASKPASS`, cancellation; runs inside the container with the secrets |
| W1-E | sonnet | Prisma repositories on a frozen schema and frozen ports; mechanical on a fully specified checklist (redact-on-write is injected, not designed here) |
| W1-F | inherit | BullMQ 6 Job Scheduler API (first contact; vault patterns exist but the API is easy to invent) + DST/cron arithmetic and the restore-context budget rules |
| W1-G | sonnet | UI on an established design system and frozen API contracts with MSW; large but fully specified (spec 10) |
| W1-H | sonnet | same as W1-G, smaller |
| W1-I | sonnet | shell scripts + doctor on a fully specified checklist |
| W2-A | inherit | security-sensitive: settings routes (plaintext only in the PUT body, no request logging), SSE replay/tail, Zod validation at every boundary |
| W2-B 🐳 | inherit | security-sensitive: the only place `reveal()` runs; plaintext into `runner.create` only; redact before publish/persist; orchestration of every flow |
| W2-C | sonnet | Playwright harness + specs against the mocked UI on a fully specified list (spec 06 §4) |
| W3-A 🐳 | inherit | final integration/hardening: coverage widening, flakiness at the root, success criteria S1–S6/S8 with evidence |
| W3-B | sonnet | documentation from existing sources |
| W4-A | sonnet | strengthening tests against a mutation report — mechanical, guided by the survivor list |
| W4-B | sonnet | same |

Fix sub-agents **always** escalate to `inherit` when a lane stalls on
review/CI findings (second fix cycle onward, and always for
`/security-review` findings).

**Heavy lanes** (silent-death watch widened to ~120 min): W0 (full
install + image build + Next/Prisma first runs), W1-B 🐳, W2-B 🐳, W2-C
(Chromium install + gitserver image), W3-A 🐳 (Playwright 3× green), W4-A,
W4-B (Stryker full runs). All others: ~60 min.

## Gates

Every lane runs the common gate set; lanes add the rows marked for them.
All coverage thresholds are **100/100/100/100** on the package's
`coverage.include` (owned paths until W3-A widens to `src/**`).

| Gate (local command) | Active for |
|---|---|
| `pnpm lint && pnpm format:check && pnpm typecheck` | every lane (W0+) |
| `pnpm test -- --coverage` (Vitest, thresholds enforced in config; `maxWorkers: 3`) | every lane (W0+) |
| Compose stack for the lane (`eval "$(AH_INSTANCE=<lane> AH_PORT_BASE=<base> bash infra/scripts/env.sh --print)"; docker compose -f infra/docker-compose.yml up -d --wait`) then `pnpm test:integration` with `DATABASE_URL`/`REDIS_URL` set | `@db`/`@redis` lanes: W1-E, W1-F, W2-A (and their fix cycles) |
| `pnpm infra:image` + `DOCKER_AVAILABLE=1 pnpm test:integration` (`@docker` suites must **fail loudly**, never skip, when `CI=1`) | 🐳 lanes: W1-B, W2-B, W3-A |
| `pnpm --filter @agent-hangar/agent-runtime build && pnpm --filter @agent-hangar/agent-runtime check:bundle` (< 2 MB; `node dist/cli.js --version`) | W1-D |
| Lighthouse accessibility ≥ 95 on the lane's pages with MSW (`pnpm dlx lighthouse … --only-categories=accessibility`), screenshots in the PR | W1-G, W1-H, W3-A |
| `pnpm test:e2e` in mock mode (specs compile, selectors resolve, harness boots/tears down) | W2-C |
| Playwright suite green **3× consecutively** on the real stack with `--retries=0`; `pnpm smoke:openai` (or "pending"); `pnpm infra:doctor` exit 0 for two instances; CI all jobs green | W3-A |
| `pnpm test:mutation` per package, full run with `incremental: false`, `break: 80` (target 90), equivalent-mutant ledger in the PR | W4-A (core), W4-B (agent-runtime) |
| `/bymax-quality:code-review full` → zero findings; `/security-review` → zero findings (including Low) | every lane, before the PR |

**CI checks (contractual job names from W0 T0.8 / spec 06 §6):** `lint`,
`typecheck`, `unit`, `integration`, `e2e`, `build`, `secret-scan`; `mutation`
is added by W4-C only. Org-installed checks that also appear on every PR and
must pass: **Socket Security: Project Report**, **Socket Security: Pull
Request Alerts** (observed on sibling `bymaxone/*` repos). **Expected-skip
CI checks**: none declared; a check reported as `skipping` is investigated,
not counted as pass, until the operator lists it here.

## Invariant greps

Each command must print nothing (run from the repo root, on the lane's
branch, before the PR). W4 lanes may keep a `// Stryker disable next-line
<mutator>: <reason>` only with the one-line reason the lane rules require —
list each one in the PR.

```bash
# dockerode confined to the runner folder (spec 01 §7 migration seam)
grep -rn "dockerode" apps packages --include='*.ts' --include='*.tsx' | grep -v "packages/core/src/runner/docker/"
# no suppression comments (code-review CRITICAL)
grep -rnE "eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|istanbul ignore|v8 ignore" apps packages scripts infra --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js' --include='*.sh'
# no TypeScript enum (string-literal unions only; Prisma enums live in schema.prisma)
grep -rnE "^\s*(export\s+)?(declare\s+)?(const\s+)?enum\s+[A-Za-z]" apps packages scripts --include='*.ts' --include='*.tsx'
# node: prefix for crypto; no uuid/nanoid
grep -rnE "from ['\"](crypto|uuid|nanoid)['\"]" apps packages scripts --include='*.ts' --include='*.tsx'
# no secret-shaped literals except the canaries
grep -rnE "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=dist --exclude-dir=coverage | grep -v TESTCANARY
# real .env / master key never committed
git ls-files | grep -E "(^|/)\.env($|\.local$|\.[a-z]+$)|master\.key$" | grep -v "\.env\.example$"
# no AI-attribution trailers in the lane's commits
git log origin/main..HEAD --format=%B | grep -iE "co-authored-by: (claude|anthropic|copilot|gpt)|generated with|generated by (claude|ai)"
```

**Presence checks — the security defaults must not be silently dropped when a
file changes owner.** Same convention: each command prints nothing when the
project is correct. Skip a check only while the file it names does not exist
yet (before W0 merges, and before W2-A creates the API routes).

```bash
# 1. security headers still wired (owner: W0; W3-A may touch the file)
[ -f apps/web/next.config.ts ] && { grep -q "Content-Security-Policy" apps/web/next.config.ts || echo "MISSING: CSP in next.config.ts"; grep -q "frame-ancestors" apps/web/next.config.ts || echo "MISSING: frame-ancestors in next.config.ts"; grep -q "X-Content-Type-Options" apps/web/next.config.ts || echo "MISSING: nosniff in next.config.ts"; }
# 2. web app still bound to loopback (owner: W0, then W1-I; W2-A/W2-C edit sibling keys)
[ -f apps/web/package.json ] && { grep -qE '\-H +127\.0\.0\.1' apps/web/package.json || echo "MISSING: loopback bind in apps/web scripts"; }
# 3. every mutating route handler calls the same-origin guard (owner: W2-A)
#    A grep over the route files cannot fail here: the guard lives in the handler behind a thin
#    wiring module, so every route reads as covered by construction. The check is a test that
#    calls each state-changing export from a foreign origin and names the route when the guard
#    is gone. Do not reintroduce the grep.
[ -d apps/web/app/api ] && { [ -f apps/web/app/api/same-origin-policy.test.ts ] || echo "MISSING: apps/web/app/api/same-origin-policy.test.ts — the only check that can fail when a route loses the guard"; }
# 4. the Markdown renderer keeps its unsafe-URL tests and never gains rehype-raw (owner: W1-G)
[ -d apps/web/src/shared/transcript ] && { grep -rq "javascript:" apps/web/src/shared/transcript/**/AssistantMarkdown.test.tsx 2>/dev/null || echo "MISSING: unsafe-href tests for AssistantMarkdown"; }
grep -rn "rehype-raw" apps packages --include='*.ts' --include='*.tsx' --include='*.json' 2>/dev/null
# 5. workspace containers still grouped AND still in their own compose project (owner: W1-B)
F=packages/core/src/runner/docker/container-spec.ts
[ -f "$F" ] && { grep -q "com.docker.compose.project" "$F" || echo "MISSING: compose project label on workspace containers"; grep -q "com.docker.compose.service" "$F" || echo "MISSING: compose service label on workspace containers"; grep -q -- "-ws" "$F" || echo "MISSING: -ws suffix — workspaces would share the stack compose project and become --remove-orphans targets"; grep -q -- "-ws" "${F%.ts}.test.ts" 2>/dev/null || echo "MISSING: unit test pinning the -ws project value"; }
```

(The "every `it()` carries a block comment" and "JSDoc on every export"
policies are checked by `/bymax-quality:code-review`, not by grep.)

## Security invariants & review focus

From spec 01 §7, spec 04 (d) and the lane rules. Auditable statements every
`/security-review` and `/bymax-quality:code-review` must check:

- Secrets (GitHub PAT, OpenAI key) exist in plaintext only: in the
  `PUT /api/settings/:key` request body, in worker memory during
  `reveal()` → `runner.create({ env })`, and in the container's env. Never
  in the repo, the image layers, logs, Postgres (ciphertext + iv + authTag
  + keyVersion + last4 only), API responses (`{set, last4}` only), UI (last
  4 chars), error messages, test fixtures or PR bodies.
- `master.key` is created `0600` outside the repo (`~/.agent-hangar/`,
  `MASTER_KEY_PATH` override), never read by the web app for decryption
  (status-only), `.gitignore`d even if copied in.
- Redaction is defence in depth: runtime redacts by shape; the worker
  redacts every `AgentEvent` (exact values + shapes) **before** publish or
  persist; repositories redact on write; the pino logger redacts paths and
  serialises through the `Redactor`. Canaries (`GITHUB_CANARY`,
  `OPENAI_CANARY` from `packages/core/src/testing/canaries.ts`) are the only
  secret-shaped strings allowed anywhere, and tests assert they never reach
  output, rows, logs or container image config.
- Shell tool children get a **scrubbed** env (no `GITHUB_TOKEN`,
  `OPENAI_API_KEY`); git authenticates only via `GIT_ASKPASS`; every
  file tool is path-confined to `/workspace` (symlink escapes rejected),
  output truncated, per-command timeout, turn-level max steps / wall clock,
  cancel = SIGINT → `AbortController`.
- Containers: one per chat / per scheduled run, no shared filesystem,
  CPU/memory/PIDs limits, security opts applied, **no Docker socket
  mounted**, labelled `ah.instance=<instance>` so GC touches only its own
  instance; `WorkspaceImageMissing` is a typed error, never a silent
  fallback.
- `dockerode` is imported only under `packages/core/src/runner/docker/**`
  (ESLint `no-restricted-imports` + the grep above).
- API: every route Zod-validates request and response via
  `packages/core/src/api/contracts.ts`; `/api/settings` handlers disable
  request logging; SSE routes send no compression, heartbeat every 15 s,
  `Last-Event-ID` replay from Redis Streams; same-origin only.
- No `continue-on-error`, no `--no-verify`, no suppression comments, no
  weakened coverage thresholds — in implementer work or in orchestrator
  fixes.

### Web security defaults (added 2026-08-19, operator-approved)

The specification defines no HTTP security headers, no bind address and no
same-origin enforcement. That is a real gap for a local service that stores
credentials and executes code in containers, so four requirements were added
to the lanes that own the relevant files. They are acceptance criteria, not
suggestions.

| # | Requirement | Owning lane |
|---|---|---|
| 1 | `apps/web/next.config.ts` sends `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `Permissions-Policy: camera=(), microphone=(), geolocation=()` on `/:path*`. CSP: `default-src 'self'`, `img-src 'self' data:`, `font-src 'self' data:`, `connect-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`, `object-src 'none'`, `style-src 'self' 'unsafe-inline'` (Tailwind and shadcn inject inline styles), `script-src 'self' 'unsafe-inline'` plus `'unsafe-eval'` in development only (the dev server needs it for HMR). | **W0** (T0.7) |
| 2 | `next dev` and `next start` bind to `127.0.0.1` (`-H 127.0.0.1`), so the credential-writing API is never published to the local network. | **W0** (scripts; W1-I keeps it when it takes over the root scripts block and in `run.sh`) |
| 3 | An `assertSameOrigin(request)` helper in `apps/web/src/server/**`, called at the top of **every** POST/PUT/PATCH/DELETE handler, 403 on mismatch. It runs **two** checks in this order: (a) the `Host` header's hostname must be an approved loopback name — `127.0.0.1`, `localhost` or `[::1]` (port free, instances vary) — which is what actually defeats DNS rebinding; (b) `Origin`, when present, must equal the origin derived from that `Host`, and when absent only `Sec-Fetch-Site: same-origin` or `none` is accepted. GET/HEAD and the SSE routes are unaffected. | **W2-A** (T2A.1) |
| 4 | `AssistantMarkdown` pins the safe-URL behaviour with its own tests (`javascript:` and `data:text/html` hrefs dropped; an `https://` link keeps its href plus `target="_blank"` and `rel="noopener noreferrer"`) instead of relying on the `react-markdown` default `urlTransform`. No sanitiser dependency, no custom `urlTransform`. | **W1-G** |

**Why requirement 3 matters even without authentication:** the API has no
session cookie, so its effective authorisation is "whoever reaches the port".
A malicious page open in the developer's browser can send
`fetch(url, { method: 'PUT', mode: 'no-cors', headers: { 'Content-Type':
'text/plain' }, body: '{"value":"..."}' })` — no preflight is triggered, the
request reaches the handler, and `request.json()` parses the body regardless
of the declared content type. The response is opaque to the attacker, but the
write succeeds.

**Why the `Host` check is not redundant:** an `Origin`-versus-`Host`
comparison alone does **not** stop DNS rebinding. After a rebind the browser
still believes it is talking to `attacker.example`, so it sends
`Origin: http://attacker.example:3000` *and* `Host: attacker.example:3000` —
the two match and a comparison-only guard passes while the request lands on
loopback. Pinning the `Host` hostname to an approved loopback name is the
check that actually rejects it, which is why requirement 3 orders the two
steps the way it does.

**Honest limit of requirement 1:** `'unsafe-inline'` on `script-src` (there is
no nonce pipeline in v1) makes the CSP defence in depth rather than a complete
XSS mitigation. The primary XSS defences remain React escaping and rendering
agent Markdown without `rehype-raw`. A nonce-based CSP is the documented
follow-up if the app ever leaves localhost. W3-B records this in the README
"Security notes" section.

**How these reach an implementer.** The lane task files under `docs/tasks/`
are frozen planning documents and are *not* edited for this: the executable
instruction is the implementer prompt the orchestrator renders per lane, which
carries the requirement for the lane that owns the file, and every lane's
`REQUIRED READING` is scoped by that same prompt. Because ownership of these
files moves between lanes (W1-I takes the root scripts block, W2-A and W2-C
edit keys in `apps/web/package.json`, W3-A may touch any path), remembering is
not a control — the presence checks below are, and they run in **every** lane's
STEP 2 from W0 onward.

### Docker resource grouping (added 2026-08-19, operator request)

Docker Desktop groups containers by the `com.docker.compose.project` label.
The stack already groups: `infra/docker-compose.yml` sets
`name: ${COMPOSE_PROJECT_NAME}` (`agent-hangar-<instance>`), so Postgres,
Redis, their volumes and networks appear as one tree entry per instance, and
the workspace image is namespaced by its repository (`agent-hangar/workspace`).

What did **not** group: the disposable workspace containers
(`ah-ws-<instance>-<id>`) are created through dockerode, not compose, so they
carried only the `ah.*` labels and were listed loose at the top level — and
they are the ones that multiply, one per chat and one per scheduled run.

**Requirement (W1-B, `buildContainerCreateOptions`):** every workspace
container also carries

| Label | Value |
|---|---|
| `com.docker.compose.project` | `agent-hangar-<instance>-ws` |
| `com.docker.compose.service` | the workspace kind, lowercased (`chat`, `job`) |

**What actually guarantees the value is a test, not the grep.** A grep can
assert that a label key is present; it cannot pin the value it is set to, and
the value is the whole point here. W1-B therefore ships a unit test asserting
that the project label (a) ends with `-ws` and (b) is **not** equal to
`agent-hangar-<instance>`, alongside the container-spec snapshots that pin both
labels for the CHAT and JOB cases. Presence check 5 is a tripwire for the
obvious regressions — key deleted, suffix deleted, test deleted — and the test
is the real contract.

**The `-ws` suffix is load-bearing, not cosmetic.** Reusing the stack's own
project name would group them, but `infra/scripts/archive.sh` runs
`docker compose down -v --remove-orphans`, and compose deletes every container
carrying its project label that is not in the compose file. Sharing the name
would let any stray `--remove-orphans` destroy a live chat container in the
middle of a turn. A distinct project name gives the same tree grouping (it
sorts adjacent to the stack) while keeping the containers outside every
compose command's blast radius. Reaping stays label-based on `ah.instance`.

Images cannot be grouped: Docker Desktop lists images by repository and has no
per-project grouping, so the `agent-hangar/` repository prefix is the whole of
what is available and it is already in place.

**Per-lane review focus** (the lanes the model policy marks
security-sensitive): W1-A (crypto correctness: iv uniqueness, tamper →
`SecretIntegrityError`, wrong key, key-file perms; redaction idempotence
and false positives), W1-B (container spec: limits, security opts, socket
never mounted, env never in errors/logs), W1-D (path confinement incl.
symlinks, env scrubbing, truncation, timeouts, SIGINT path), W2-A
(settings routes never echo values; SSE does not leak other chats' events;
validation on every input), W2-B (`reveal()` scope, redact-before-publish,
`finally` destroy, overlap policy, stalled recovery), W3-A (end-to-end:
`grep` of logs/DB/image for a canary finds nothing; S5 evidence).

## Review bot

- **Reviewer**: GitHub Copilot code review, **requested automatically by the
  org ruleset** (`copilot_code_review`, `review_on_push: true`,
  `review_draft_pull_requests: true`) on every PR and every push. The
  implementer does **not** add a reviewer; after `gh pr create` it verifies
  with `gh pr view <PR#> --json reviewRequests` that
  `copilot-pull-request-reviewer` is listed and only if it is **absent** runs
  `gh pr edit <PR#> --add-reviewer copilot-pull-request-reviewer[bot]`.
- **Review-bot timeout**: 15 minutes — a request pending this long with no
  review submitted is treated as bot-unresponsive: the request is removed,
  a factual PR comment records it, and the gate proceeds CI-only (the
  implementer's zero-findings review floor already ran before the PR).
- **Churn control (vault learning, `bymaxone` org):** `review_on_push`
  re-reviews the *whole diff* on every push. Batch **all** real fixes into
  one push; resolve false positives with a docs-cited rebuttal **without
  pushing** (`resolveReviewThread` does not trigger a re-review). Treat
  every bot finding as a hypothesis verified against the shipped type
  declarations / official docs before "fixing" — never degrade correct,
  modern code to satisfy an outdated suggestion.

## Merge policy

- **Method**: squash (org ruleset allows squash/rebase only; delete branch
  on merge — always, with the `ls-remote` + `branch --list` proof)
- **Grace window**: 5 minutes since last push — **except after the second
  Copilot round** (see the operator directive below), when the gate is
  CI green + zero unresolved threads, no grace.
- **Review-bot timeout**: 15 minutes (see Review bot above)
- **Operator directive (launch, 2026-08-19) — at most 2 Copilot rounds per
  PR, optimise review time:**
  1. *Round 1* = the review Copilot posts after `gh pr create`. Every
     thread is verified against the code: real findings are fixed
     (**all of them, one batched push**), false positives are answered
     with evidence and resolved **without** a push.
  2. *Round 2* = the re-review triggered by that push. Same treatment;
     if a fix push is needed it is the last one.
  3. After round 2 is handled (threads all resolved, CI green on the final
     HEAD) the PR is **merged immediately** — no grace window, no waiting
     for a third review. If round 1 needed **no** fix push (zero findings,
     or only false positives resolved with evidence), there is no round 2:
     the PR proceeds to merge as soon as CI is green and every thread is
     resolved. If a pending review request is still listed at merge time,
     it is removed (`gh pr edit <PR#> --remove-reviewer
     copilot-pull-request-reviewer[bot]`) with the factual audit comment,
     as in the unresponsive-bot procedure.
  4. A Copilot review that lands *after* the merge (or during the final CI
     run) is still triaged — `gh api graphql … reviewThreads` after every
     merge: real finding → fixed in the next PR touching that area (or a
     small follow-up PR) and the old thread gets a reply citing the commit;
     everything is answered and resolved. No thread is ever left open.
  5. Watchers poll every **30 s** (`gh pr view <PR#> --json
     state,reviews,reviewRequests,commits`, `gh pr checks <PR#> --json
     name,bucket`, and the unresolved-thread count via the GraphQL
     `reviewThreads` query from the playbook) so a review is acted on within
     a minute of landing; the `ScheduleWakeup` fallback
     stays ≥ 1200 s. While a watcher runs the orchestrator keeps working
     (spawns, merges, dashboards, reading the next lane).
- **Stall limit**: 3 full fix cycles on the same lane → 🟥 (or 🟩 with
  `partial:` if merged) + `PushNotification` + STOP that lane; other lanes
  continue; the chain stops cleanly only when nothing else can progress
- **Merge serialisation**: one merge at a time, `git pull` on `main` after
  each, then the conflict sweep over the other open PRs (Concurrency
  policy)

## Custom conventions

Beyond /bymax-workflow:standards and the `CLAUDE.md` W0 writes:

- **Owned paths are a hard boundary** (plan §3 rule 1). A PR touching a
  path outside the lane's `Owned paths` (plus the additive exceptions its
  header lists, its own `docs/plan.md` §12 row, `docs/tasks/README.md` row
  and its own lane file) is **rejected by the orchestrator**: the fix
  sub-agent reverts the stray hunks before anything else. Verify with
  `git diff --stat origin/main..HEAD`.
- **No dependency additions inside lanes** (plan §3 rule 2) — the lockfile
  stays as W0 left it; see coordination action 4.
- **Contracts are frozen after W0** (plan §3 rule 6) — additive 1-file PRs
  only; see coordination action 3.
- **Shared files are append-only, one line per lane at the end**:
  `packages/core/src/index.ts` per-folder barrels, each package's
  `vitest.config.ts` `coverage.include`, `packages/core/package.json`
  `exports`, `apps/web/src/mocks/handlers.ts`. Root `package.json` scripts
  block belongs to W1-I (W0 wires the names first; W3 may add
  `smoke:openai`).
- **A package manifest's `scripts` block has two authors, and the
  repository-wide one wins.** A lane owns the scripts of the package it
  owns, but infrastructure work that has to chain a step into *every*
  script reaching the shared package (a build, a declaration rewrite, a
  condition flag) crosses those manifests by nature. When both sides edit
  one `scripts` block, the cross-cutting change is the base and the lane's
  change is reapplied on top of it — never the other way round, and never
  resolved by taking one side whole. A rebase that drops either half stays
  green, which is why this is a rule and not a judgement call: re-read the
  merged block and confirm both intentions survived.
- **`docs/` is in `.prettierignore`** (W0 T0.1): the planning docs are
  hand-authored (tables + 4-backtick fences wrapping nested fences) and
  `prettier --write .` has corrupted them on a sibling repo. `lint-staged`
  honours `.prettierignore`. Lane files and `docs/plan.md` are edited by
  hand only (status rows, header, completion log).
- **Lane markers the plan prescribes are allowed in code until the task
  that removes them**: the Dockerfile placeholder comment `# --- AGENT
  RUNTIME BUNDLE (added by W1-D) ---` (replaced by coordination action 1)
  and `TEMP-STUB(W1-H)` first lines (deleted in 1H.6). Otherwise shipped
  code carries no lane/task references (timeless comments).
- **Integration suites never skip silently**: `@docker`/`@db`/`@redis`
  files fail loudly when `CI=1` and the resource is missing; locally they
  print the instruction and skip. Stryker runs with those env vars unset.
- **Instance hygiene**: an implementer tears down its compose project
  (`docker compose -p agent-hangar-<instance> down -v`) and any
  `ah-ws-<instance>-*` containers before returning; the orchestrator runs
  `docker ps -a --filter label=ah.instance` + `docker compose ls` after each
  merge and removes leftovers of merged lanes.
- **Worktrees**: `isolation: "worktree"` for every file-writing sub-agent;
  the orchestrator prunes (`git worktree prune`) after every merge;
  `git switch -c <lane branch>` (never `checkout -b`); no `.gitkeep` except
  the one W0 is told to leave in `packages/core/src/runner/docker/`
  (W1-B replaces it).
- **Implementer return contract** (plan §11): `{ pr, branch, headSha,
  gates, coverage, notes, contractChangeRequests[] }` — or, when a
  precondition stops the lane, `{ pr: null, branch, headSha,
  stoppedAt: "<task id>", reason }`. The orchestrator verifies both via
  `gh pr view` / `git rev-list --count origin/main..<branch>`.
- **Unattended-session hardening** (checked at launch): `gh auth status`
  fresh; Claude login fresh; `CLAUDE_CODE_RETRY_WATCHDOG` set in the
  orchestrator's environment; permission mode lets sub-agents run `pnpm`,
  `docker`, `gh`, `git` without prompts (this repo has no
  `.claude/settings.json` allowlist — the session must run in a mode that
  does not prompt, or the first unapproved call stalls every lane).
