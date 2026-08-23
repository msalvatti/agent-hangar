# Wave 4 — W4-B Stryker 10 mutation testing on `packages/agent-runtime`

| | |
|---|---|
| **Lane** | W4-B (single agent; last wave, non-blocking; no Docker needed). **Runs alone and first of the two** — never beside W4-A: it is the slow, timeout-heavy lane, and `Timeout` is wall-clock, so a shared machine changes the score (plan §9) |
| **Status** | 🟩 Done (2026-08-23) — `packages/agent-runtime` scores **100.00** and the configuration breaks below it. Held on a local branch at the operator's instruction; nothing was pushed. See the completion log at the foot of this file and [plan §9](../plan.md) |
| **Progress** | 4/4 tasks |
| **Branch** | `agent/work` (local only — the operator asked for no push; the `feat/w4b-stryker-runtime` branch this file named was never created) |
| **Owned paths** | `packages/agent-runtime/stryker.config.mjs`, `packages/agent-runtime/package.json` (scripts block only), tests and test-only helpers under `packages/agent-runtime/**`; source files under `packages/agent-runtime/src/**` **only** to remove an equivalent mutant by simplifying to the value that serves (no behaviour change); `packages/agent-runtime/vitest.stryker.config.ts`. `.gitignore` already lists `.stryker-tmp/` and `reports/` on `main`, so neither lane touches it and the two share no file at all |
| **Depends on** | W3-A merged (code stable; mutants are meaningful only on stable code). W3-A being unmerged is **not** why this lane is idle — the deferral above is |
| **Unblocks** | W4-C follow-up — the README badge and section landed with this work (2026-08-23); what remains of W4-C is the `mutation` CI job |
| **Source** | [docs/plan.md §9](../plan.md) (table row W4-B, rules) · spec [06 §5](../spec/06-testing.md) · [01 §5 S7](../spec/01-overview.md) |
| **Notes** | may slip — documented in README "Known gaps" (plan §9: the product is complete without it) |
| **Last updated** | 2026-08-23 |

## Context

`packages/agent-runtime` is the code that runs **inside** every workspace container: the tool implementations (`run_shell`, `read_file`, `write_file`, `list_dir`) with path confinement, output truncation, timeouts and environment scrubbing; the step loop with limits and cancellation; and `prepare` (clone/checkout/`expectedHeadSha` check). A surviving mutant here is a sandbox-escape, a leaked secret in a child environment, or an unbounded loop that tests did not notice. This lane adds Stryker 10 to the package, measures the baseline on `src/tools/**`, `src/loop.ts` and `src/prepare.ts`, then strengthens the tests until the score clears `break: 80` with 90 as the target, documenting every equivalent mutant. Reports are gitignored; the numbers live in this file's completion log and the PR.

Measured on `main` (2026-08-22, 14-core / 36 GB laptop, `concurrency: 2`): the `mutate` list resolves
to **9 files and 944 mutants**, and `src/tools/run-shell.ts` alone — 109 of them — took **3 min 51 s**
(~2.1 s per mutant, 3.78 covering tests each), scoring 83.33 % with **24 of the 109 verdicts being
`Timeout`**. Tool tests touch a real temp filesystem and `run_shell` spawns processes, so a mutant
here costs roughly forty times a pure-function mutant in `packages/core`. **A full run is therefore
expected to take 20–40 minutes, not the ten minutes this lane originally assumed** — plan for it,
run it detached (`nohup … & disown`) so the harness cannot kill the job at the end of a turn, and do
**not** shrink the `mutate` list. Peak resident memory was +662 MB over the idle baseline (~330 MB
per test-runner process): memory is not the constraint here, wall-clock and `Timeout` stability are.

## Rules of this lane

1. **Dependencies are already installed** (W0 T0.2): `@stryker-mutator/core` and `@stryker-mutator/vitest-runner`, both 10.x, **same version** — verify with `pnpm ls -r --depth 0 | grep stryker`; if they differ, stop and report (no dependency changes in lanes). They live in the **root** `node_modules` only, which is why the config has to name the runner plugin explicitly — rule 10.
2. **Kill survivors by strengthening tests** — assert the behaviour the mutated line is responsible for (exact outputs, `toStrictEqual`, `toHaveBeenNthCalledWith`, boundaries asserted **at** the limit and one step beside it; for confinement: the escaping path is rejected **and** the legitimate sibling path is accepted; for scrubbing: the child env lacks the secret names **and** keeps `GIT_ASKPASS`), never by asserting that a line exists.
3. **Equivalent mutants:** first try to change the code to the value that serves (remove a guard that is equivalent to no guard; `Math.max` instead of an `if`), keeping behaviour and 100 % coverage. Only if the mutant is truly equivalent and the code cannot be simplified: document it in the PR as `file:line — mutator — why equivalent`. **No `// Stryker disable`** without a one-line justification that the orchestrator accepts in the PR; disables are per mutator per line, never blanket.
4. **`incremental: false` for the first full run and for every run that produces a number you report.** Never mix a scoped run (`--mutate <files>`) with `incremental: true`. For scoped iteration use `--incrementalFile <scratch-path>` and read the **per-file table**, not the `All files` line.
5. **`Timeout` counts as killed, and here it is a large slice of the score.** Measured: `run-shell.ts` produced **24 timeouts in 109 mutants — 22 % of its verdicts**. Tool tests legitimately include a `run_shell` timeout path; every other `Timeout` verdict (loop, confinement, truncation) is an artefact to verify by hand — do not let timeouts inflate the number you report. Two consequences: report the timeout count next to every score, and prefer a cheap wrong-answer assertion placed first in the file so the kill stops costing a full timeout window.
6. **`cleanTempDir: 'always'`** — a leftover `.stryker-tmp/` sandbox poisons later runs; and the test suite itself must use unique `os.tmpdir()` directories per test (never paths relative to the package) because Stryker runs the suite from a sandbox copy with two workers in parallel.
7. This package has no `@db`/`@redis`/`@docker` suites and its dry run passes as-is (measured: 248 tests, 27 s). Still create a `vitest.stryker.config.ts` if any test needs the network, Docker, or a path relative to the package — the sandbox moves every file, so a test that climbs `'..'` from `import.meta.url` to reach repository files breaks exactly as `packages/core/src/config/**` does (that family aborts W4-A's run outright). `src/cli.test.ts` uses `import.meta.url`: check what it resolves through before the first run. The esbuild bundle (`dist/cli.js`) is never mutated or required by tests under Stryker, and `ignorePatterns` keeps `dist/` out of the sandbox (rule 11).
8. Only one Stryker tree runs at a time on the machine, and the same lock covers the full gate run (`pnpm test -- --coverage` reaches `apps/web`, 174 jsdom suites). The binding reason is **not** memory — see rule 12 — it is that `Timeout` is wall-clock, and with 22 % of this package's verdicts being timeouts a busy machine does not merely slow the run, it changes the score. This lane runs **alone**; W4-A goes before or after it, never beside it. `concurrency: 2` is the cap and never rises.
9. No `enum`, no suppression comments (`eslint-disable`, `@ts-*`, `v8 ignore`), JSDoc on exports + file headers (including in `stryker.config.mjs`), test header + `it()` comments, English, Conventional Commits, no AI-attribution trailers; canaries from `@agent-hangar/core/testing` for any secret-shaped value (e.g. when asserting env scrubbing). Branch `feat/w4b-stryker-runtime`. One PR at the end (T4B.4).
10. **`plugins: ['@stryker-mutator/vitest-runner']` is mandatory in the config.** Stryker discovers plugins by globbing `node_modules/@stryker-mutator/*` **relative to the cwd**; under pnpm the packages exist only in the root `node_modules`, which the glob never reaches, so a config without it dies with `Cannot find TestRunner plugin "vitest". In fact, no TestRunner plugins were loaded.` The `import` itself resolves fine by walking up — only the discovery glob needed the hint.
11. **`ignorePatterns: ['dist', 'coverage', 'reports', '.stryker-tmp']`** — otherwise the 6.5 MB esbuild output is copied into every sandbox.
12. **The package's `maxWorkers: 3` does not apply inside a Stryker worker.** For Vitest ≥ 4.1 the runner builds its context with `pool: 'threads'`, `maxWorkers: 1`, `maxConcurrency: 1` and coverage disabled, so peak memory is `concurrency × one worker`. Do not "compensate" by raising `concurrency`: memory is not what limits this lane (rule 8).

## Reference docs

- [docs/plan.md](../plan.md) § "9. Wave 4" (table + rules), § "12. Status dashboard"
- [spec 06 — Testing](../spec/06-testing.md) § "5. Mutation testing (Stryker)" (scope table, config notes), § "2. Unit tests" (`packages/agent-runtime` bullets — the behaviours the tests must pin)
- [spec 03 — Interfaces](../spec/03-interfaces.md) § "3. Agent protocol" (limits, cancellation, tool semantics)
- [spec 01 — Overview](../spec/01-overview.md) § "5. Success criteria" S7, § "8. Risks" R3, R4
- Stryker 10 docs: configuration, vitest-runner options, incremental, reporters, mutant states

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 4B.1 | `stryker.config.mjs`, scripts, gitignore; first full run; baseline recorded | 📋 | P1 | S | — |
| 4B.2 | Triage survivors by module; kill by strengthening tests; simplify equivalent code | 📋 | P1 | L | 4B.1 |
| 4B.3 | Reach `break: 80` (target 90) on a full run; keep 100 % coverage; equivalent-mutant ledger | 📋 | P1 | M | 4B.2 |
| 4B.4 | Close-out: gates, code review, dashboard, PR with scores | 📋 | P1 | S | 4B.1–4B.3 |

---

## Task 4B.1 — `stryker.config.mjs`, scripts, gitignore; first full run; baseline recorded

**Status:** 📋 ToDo · **Priority:** P1 · **Size:** S · **Depends on:** —

**Description.** Add the Stryker configuration for `packages/agent-runtime` exactly as plan §9 specifies, wire `pnpm --filter @agent-hangar/agent-runtime test:mutation`, make sure temp and report directories are gitignored, run the **first full, non-incremental** pass, and record the baseline (score, counts, duration, per-module table) in this file's completion log.

**Acceptance criteria**
- [ ] `packages/agent-runtime/stryker.config.mjs` (ESM, JSDoc typed `@type {import('@stryker-mutator/api/core').PartialStrykerOptions}`, file header) with: `testRunner: 'vitest'`, **`plugins: ['@stryker-mutator/vitest-runner']`** (rule 10 — without it the run cannot start), **`ignorePatterns: ['dist','coverage','reports','.stryker-tmp']`** (rule 11), `vitest: { configFile: 'vitest.config.ts' }`, `mutate: ['src/tools/**','src/loop.ts','src/prepare.ts']` (plus `'!src/**/*.test.ts'`, `'!src/**/types.ts'`, `'!src/**/index.ts'`), `thresholds: { high: 90, low: 80, break: 80 }`, `concurrency: 2`, `reporters: ['html','clear-text','progress','json']`, `htmlReporter: { fileName: 'reports/mutation/index.html' }`, `jsonReporter: { fileName: 'reports/mutation/mutation.json' }`, `incremental: false`, `cleanTempDir: 'always'`, **`timeoutMS: 5000`** (the Stryker default — **not** the 20000 this lane originally specified: the effective budget is `timeoutMS + timeoutFactor × netTime`, and with 22 % of verdicts timing out, 20 s would add roughly six minutes of pure waiting per full run for no extra information), `tempDirName: '.stryker-tmp'`, `coverageAnalysis: 'perTest'`
- [ ] A comment block in the config states: never mix a scoped `--mutate` run with `incremental: true`; for scoped iteration use `--incrementalFile .stryker-tmp/inc-scoped.json`; reported numbers always come from a full non-incremental run
- [ ] `packages/agent-runtime/package.json` scripts: `test:mutation` → `stryker run`; `test:mutation:scoped` → `stryker run --incrementalFile .stryker-tmp/inc-scoped.json --mutate`. The root `test:mutation` already serialises workspaces (`pnpm --recursive --if-present --sequential …`) — verify, request nothing, edit nothing at the root
- [ ] `.gitignore` already contains `.stryker-tmp/` and `reports/` on `main` — verify, change nothing
- [ ] Stryker core/runner versions verified identical
- [ ] Test-suite hygiene verified before the run: every test that touches the filesystem uses `fs.mkdtemp(path.join(os.tmpdir(), 'ah-rt-'))` and removes it in `afterEach`; no test depends on `dist/` or on a relative path into the package; `prepare` tests create their bare repos under the temp dir — fix any violation (tests only) before measuring
- [ ] Dry run first (`--dryRunOnly`) over the **whole** `mutate` list: it must report the 9 files / ~944 mutants of the measured baseline and `Initial test run succeeded` (measured: 248 tests, 27 s)
- [ ] First full run completes without instrumenter errors, launched detached so a turn boundary cannot kill it; duration recorded and compared against the measured 20–40 min expectation; baseline in the completion log: overall score, `killed / survived / timeout / noCoverage / compileError / ignored`, duration, per-module table (`tools/run-shell`, `tools/read-file`, `tools/write-file`, `tools/list-dir`, shared tool helpers if any, `loop`, `prepare`) with score and survivor count; `reports/mutation/` NOT committed

**Files to create/modify**
`packages/agent-runtime/stryker.config.mjs`, `packages/agent-runtime/package.json` (scripts), `packages/agent-runtime/src/**/*.test.ts` (temp-dir and sandbox hygiene only), `packages/agent-runtime/vitest.stryker.config.ts` (only if rule 7 requires it). `.gitignore` needs no change.

**Agent prompt**

````
You are a senior TypeScript engineer specialised in test quality working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Vitest 4 (100 % thresholds) · Stryker 10 (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`, same 10.x, installed in W0) · esbuild bundle for the container (not under test here). packages/agent-runtime uses only node stdlib (`node:child_process`, `node:fs`, `node:path`) plus zod and @agent-hangar/core.
Branch feat/w4b-stryker-runtime (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W4-B (Stryker — packages/agent-runtime) — Task 4B.1 of 4 (FIRST)

PRECONDITIONS
- W3-A merged: packages/agent-runtime is stable and at 100 % coverage on src/**.
- Stryker packages are installed at the root (W0 T0.2). No dependency may be added or changed.
- Nothing else runs Stryker on this machine right now (W4-A coordinates through the orchestrator).

REQUIRED READING (only these):
- docs/plan.md § "9. Wave 4" (table row W4-B + rules)
- docs/spec/06-testing.md § "5. Mutation testing (Stryker)" and § "2. Unit tests" (packages/agent-runtime bullets)
- docs/tasks/wave-4b-stryker-runtime.md § "Rules of this lane" (this file)
- packages/agent-runtime/vitest.config.ts, packages/agent-runtime/package.json, packages/agent-runtime/src/**/*.test.ts (skim for temp-dir usage)
- Stryker 10 documentation pages: "Configuration", "Vitest runner", "Incremental", "Reporters"

TASK
Configure Stryker 10 for packages/agent-runtime exactly as the plan specifies, make the suite sandbox-safe, run the first full non-incremental pass, and record the baseline in this task file. Do not fix survivors yet.

DELIVERABLES

1. `packages/agent-runtime/stryker.config.mjs` — file header + `/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */ export default { … }` with exactly: `testRunner: 'vitest'`, `plugins: ['@stryker-mutator/vitest-runner']`, `ignorePatterns: ['dist', 'coverage', 'reports', '.stryker-tmp']`, `vitest: { configFile: 'vitest.config.ts' }`, `mutate: ['src/tools/**', 'src/loop.ts', 'src/prepare.ts', '!src/**/*.test.ts', '!src/**/types.ts', '!src/**/index.ts']`, `thresholds: { high: 90, low: 80, break: 80 }`, `concurrency: 2`, `coverageAnalysis: 'perTest'`, `reporters: ['html', 'clear-text', 'progress', 'json']`, `htmlReporter: { fileName: 'reports/mutation/index.html' }`, `jsonReporter: { fileName: 'reports/mutation/mutation.json' }`, `incremental: false`, `cleanTempDir: 'always'`, `timeoutMS: 5000`, `tempDirName: '.stryker-tmp'`. Comment block: "Never combine a scoped `--mutate` run with `incremental: true` — cached verdicts for untouched files would be mixed into the report. For scoped iteration use `--incrementalFile .stryker-tmp/inc-scoped.json`. Reported scores always come from a full run with incremental off." Leave `ignoreStatic` at its default.
2. Scripts in packages/agent-runtime/package.json: `"test:mutation": "stryker run"`, `"test:mutation:scoped": "stryker run --incrementalFile .stryker-tmp/inc-scoped.json --mutate"` (one comma-separated `--mutate` value; repeated flags do not accumulate, measured: passing two of them mutated only the last one's files). The root `test:mutation` already runs `pnpm --recursive --if-present --sequential`, so workspaces are serialised — verify, request nothing, edit nothing at the root.
3. `.gitignore`: `.stryker-tmp/` and `reports/` are already there on `main`. Verify and leave the file alone — W4-A needs no change either, so there is no line for the two lanes to fight over and nothing to resolve on rebase.
4. Version parity: `pnpm ls -r --depth 0 2>/dev/null | grep -i stryker` — both 10.x and identical; else stop and report.
5. Sandbox-safety pass over the tests (tests only, no behaviour change): every filesystem test uses `await fs.mkdtemp(path.join(os.tmpdir(), 'ah-rt-'))` + `afterEach` removal (`fs.rm(dir, { recursive: true, force: true })`); `prepare` tests build the bare repo (`git init --bare`) under that temp dir; no test reads `dist/` or `process.cwd()`-relative fixtures (Stryker runs from `.stryker-tmp/sandbox-*/`); `run_shell` tests with timeouts use short timeouts (≤ 2 s) so mutants in the timeout path die by wrong answer, not by exhaustion. Also check `src/cli.test.ts`, the one test file here that uses `import.meta.url`: if it resolves anything outside the package by climbing `'..'`, it will break in `.stryker-tmp/sandbox-N/` the way `packages/core/src/config/**` does — exclude it through a `vitest.stryker.config.ts` or anchor the path. Commit these as `test(agent-runtime): make the suite sandbox-safe for mutation runs` if anything changed.
6. First full run, detached so a turn boundary cannot kill it:
   `LOG=/tmp/w4b-mutation.log; NODE_OPTIONS=--max-old-space-size=3072 nohup pnpm --filter @agent-hangar/agent-runtime test:mutation > "$LOG" 2>&1 < /dev/null & disown`
   then poll the log across turns. Expect 9 files / ~944 mutants and **20–40 minutes**, not ten: measured on `main`, `src/tools/run-shell.ts` alone took 3 min 51 s for 109 mutants. Nothing else may run on the machine meanwhile — `Timeout` is wall-clock and 22 % of this package's verdicts are timeouts. If the instrumenter aborts on a source construct (e.g. inline template-literal type), make the minimal source change that keeps the type check and note it. Record the duration; do not reduce `mutate` or raise concurrency. The verdict is in the per-file table at the end, never in a `WARN ChildProcessProxy … SIGKILL` line mid-log — Stryker replaces a killed worker and carries on.
7. Record the baseline in this file's completion log: `score`, `killed/survived/timeout/noCoverage/compileError/ignored`, duration, per-module table (file · mutants · killed · survived · timeout · score) read from reports/mutation/mutation.json (a short `node -e` over the JSON; do not commit the reports).

Constraints:
- Follow /bymax-workflow:standards (JSDoc + header in the config, English, no suppression comments, it() comments on any test you touch).
- Do not add `// Stryker disable`; do not change source beyond an instrumenter blocker; do not change vitest.config.ts thresholds or includes.

Verification:
- The vitest dry run under Stryker passes and reports "N mutant(s) to test" for tools/**, loop.ts and prepare.ts only
- `git status --porcelain` after the run shows no `reports/` or `.stryker-tmp/` files
- `pnpm lint && pnpm typecheck && pnpm --filter @agent-hangar/agent-runtime test -- --coverage` — green, 100 %

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-4b-stryker-runtime.md (task index row and task block)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/4 tasks`)
4. Append a completion log entry at the end of the file: `- 4B.1 ✅ <YYYY-MM-DD> — baseline <score> % (<killed>/<total>, <survived> survived, <timeout> timeout) in <mm:ss>` followed by the indented per-module table
5. Commit: `test(agent-runtime): add Stryker 10 configuration and record the baseline mutation score`
````

---

## Task 4B.2 — Triage survivors by module; kill by strengthening tests; simplify equivalent code

**Status:** 📋 ToDo · **Priority:** P1 · **Size:** L · **Depends on:** 4B.1

**Description.** Work through the survivors in defect-risk order (path confinement → env scrubbing → truncation/timeouts → loop limits and cancellation → prepare), reproduce each mutant's effect by hand before writing a test, and kill it with an assertion on observable behaviour. Where a mutant is equivalent, prefer simplifying the code to the value that serves (same behaviour, coverage stays 100 %). Keep a ledger of what remains.

**Acceptance criteria**
- [ ] Every `Survived` and `NoCoverage` mutant from the baseline has one of three outcomes in the ledger: **killed** (test name), **removed** (code simplified; commit), or **equivalent** (file:line, mutator, one-line reason)
- [ ] Confinement tests assert both sides of each boundary: `../` escape, absolute path, symlink pointing outside, and `..` inside a legitimate name (`foo..bar`) **accepted**; `/workspace` itself accepted; error messages pinned verbatim (they are protocol output the worker and UI show)
- [ ] Scrubbing tests assert the child env **strictly** (`toStrictEqual` of the allow-listed keys) — absence of `GITHUB_TOKEN`/`OPENAI_API_KEY` (use canaries from `@agent-hangar/core/testing` as the values that must not appear) and presence of `GIT_ASKPASS`, `HOME`, `PATH`
- [ ] Truncation tests assert exactly at the byte/line cap and one beyond (notice text pinned verbatim); timeout tests assert exit/signal and the emitted event with a ≤ 2 s timeout; `maxSteps` asserted at the limit and at limit+1 with `stoppedBy: 'limit'`; cancellation asserts `turn.cancelled` **and** that no further tool executes
- [ ] Every `Timeout` in non-timeout code verified by hand and either killed by a behavioural assertion placed first in its file or documented
- [ ] No `// Stryker disable` without a one-line justification in the comment and the ledger; no other suppression comments
- [ ] After each module: scoped run per-file table confirms kills; `pnpm --filter @agent-hangar/agent-runtime test -- --coverage` still 100 %; each behaviour-preserving simplification is its own commit naming the removed mutant

**Files to modify**
`packages/agent-runtime/src/**/*.test.ts` (strengthened/added), `packages/agent-runtime/src/{tools/**,loop.ts,prepare.ts}` only for behaviour-preserving simplifications.

**Agent prompt**

````
You are a senior TypeScript engineer specialised in test quality and sandboxing working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: TypeScript ~6.0.3 strict · Node 24 (`node:child_process`, `node:fs`, `node:path`) · Vitest 4 · Stryker 10 with vitest-runner · FakeAgentModelProvider from @agent-hangar/core/testing for the loop. Modules under mutation: src/tools/** (run_shell, read_file, write_file, list_dir: confinement, truncation, timeout, env scrubbing), src/loop.ts (step loop, limits, cancellation, event ordering), src/prepare.ts (clone/checkout, expectedHeadSha warning).
Branch feat/w4b-stryker-runtime (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W4-B — Task 4B.2 of 4 (MIDDLE)

PRECONDITIONS
- Task 4B.1 done: config exists, baseline recorded, reports/mutation/mutation.json from the full run is on disk (regenerate with a full run if missing).

REQUIRED READING (only these):
- docs/tasks/wave-4b-stryker-runtime.md § "Rules of this lane" and the 4B.1 baseline table
- docs/spec/06-testing.md § "2. Unit tests" (packages/agent-runtime bullets)
- docs/spec/03-interfaces.md § "3. Agent protocol" (limits, cancellation, tool result shapes)
- reports/mutation/index.html (per file) or mutation.json — the survivor list

TASK
Kill surviving mutants by strengthening tests so they assert observable behaviour on both sides of every boundary, simplify code where a mutant is equivalent and the value that serves is obvious, and keep a precise ledger of the remainder.

DELIVERABLES

1. Triage order: tools confinement (read/write/list/shell `cwd`) → env scrubbing → truncation + timeouts → loop (maxSteps, maxTurnMs, no-tool-call stop, cancellation, event ordering, tool_result appending) → prepare (clone, workBranch checkout, expectedHeadSha mismatch warning, failure mapping). For each survivor: open it in the HTML report, reproduce by hand, decide kill / simplify / equivalent.
2. Kill patterns: both sides of each boundary (reject `../x`, `/etc/passwd`, symlink-out; accept `a/../b` resolving inside, `foo..bar`, the root itself); pin error/notice strings verbatim with `toBe` (they are protocol output); `toStrictEqual` on the scrubbed env object (list the exact keys) with canary values proving absence; truncation exactly at the cap and cap+1 (`toHaveLength`, notice present/absent); timeout path with a ≤ 2 s timeout asserting the result shape (exit code / signal / `timedOut: true`) — the cheap assertion first in the file; loop: `maxSteps` at limit and limit+1 (`stoppedBy: 'limit'`), event order asserted as an exact array of `type`s, cancellation asserts `turn.cancelled` and that the scripted second tool never ran (`runner`/`fs` spy not called); prepare: `toHaveBeenNthCalledWith` on the git argv sequence, sha mismatch emits the exact warning once.
3. Simplify when equivalent (behaviour-preserving, covered, own commit `refactor(agent-runtime): <what> (removes equivalent mutant <file>:<line>)`): redundant guards before no-op operations, identical ternary branches, `<=`/`<` at impossible boundaries → `Math.max/min` forms.
4. Ledger (working notes → completion log): per module `killed N (tests: …)`, `removed N (commits: …)`, `equivalent N (file:line — mutator — reason)`. Reasons must be specific.
5. After each module: `pnpm --filter @agent-hangar/agent-runtime test:mutation:scoped '<comma-separated files>'` — read the per-file table; then coverage 100 %, `pnpm lint && pnpm typecheck` green; commit `test(agent-runtime): kill <module> mutants by asserting <behaviour>`.
6. `Timeout` verdicts outside the real timeout path: verify by hand; add a cheap behavioural assertion first so the kill is by wrong answer.
7. `// Stryker disable next-line <Mutator>: <reason>` only per mutator per line with a reason naming what the mutation would change and why no test can observe it; list each in the ledger.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression comments other than the justified Stryker directive, it() comments).
- No behaviour changes; no new dependencies; do not touch files outside packages/agent-runtime; tests stay sandbox-safe (temp dirs, no `dist/`).
- Do not use `incremental: true` anywhere in this task.

Verification:
- Per-module scoped runs show the targeted survivors as Killed in the per-file table
- `pnpm --filter @agent-hangar/agent-runtime test -- --coverage` — 100/100/100/100
- `grep -rn "Stryker disable" packages/agent-runtime/src | wc -l` equals the number of justified ledger entries

Completion Protocol: update status/AC/progress in docs/tasks/wave-4b-stryker-runtime.md; append `- 4B.2 ✅ <date> — survivors: killed <k>, removed <r>, equivalent <e>, disables <d>` with the per-module ledger indented below; commits as described per module.
````

---

## Task 4B.3 — Reach `break: 80` (target 90) on a full run; keep 100 % coverage; equivalent-mutant ledger

**Status:** 📋 ToDo · **Priority:** P1 · **Size:** M · **Depends on:** 4B.2

**Description.** Run the full non-incremental pass again, confirm the score clears `break: 80` and push toward 90 with a second time-boxed iteration, verify coverage and the esbuild bundle build still hold, and produce the final equivalent-mutant ledger and per-module table for the PR. If 90 is not reached, record where the score stands and why.

**Acceptance criteria**
- [ ] Full run (`incremental: false`) exits 0 with score ≥ 80 (target ≥ 90); final numbers in the completion log: score, counts, duration, per-module table; if < 90, a paragraph naming the remaining survivor classes per module and the next concrete step
- [ ] Second iteration done within a 1 h time box using the 4B.2 methods; every new `Stryker disable` justified and listed
- [ ] `pnpm --filter @agent-hangar/agent-runtime test -- --coverage` 100/100/100/100; `pnpm lint && pnpm typecheck` green; `pnpm --filter @agent-hangar/agent-runtime build` (esbuild bundle) succeeds and `node dist/cli.js --version` prints the version — simplifications did not change the bundle's behaviour
- [ ] Final ledger for the PR: `File:line · Mutator · Verdict (equivalent / disabled) · Reason`, plus the simplification commits
- [ ] Runtime statement: duration of the final full run against the measured 20–40 min expectation (if outside it: figure and reason — process-spawning tests, timeout share — without shrinking `mutate`), the `Timeout` count alongside the score, and confirmation that no other Stryker tree or full gate run shared the machine
- [ ] `reports/mutation/` and `.stryker-tmp/` absent from `git status`

**Files to modify**
`packages/agent-runtime/src/**/*.test.ts` (second iteration), `packages/agent-runtime/src/**` only for behaviour-preserving simplifications.

**Agent prompt**

````
You are a senior TypeScript engineer specialised in test quality working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: TypeScript ~6.0.3 strict · Node 24 · Vitest 4 · Stryker 10 with vitest-runner (`break: 80`, target 90) · esbuild bundle `dist/cli.js`.
Branch feat/w4b-stryker-runtime (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W4-B — Task 4B.3 of 4 (MIDDLE)

PRECONDITIONS
- Task 4B.2 done: survivors triaged, ledger in the completion log.

REQUIRED READING (only these):
- docs/tasks/wave-4b-stryker-runtime.md (4B.1 baseline, 4B.2 ledger, Rules)
- packages/agent-runtime/stryker.config.mjs, packages/agent-runtime/esbuild.config.mjs

TASK
Confirm the threshold on a full run, iterate once more toward 90 within a time box, verify coverage and the bundle still hold, and produce the final ledger and runtime statement for the PR.

DELIVERABLES

1. Full run: `time pnpm --filter @agent-hangar/agent-runtime test:mutation` — must exit 0 (score ≥ 80). Extract score, counts and per-module table from reports/mutation/mutation.json. Record them.
2. Second iteration (≤ 1 h): remaining survivors by module; 4B.2 kill/simplify/equivalent decisions; scoped runs per module with the per-file table as the check; commit per module.
3. Final full run (incremental off) and record the final numbers; if < 90, a short paragraph per module naming the survivor classes and the next step (e.g. "run-shell: 4 mutants in the stderr/stdout interleaving order — needs a deterministic child script fixture emitting to both streams in a known order").
4. Verify nothing regressed: `pnpm --filter @agent-hangar/agent-runtime test -- --coverage` (100 %), `pnpm lint && pnpm typecheck`, `pnpm --filter @agent-hangar/agent-runtime build && node packages/agent-runtime/dist/cli.js --version`.
5. Final ledger for the PR body (Markdown table): `File:line · Mutator · Verdict · Reason`; simplification commits with hashes; count of `Stryker disable` directives.
6. Runtime statement: duration of the final full run against the 20–40 min expectation measured on `main`, with the reason if outside it, the `Timeout` count next to the score, and a line confirming the machine was otherwise idle for that run.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression comments except justified per-line Stryker directives, it() comments).
- No behaviour change; no dependency change; `mutate` list unchanged; `concurrency` stays 2; `incremental` stays false.

Verification:
- Final full run exit code 0, score ≥ 80 (state the number)
- `git status --porcelain | grep -E "reports/|\.stryker-tmp/"` — empty
- Bundle builds and `--version` works; coverage 100 %

Completion Protocol: update status/AC/progress in docs/tasks/wave-4b-stryker-runtime.md; append `- 4B.3 ✅ <date> — final <score> % (<killed>/<total>) in <mm:ss>; equivalent <e>, disables <d>` with the final per-module table indented; commit `test(agent-runtime): raise mutation score to <score> % and document equivalent mutants`.
````

---

## Task 4B.4 — Close-out: gates, code review, dashboard, PR with scores

**Status:** 📋 ToDo · **Priority:** P1 · **Size:** S · **Depends on:** 4B.1–4B.3

**Description.** Run the full gate set, run the code review to zero findings, update the plan dashboard and tasks index, and open the PR whose body carries the baseline → final scores, the per-module table, the equivalent-mutant ledger, the runtime statement and the note that the CI `mutation` job is a separate follow-up (W4-C) opened by the orchestrator once W4-A also passes.

**Acceptance criteria**
- [ ] `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test -- --coverage` green (100 % everywhere); `pnpm --filter @agent-hangar/agent-runtime test:mutation` exit 0 on the final commit; bundle builds
- [ ] `/bymax-quality:code-review` on the branch with zero open findings (every `Stryker disable` reviewed as a finding with its justification; no other suppression)
- [ ] `docs/plan.md` §12 row `W4-B` → 🟨 with branch + PR number and Notes `score <final> %`; `docs/tasks/README.md` W4-B row → 🟨; this file's header Status → 🟨 PR open, Progress 4/4; README not edited (W4-C / orchestrator updates "Known gaps" and the badge)
- [ ] PR opened with `gh pr create`; body: summary, config summary, baseline → final table, per-module table, equivalent-mutant ledger, simplifications, runtime statement, "CI job: follow-up W4-C (orchestrator) once W4-A passes", gate results
- [ ] Returned to the orchestrator: `{ pr, branch, headSha, gates, coverage, contractChangeRequests }` (`coverage` includes `mutationScore`)

**Files to modify**
`docs/plan.md` (§12 W4-B row), `docs/tasks/README.md` (W4-B row), `docs/tasks/wave-4b-stryker-runtime.md` (header, log).

**Agent prompt**

````
You are a senior engineer closing out the agent-runtime mutation-testing lane of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 · Node 24 · Vitest 4 · Stryker 10 · esbuild · GitHub CLI.
Branch feat/w4b-stryker-runtime (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W4-B — Task 4B.4 of 4 (LAST)

PRECONDITIONS
- Tasks 4B.1–4B.3 done and committed; the final full run exited 0 with the score recorded in this file.

REQUIRED READING (only these):
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard", § "9. Wave 4" (last paragraph — the W4-C follow-up)
- docs/tasks/wave-4b-stryker-runtime.md completion log (your numbers and ledger)

TASK
Run all gates and the code review to zero findings, update the dashboards, and open the PR with scores and the ledger. Do not add the CI job — that is the orchestrator's W4-C follow-up.

DELIVERABLES

1. Gates: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test -- --coverage` (100 % in every package); `pnpm --filter @agent-hangar/agent-runtime test:mutation` exit 0 on HEAD (re-run fully if the last code change was after the final run, and update the numbers); `pnpm --filter @agent-hangar/agent-runtime build`.
2. Rebase on latest main (W4-A may have merged its dashboard rows — keep them; the two lanes touch no file in common); re-run the mutation pass if main changed any file under the `mutate` globs.
3. `/bymax-quality:code-review` on `main..HEAD`; fix every finding (no suppressions; every `Stryker disable` must carry its per-line justification or be replaced by a better test); re-run gates; repeat on every new commit before pushing.
4. Dashboards: docs/plan.md §12 row W4-B → `🟨 PR open` with `feat/w4b-stryker-runtime` / PR number and Notes `mutation score <final> % (break 80, target 90)`; docs/tasks/README.md W4-B → 🟨; this file header Status → 🟨, Progress 4/4. Do not edit README.md.
5. Push; `gh pr create --base main --title "test(agent-runtime): Stryker 10 mutation testing on packages/agent-runtime (W4-B)" --body-file <generated>`. Body sections: Summary · Configuration · Scores (baseline → final; counts; duration) · Per-module table · Equivalent-mutant ledger · Code simplifications (commits) · `Stryker disable` directives (count + list) · Runtime statement · Follow-up: "CI `mutation` job (PR-scoped incremental with `--incremental` and a cached `incrementalFile`, nightly full run on schedule) and README badge/section are added by the orchestrator in W4-C once W4-A also passes" · Gates.
6. Return: `{ pr, branch, headSha, gates: { lint, format, typecheck, unit, mutation, build }, coverage: { agentRuntime: '100/100/100/100', mutationScore: <n> }, contractChangeRequests: [] }`.

Constraints:
- English; Conventional Commits; no AI attribution anywhere. Do not wait for CI; do not merge.
- Owned paths only (see header) plus the two dashboard rows.

Verification:
- `gh pr view --json number,headRefOid` — PR exists
- `git diff --name-only main..HEAD | grep -vE '^(packages/agent-runtime/|\.gitignore$|docs/plan\.md$|docs/tasks/README\.md$|docs/tasks/wave-4b-stryker-runtime\.md$)'` — empty
- `git log --format=%B main..HEAD | grep -i "co-authored-by\|generated with"` — empty

Completion Protocol: update status/AC/progress in docs/tasks/wave-4b-stryker-runtime.md (header Status → 🟨 PR open); append `- 4B.4 ✅ <date> — PR #<n> opened, score <final> %`; commit `chore: close out W4-B mutation lane` before opening the PR (then `docs(plan): record W4-B PR number`).
````

---

## Follow-up owned by the orchestrator — W4-C (not a task of this lane)

Opened **only when both W4-A and W4-B have passed** (`break: 80` on a full run, PRs merged): a third, tiny PR that adds the `mutation` CI job to `.github/workflows/ci.yml` — PR-scoped incremental (`stryker run --incremental` with `incrementalFile` restored/saved via the Actions cache keyed by package + branch; invalidated when the base branch changes) and a nightly **full** run on `schedule` with `incremental: false` and `reports/mutation/` uploaded as an artifact; plus the README mutation badge/section and the removal of the W4 rows from README "Known gaps". Until W4-C merges, `pnpm test:mutation` is a local-only gate and README "Known gaps" says so.

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)

- 4B.1 ✅ 2026-08-23 — `stryker.config.mjs` added; the `mutate` list is the whole of `src/**` rather than `src/tools/**`, minus the entry point, the barrel and the test doubles.
- 4B.2 ✅ 2026-08-23 — survivors triaged and killed by strengthening tests; the shapes are catalogued in plan §9.
- 4B.3 ✅ 2026-08-23 — **100.00**, not the 80 this file asked for: `break` is 100 in every scope.
- 4B.4 ✅ 2026-08-23 — gates green; dashboards updated in plan §9 and §12. No pull request: the operator asked for the work to stay local.
