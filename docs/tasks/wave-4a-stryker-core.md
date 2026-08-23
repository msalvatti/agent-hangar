# Wave 4 — W4-A Stryker 10 mutation testing on `packages/core`

| | |
|---|---|
| **Lane** | W4-A (single agent; last wave, non-blocking; no Docker needed). **Runs alone** — never beside W4-B: `Timeout` is wall-clock, so a shared machine changes the score (plan §9). W4-B goes first; this lane is the cheap one |
| **Status** | 🟩 Done (2026-08-23) — `packages/core` scores **100.00** and the configuration breaks below it. Held on a local branch at the operator's instruction; nothing was pushed. See the completion log at the foot of this file and [plan §9](../plan.md) |
| **Progress** | 4/4 tasks |
| **Branch** | `agent/work` (local only — the operator asked for no push; the `feat/w4a-stryker-core` branch this file named was never created) |
| **Owned paths** | `packages/core/stryker.config.mjs`, `packages/core/package.json` (scripts block only), tests and test-only helpers under `packages/core/**`; source files under `packages/core/src/**` **only** to remove an equivalent mutant by simplifying to the value that serves (no behaviour change); `packages/core/vitest.stryker.config.ts`. `.gitignore` already lists `.stryker-tmp/` and `reports/` on `main`, so neither lane touches it and the two share no file at all |
| **Depends on** | W3-A merged (code stable; mutants are meaningful only on stable code). W3-A being unmerged is **not** why this lane is idle — the deferral above is |
| **Unblocks** | W4-C follow-up (orchestrator-owned `mutation` CI job + README badge — opened only when **both** W4-A and W4-B pass) |
| **Source** | [docs/plan.md §9](../plan.md) (table row W4-A, rules) · spec [06 §5](../spec/06-testing.md) · [01 §5 S7](../spec/01-overview.md) |
| **Notes** | may slip — documented in README "Known gaps" (plan §9: the product is complete without it; this lane turns S7 from "pending" into "verified") |
| **Last updated** | 2026-08-23 |

## Context

Coverage is 100 % on every metric, but coverage proves that lines ran, not that tests would notice a defect. Stryker 10 mutates the modules of `packages/core` where a surviving mutant would mean a real bug — secrets, redaction, scheduling, workspace lifecycle, restore context, agent protocol codec and the OpenAI event mapping — and runs the existing Vitest suite against each mutant. This lane adds the configuration, measures the baseline, and then **strengthens tests** (assert behaviour, not existence) until the score clears `break: 80` with 90 as the target, documenting every equivalent mutant. Reports are gitignored; the numbers live in this file's completion log and the PR.

Measured on `main` (2026-08-22, 14-core / 36 GB laptop, `concurrency: 2`), so the numbers below are
a floor to compare against rather than a guess: the `mutate` list above resolves to **25 files and
1,396 mutants**, and `src/redaction/redactor.ts` alone — 117 of them — ran in **6 seconds**
(~0.05 s per mutant, 20 covering tests each) and already scored **91.45 %**. A full run should
therefore land between **3 and 10 minutes**. Peak resident memory was **+751 MB over the idle
baseline** (~375 MB per test-runner process), because the vitest runner forces its own pool to a
single worker — see rule 12. If a full run is longer than 10 minutes, note the duration in the
completion log and the PR — do **not** shrink the `mutate` list to make it faster.

## Rules of this lane

1. **Dependencies are already installed** (W0 T0.2): `@stryker-mutator/core` and `@stryker-mutator/vitest-runner`, both 10.x, **same version** — verify with `pnpm ls -r --depth 0 | grep stryker`; if they differ, stop and report (no dependency changes in lanes). They live in the **root** `node_modules` only, which is why the config has to name the runner plugin explicitly — rule 10.
2. **Kill survivors by strengthening tests** — assert the behaviour the mutated line is responsible for (exact outputs, `toStrictEqual`, `toHaveBeenNthCalledWith`, boundaries asserted **at** the limit and one step beside it), never by asserting that a line exists or by duplicating the implementation in the test.
3. **Equivalent mutants:** first try to change the code to the value that serves (e.g. a guard that is equivalent to no guard is removed; `Math.max(x, 0)` instead of an `if`), keeping behaviour and 100 % coverage. Only if the mutant is truly equivalent and the code cannot be simplified: document it in the PR as `file:line — mutator — why equivalent`. **No `// Stryker disable`** without a one-line justification that the orchestrator accepts in the PR; disables are per mutator per line, never blanket.
4. **`incremental: false` for the first full run and for every run that produces a number you report.** Never mix a scoped run (`--mutate <files>`) with `incremental: true` — the report would show cached verdicts for files the run never touched. For scoped iteration use `--incrementalFile <scratch-path>` so the main cache is never polluted, and read the **per-file table**, not the `All files` line.
5. **`Timeout` counts as killed** in the score. A `Timeout` in code without I/O or loops is an artefact to verify by hand (run the two tests that cover it against the mutated line); do not let timeouts inflate the number you report.
6. **`cleanTempDir: 'always'`** — the default (`true`) only cleans after a passing run, and a leftover `.stryker-tmp/` sandbox poisons later test runs.
7. **`packages/core/vitest.stryker.config.ts` is required, not conditional** — measured: without it
   the run aborts in the dry run, before a single mutant is tested, with `There were failed tests in
   the initial test run`. Two families break inside the sandbox:
   - `src/config/**` (8 files) are repository gates, not unit tests: they compute the repo root as
     `join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')` and read manifests and
     shell scripts through it. Stryker runs from `.stryker-tmp/sandbox-N/`, so the same four levels
     land on `packages/core` and the read becomes `packages/core/packages/core/package.json` →
     `ENOENT`. They also measure nothing about the mutated modules.
   - `**/*.integration.test.ts` (`@db`, `@redis`, `@docker`) must not drive mutation at all.

   So: `vitest.stryker.config.ts` = `mergeConfig(base, { test: { exclude: […base, 'src/config/**', '**/*.integration.test.ts'] } })`, `vitest: { configFile: 'vitest.stryker.config.ts' }`, and still run with `DATABASE_URL`, `REDIS_URL` and `DOCKER_AVAILABLE` unset. Explain both exclusions in the PR. Diagnostic note: the failure surfaces per scope — mutating `src/workspace/**` reproduces it while the other six modules pass, so **a scope that passes proves nothing about the full run**.
8. Only one Stryker tree runs at a time on the machine, and the same lock covers the full gate run (`pnpm test -- --coverage` reaches `apps/web`, 174 jsdom suites). The binding reason is **not** memory — see rule 12 — it is that `Timeout` is wall-clock: a busy machine changes verdicts, and the same mutant has been observed coming out `Timeout`, `Survived` and killed across three measurements of unchanged code. Coordinate with W4-B through the orchestrator; `concurrency: 2` each is the cap and never rises.
9. No `enum`, no suppression comments (`eslint-disable`, `@ts-*`, `v8 ignore`), JSDoc on exports + file headers (including in `stryker.config.mjs`), test header + `it()` comments, English, Conventional Commits, no AI-attribution trailers; canaries from `@agent-hangar/core/testing` for any secret-shaped value. Branch `feat/w4a-stryker-core`. One PR at the end (T4A.4).
10. **`plugins: ['@stryker-mutator/vitest-runner']` is mandatory in the config.** Stryker discovers plugins by globbing `node_modules/@stryker-mutator/*` **relative to the cwd**; under pnpm the packages exist only in the root `node_modules`, which the glob never reaches, so a config without it dies with `Cannot find TestRunner plugin "vitest". In fact, no TestRunner plugins were loaded.` The `import` itself resolves fine by walking up — only the discovery glob needed the hint.
11. **`ignorePatterns: ['dist', 'coverage', 'reports', '.stryker-tmp']`.** The project reader otherwise walks 1,285 files here and copies the 6.7 MB `dist/` tree — including `dist/**/*.integration.test.js` — into every sandbox.
12. **The package's `maxWorkers: 3` does not apply inside a Stryker worker.** For Vitest ≥ 4.1 the runner builds its context with `pool: 'threads'`, `maxWorkers: 1`, `maxConcurrency: 1` and coverage disabled, so peak memory is `concurrency × one worker`, not `concurrency × 3`. Do not "compensate" by raising `concurrency`: memory is not what limits this lane, verdict stability is (rule 8).

## Reference docs

- [docs/plan.md](../plan.md) § "9. Wave 4" (table + rules), § "12. Status dashboard"
- [spec 06 — Testing](../spec/06-testing.md) § "5. Mutation testing (Stryker)" (scope table, config notes), § "2. Unit tests" (`packages/core` bullets — the behaviours the tests must pin)
- [spec 01 — Overview](../spec/01-overview.md) § "5. Success criteria" S7
- Stryker 10 docs: configuration (`mutate`, `thresholds`, `incremental`, `cleanTempDir`, `timeoutMS`, `tempDirName`, reporters), vitest-runner options (`vitest.configFile`), mutant states (`Killed`, `Survived`, `Timeout`, `NoCoverage`, `CompileError`, `Ignored`)

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 4A.1 | `stryker.config.mjs`, scripts, gitignore; first full run; baseline recorded | 📋 | P1 | S | — |
| 4A.2 | Triage survivors by module; kill by strengthening tests; simplify equivalent code | 📋 | P1 | L | 4A.1 |
| 4A.3 | Reach `break: 80` (target 90) on a full run; keep 100 % coverage; equivalent-mutant ledger | 📋 | P1 | M | 4A.2 |
| 4A.4 | Close-out: gates, code review, dashboard, PR with scores | 📋 | P1 | S | 4A.1–4A.3 |

---

## Task 4A.1 — `stryker.config.mjs`, scripts, gitignore; first full run; baseline recorded

**Status:** 📋 ToDo · **Priority:** P1 · **Size:** S · **Depends on:** —

**Description.** Add the Stryker configuration for `packages/core` exactly as plan §9 specifies, wire `pnpm --filter @agent-hangar/core test:mutation`, make sure temp and report directories are gitignored, run the **first full, non-incremental** pass, and record the baseline (score, killed/survived/timeout/no-coverage counts, duration, per-module table) in this file's completion log.

**Acceptance criteria**
- [ ] `packages/core/stryker.config.mjs` (ESM, JSDoc typed `@type {import('@stryker-mutator/api/core').PartialStrykerOptions}`, file header) with: `testRunner: 'vitest'`, **`plugins: ['@stryker-mutator/vitest-runner']`** (rule 10 — without it the run cannot start), `vitest: { configFile: 'vitest.stryker.config.ts' }` (rule 7), **`ignorePatterns: ['dist','coverage','reports','.stryker-tmp']`** (rule 11), `mutate: ['src/secrets/**','src/redaction/**','src/scheduling/**','src/workspace/**','src/restore/**','src/agent-protocol/**','src/model/openai/mapping.ts']` (plus the standard negations `'!src/**/*.test.ts'`, `'!src/**/types.ts'`, `'!src/**/index.ts'`), `thresholds: { high: 90, low: 80, break: 80 }`, `concurrency: 2`, `reporters: ['html','clear-text','progress','json']`, `htmlReporter: { fileName: 'reports/mutation/index.html' }`, `jsonReporter: { fileName: 'reports/mutation/mutation.json' }`, `incremental: false`, `cleanTempDir: 'always'`, **`timeoutMS: 5000`** (the Stryker default — **not** the 20000 this lane originally specified: the 3–10 min expectation above was measured at the default, and a real hang under `perTest` is caught by the hit counter rather than by the clock, so the larger budget buys waiting and no information), `tempDirName: '.stryker-tmp'`, `coverageAnalysis: 'perTest'`
- [ ] `packages/core/vitest.stryker.config.ts` exists and excludes `src/config/**` and `**/*.integration.test.ts` on top of the base config, with a file header explaining both exclusions (rule 7); the base `vitest.config.ts` is not modified
- [ ] A comment block in the config states: never mix a scoped `--mutate` run with `incremental: true`; for scoped iteration use `--incrementalFile .stryker-tmp/inc-scoped.json`; the number reported is always from a full non-incremental run
- [ ] `packages/core/package.json` scripts: `test:mutation` → `stryker run` (and `test:mutation:scoped` → `stryker run --incrementalFile .stryker-tmp/inc-scoped.json --mutate` for hand-use). The root `test:mutation` already serialises workspaces (`pnpm --recursive --if-present --sequential …`), so there is nothing to request there — verify and move on
- [ ] `.gitignore` already contains `.stryker-tmp/` and `reports/` on `main` — verify, change nothing. There is consequently **no shared file between W4-A and W4-B**, and the rebase coordination the two lanes used to describe is moot
- [ ] `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` versions verified identical (`pnpm ls`)
- [ ] Dry run first (`--dryRunOnly`) over the **whole** `mutate` list, not a module of it: it must report the 25 files / ~1,396 mutants of the measured baseline and `Initial test run succeeded`. A dry run that fails with `There were failed tests in the initial test run` means rule 7 is not satisfied yet
- [ ] First full run executed with `DATABASE_URL`/`REDIS_URL`/`DOCKER_AVAILABLE` unset; completes without instrumenter errors (a `SyntaxError … could not place mutants` aborts the run — fix the source construct, e.g. replace an inline template-literal type with a named type, and note it); duration recorded and compared against the measured 3–10 min expectation
- [ ] Baseline recorded in the completion log: overall score, `killed / survived / timeout / noCoverage / compileError / ignored`, duration, and a per-module table (secrets, redaction, scheduling, workspace, restore, agent-protocol, model/openai/mapping) with score and survivor count; `reports/mutation/` NOT committed

**Files to create/modify**
`packages/core/stryker.config.mjs`, `packages/core/vitest.stryker.config.ts` (required — rule 7), `packages/core/package.json` (scripts). `.gitignore` needs no change.

**Agent prompt**

````
You are a senior TypeScript engineer specialised in test quality working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Vitest 4 (@vitest/coverage-v8, 100 % thresholds) · Stryker 10 (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`, same 10.x version, installed in W0). packages/core is framework-free.
Branch feat/w4a-stryker-core (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W4-A (Stryker — packages/core) — Task 4A.1 of 4 (FIRST)

PRECONDITIONS
- W3-A merged: packages/core is stable and at 100 % coverage on src/**.
- Stryker packages are installed at the root (W0 T0.2). No dependency may be added or changed.
- Nothing else runs Stryker on this machine right now (W4-B coordinates through the orchestrator).

REQUIRED READING (only these):
- docs/plan.md § "9. Wave 4" (table row W4-A + rules)
- docs/spec/06-testing.md § "5. Mutation testing (Stryker)"
- docs/tasks/wave-4a-stryker-core.md § "Rules of this lane" (this file)
- packages/core/vitest.config.ts and packages/core/package.json
- Stryker 10 documentation pages: "Configuration", "Vitest runner", "Incremental", "Reporters"

TASK
Configure Stryker 10 for packages/core exactly as the plan specifies, run the first full non-incremental pass, and record the baseline in this task file. Do not fix survivors yet.

DELIVERABLES

1. `packages/core/stryker.config.mjs` — file header + `/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */ export default { … }` with exactly: `testRunner: 'vitest'`, `plugins: ['@stryker-mutator/vitest-runner']`, `ignorePatterns: ['dist', 'coverage', 'reports', '.stryker-tmp']`, `vitest: { configFile: 'vitest.stryker.config.ts' }`, `mutate: ['src/secrets/**', 'src/redaction/**', 'src/scheduling/**', 'src/workspace/**', 'src/restore/**', 'src/agent-protocol/**', 'src/model/openai/mapping.ts', '!src/**/*.test.ts', '!src/**/types.ts', '!src/**/index.ts']`, `thresholds: { high: 90, low: 80, break: 80 }`, `concurrency: 2`, `coverageAnalysis: 'perTest'`, `reporters: ['html', 'clear-text', 'progress', 'json']`, `htmlReporter: { fileName: 'reports/mutation/index.html' }`, `jsonReporter: { fileName: 'reports/mutation/mutation.json' }`, `incremental: false`, `cleanTempDir: 'always'`, `timeoutMS: 5000`, `tempDirName: '.stryker-tmp'`. Add a comment block: "Never combine a scoped `--mutate` run with `incremental: true` — cached verdicts for untouched files would be mixed into the report. For scoped iteration use `--incrementalFile .stryker-tmp/inc-scoped.json`. Reported scores always come from a full run with incremental off." Leave `ignoreStatic` at its default; if static mutants make the run exceed the budget, note the split in the PR rather than flipping it.
2. Scripts in packages/core/package.json: `"test:mutation": "stryker run"`, `"test:mutation:scoped": "stryker run --incrementalFile .stryker-tmp/inc-scoped.json --mutate"` (usage: `pnpm test:mutation:scoped 'src/secrets/service.ts,src/secrets/key-file.ts'` — one comma-separated flag; repeated `--mutate` flags do not accumulate, measured: passing two of them mutated only the last one's files). The root `test:mutation` already runs `pnpm --recursive --if-present --sequential`, so workspaces are serialised — verify, request nothing, edit nothing at the root.
3. `.gitignore`: `.stryker-tmp/` and `reports/` are already there on `main`. Verify and leave the file alone — W4-B needs no change either, so the two lanes share no file.
4. Version parity: `pnpm ls -r --depth 0 2>/dev/null | grep -i stryker` — both 10.x and identical. If not, stop and report.
5. Sandbox gating — do this BEFORE the first run, it is not conditional. Create `packages/core/vitest.stryker.config.ts`: `mergeConfig(base, { test: { exclude: [...configDefaults.exclude, 'src/config/**', '**/*.integration.test.ts'] } })`, and point `vitest.configFile` at it. `src/config/**` are repository gates that derive the repo root by climbing `'..','..','..','..'` from `import.meta.url`; inside `.stryker-tmp/sandbox-N/` that lands on `packages/core` and they die on `ENOENT … packages/core/packages/core/package.json`, which aborts the whole run in the dry phase. Verify with `stryker run --dryRunOnly` over the full `mutate` list — it must print `Initial test run succeeded`. Still run with `env -u DATABASE_URL -u REDIS_URL -u DOCKER_AVAILABLE`. Explain both exclusions in the PR.
6. First full run: time it (`time …`). Expect 25 files / ~1,396 mutants and 3–10 minutes at `concurrency: 2` (measured on `main`: `src/redaction/redactor.ts`, 117 mutants, 6 s, 91.45 %). If the instrumenter aborts on a source construct (e.g. `SyntaxError: … could not place mutants` on an inline template-literal type), make the minimal source change that keeps the type check (named type imported from a `types.ts`) and note it. If a run exceeds 10 minutes, record the duration — do not reduce `mutate`, do not raise concurrency above 2. Nothing else may run on the machine during a run whose number you report: `Timeout` is wall-clock and a loaded machine changes verdicts.
7. Record the baseline in this file's completion log: `score`, `killed/survived/timeout/noCoverage/compileError/ignored`, duration, per-module table (module · mutants · killed · survived · timeout · score) read from `reports/mutation/mutation.json` (a short `node -e` over the JSON is fine; do not commit the reports).

Constraints:
- Follow /bymax-workflow:standards (JSDoc + header in the config, English, no suppression comments).
- Do not add `// Stryker disable`; do not touch tests or source in this task beyond an instrumenter blocker.
- Do not change vitest.config.ts thresholds or includes.

Verification:
- `pnpm --filter @agent-hangar/core exec stryker run --dryRunOnly` (or the first seconds of a run) shows the vitest dry run passing and "N mutant(s) to test" for the seven modules only
- `git status --porcelain` after the run shows no `reports/` or `.stryker-tmp/` files
- `pnpm lint && pnpm typecheck && pnpm --filter @agent-hangar/core test -- --coverage` — green, 100 %

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-4a-stryker-core.md (task index row and task block)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/4 tasks`)
4. Append a completion log entry at the end of the file: `- 4A.1 ✅ <YYYY-MM-DD> — baseline <score> % (<killed>/<total>, <survived> survived, <timeout> timeout) in <mm:ss>` followed by the indented per-module table
5. Commit: `test(core): add Stryker 10 configuration and record the baseline mutation score`
````

---

## Task 4A.2 — Triage survivors by module; kill by strengthening tests; simplify equivalent code

**Status:** 📋 ToDo · **Priority:** P1 · **Size:** L · **Depends on:** 4A.1

**Description.** Work through the survivors module by module (secrets → redaction → agent-protocol → scheduling → workspace → restore → openai mapping — highest defect risk first), reproduce each mutant's effect by hand before writing a test, and kill it with an assertion on behaviour. Where a mutant is equivalent, prefer simplifying the code to the value that serves (same behaviour, coverage stays 100 %). Keep a ledger of what remains.

**Acceptance criteria**
- [ ] Every `Survived` and `NoCoverage` mutant from the baseline has one of three outcomes recorded in the ledger (working notes → completion log summary): **killed** (test name), **removed** (code simplified; commit), or **equivalent** (file:line, mutator, one-line reason)
- [ ] Tests added/strengthened follow the traps list: `toStrictEqual` over `toEqual`/`toMatchObject` where absence of a field is the signal; `toHaveBeenNthCalledWith` for repeated calls; boundaries asserted at the limit and one beside it (`>=` vs `>`); exported constants that cross a boundary (queue names, stream keys, regexes, notice text, cron defaults) pinned verbatim; Zod schemas asserted by rejecting a wrong member and accepting each allowed one; the cheap killing test placed **first** in its file so expensive paths are not what kills
- [ ] Every `Timeout` in code without I/O or loops verified by hand (mutate the line, run the covering tests) and either turned into a real kill by a behavioural assertion or documented
- [ ] No `// Stryker disable` added without a one-line justification in the same comment and in the PR ledger; no suppression comments of any other kind
- [ ] After each module: a scoped run with `pnpm test:mutation:scoped '<files>'` confirms the per-file table (never the `All files` line) shows the expected kills; 100 % coverage still holds (`pnpm --filter @agent-hangar/core test -- --coverage`)
- [ ] Code simplifications are behaviour-preserving and covered by existing or new tests; each one is its own commit with a message naming the mutant it removes

**Files to modify**
`packages/core/src/**/*.test.ts` (strengthened/added), `packages/core/src/{secrets,redaction,scheduling,workspace,restore,agent-protocol}/**` and `src/model/openai/mapping.ts` only for behaviour-preserving simplifications.

**Agent prompt**

````
You are a senior TypeScript engineer specialised in test quality working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: TypeScript ~6.0.3 strict · Node 24 · Vitest 4 · Stryker 10 with vitest-runner. packages/core modules under mutation: secrets (AES-256-GCM, key file), redaction (exact + shape patterns, redactJson), scheduling (cron validation, nextRunAt/DST, reconcile), workspace (state machine, ensure decision, idle TTL), restore (history window, TOOL_SUMMARY compaction, notice, expectedHeadSha), agent-protocol (Zod schemas, NDJSON codec), model/openai/mapping.ts (Responses event → ModelEvent).
Branch feat/w4a-stryker-core (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W4-A — Task 4A.2 of 4 (MIDDLE)

PRECONDITIONS
- Task 4A.1 done: config exists, baseline recorded in docs/tasks/wave-4a-stryker-core.md, reports/mutation/mutation.json from the full run is on disk (regenerate with a full run if missing).

REQUIRED READING (only these):
- docs/tasks/wave-4a-stryker-core.md § "Rules of this lane" and the 4A.1 baseline table
- docs/spec/06-testing.md § "2. Unit tests" (packages/core bullets — the behaviours to pin)
- reports/mutation/index.html (open per file) or mutation.json — the survivor list
- docs/plan.md § "9. Wave 4" rules paragraph

TASK
Kill surviving mutants by strengthening tests so they assert behaviour, simplify code where a mutant is equivalent and the value that serves is obvious, and keep a precise ledger of the remainder.

DELIVERABLES

1. Triage order: secrets → redaction → agent-protocol → scheduling → workspace → restore → model/openai/mapping.ts. For each survivor: open the mutant in the HTML report, reproduce by hand (apply the mutation mentally or temporarily and run the covering tests), and decide: kill / simplify / equivalent.
2. Kill patterns to use (from measured experience): capture call args and `toStrictEqual` them (loose `toHaveBeenCalledWith` ignores `undefined` props); `toHaveBeenNthCalledWith(n, …)` for repeated calls with different literals; assert exact outputs (`toEqual`) when an extra field is the signal; test boundaries AT the limit and one step beside it (`ttl 0`, `last4` on 3-char values, max steps, 30-char slug, window budget); pin exported literals that cross a boundary (`QUEUE_NAMES`, stream/channel keys, `SECRET_SHAPE_PATTERNS`, notice texts, `TOOL_SUMMARY` marker, error `code`s) with `toBe('<literal>')` — never compare a constant against itself; for Zod schemas assert that a wrong discriminator/member is rejected and every allowed member accepted; put the cheapest killing assertion FIRST in the file and leave a comment that the position is deliberate (Stryker stops at the first killing test).
3. Simplify when equivalent: a guard equivalent to no guard (`if (len > cap) splice` → `splice(0, len - cap)`), `typeof x === 'number' ? x : Number(x)` → `Number(x)`, `<=` vs `<` at an impossible boundary → `Math.max`/`Math.min` forms, ternaries with identical branches. Each simplification: behaviour-preserving, covered, its own commit `refactor(core): <what> (removes equivalent mutant <file>:<line>)`.
4. Ledger (working notes, summarised into the completion log): per module — `killed N (tests: …)`, `removed N (commits: …)`, `equivalent N (file:line — mutator — reason)`. Equivalent entries must be specific ("`>=` vs `>` on `seq` where seq is always an integer ≥ 1 and the branch is unreachable at equality") — not "hard to test".
5. After each module: `pnpm test:mutation:scoped '<comma-separated files of that module>'` — confirm in the per-file table; then `pnpm --filter @agent-hangar/core test -- --coverage` still 100 %; `pnpm lint && pnpm typecheck` green. Commit per module: `test(core): kill <module> mutants by asserting <behaviour>`.
6. `Timeout` verdicts in pure code: verify by hand; if two covering tests kill it, add a cheap behavioural assertion first so the kill is by wrong answer, not exhaustion.
7. `// Stryker disable next-line <Mutator>: <reason>` is allowed only per mutator per line with a reason that names what the mutation would change and why no test can observe it; list every one in the ledger. Expect the orchestrator to challenge each.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression comments other than the justified Stryker directive above, it() comments).
- No behaviour changes; no new dependencies; do not touch files outside packages/core.
- Do not use `incremental: true` anywhere in this task.

Verification:
- Per-module scoped runs show the survivors you targeted as Killed in the per-file table
- `pnpm --filter @agent-hangar/core test -- --coverage` — 100/100/100/100
- `grep -rn "Stryker disable" packages/core/src | wc -l` equals the number of ledger entries with a justification

Completion Protocol: update status/AC/progress in docs/tasks/wave-4a-stryker-core.md; append `- 4A.2 ✅ <date> — survivors: killed <k>, removed <r>, equivalent <e>, disables <d>` with the per-module ledger indented below; commits as described per module.
````

---

## Task 4A.3 — Reach `break: 80` (target 90) on a full run; keep 100 % coverage; equivalent-mutant ledger

**Status:** 📋 ToDo · **Priority:** P1 · **Size:** M · **Depends on:** 4A.2

**Description.** Run the full non-incremental pass again, confirm the score clears `break: 80` and push toward 90 with a second iteration on the remaining survivors, verify that every Vitest coverage threshold still holds, and produce the final equivalent-mutant ledger and per-module table for the PR. If 90 is not reached within the time box, record where the score stands and why (which modules, which mutant classes).

**Acceptance criteria**
- [ ] Full run (`incremental: false`, integration env unset) exits 0 with score ≥ 80 (target ≥ 90); final numbers in the completion log: score, counts, duration, per-module table; if < 90, a paragraph naming the remaining survivor classes per module and the next concrete step
- [ ] Second iteration done on the top remaining survivors (largest modules first) within a 1 h time box, using the 4A.2 methods; every new `Stryker disable` justified per mutator per line and listed
- [ ] `pnpm --filter @agent-hangar/core test -- --coverage` 100/100/100/100; `pnpm lint && pnpm typecheck` green; `pnpm test:integration` (with the test stack) still green — tests were strengthened, not changed in meaning
- [ ] Final ledger for the PR: table `File:line · Mutator · Verdict (equivalent / disabled) · Reason`, plus the list of code simplifications with commit hashes
- [ ] Runtime statement: total duration of the final full run against the measured 3–10 min expectation (if outside it: the figure and the likely reason — static mutants, test count — without shrinking `mutate`), plus confirmation that no other Stryker tree or full gate run shared the machine
- [ ] `reports/mutation/` and `.stryker-tmp/` absent from `git status`

**Files to modify**
`packages/core/src/**/*.test.ts` (second iteration), `packages/core/src/**` only for behaviour-preserving simplifications.

**Agent prompt**

````
You are a senior TypeScript engineer specialised in test quality working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: TypeScript ~6.0.3 strict · Node 24 · Vitest 4 · Stryker 10 with vitest-runner (`break: 80`, target 90).
Branch feat/w4a-stryker-core (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W4-A — Task 4A.3 of 4 (MIDDLE)

PRECONDITIONS
- Task 4A.2 done: survivors triaged, ledger in the completion log.

REQUIRED READING (only these):
- docs/tasks/wave-4a-stryker-core.md (4A.1 baseline, 4A.2 ledger, Rules)
- packages/core/stryker.config.mjs

TASK
Confirm the threshold on a full run, iterate once more toward 90 within a time box, verify coverage and integration suites still hold, and produce the final ledger and runtime statement for the PR.

DELIVERABLES

1. Full run: `time env -u DATABASE_URL -u REDIS_URL -u DOCKER_AVAILABLE pnpm --filter @agent-hangar/core test:mutation` — must exit 0 (score ≥ 80). Extract score, counts and per-module table from reports/mutation/mutation.json (same `node -e` as 4A.1). Record them.
2. Second iteration (≤ 1 h): sort remaining survivors by module size; apply the 4A.2 kill/simplify/equivalent decisions; scoped runs per module via `test:mutation:scoped` with the per-file table as the check; commit per module.
3. Final full run again (incremental off) and record the final numbers; if < 90, write a short paragraph per module naming the survivor classes (e.g. "redaction: 6 StringLiteral mutants in regex alternations that overlap — equivalent; scheduling: 3 boundary mutants on DST edge cases needing fixture dates — next step: table test with the three DST transitions of Europe/Lisbon and America/Sao_Paulo").
4. Verify nothing regressed: `pnpm --filter @agent-hangar/core test -- --coverage` (100 %), `pnpm lint && pnpm typecheck`, and — with the test stack up (`AH_INSTANCE=test pnpm infra:up`) — `pnpm --filter @agent-hangar/core test:integration` green.
5. Final ledger for the PR body (Markdown table): `File:line · Mutator · Verdict · Reason` for every equivalent/disabled mutant; list of simplification commits with hashes; count of `Stryker disable` directives (`grep -rn "Stryker disable" packages/core/src`).
6. Runtime statement: duration of the final full run against the 3–10 min expectation measured on `main`, with the reason if outside it, and a line confirming the machine was otherwise idle for that run.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression comments except justified per-line Stryker directives, it() comments).
- No behaviour change; no dependency change; `mutate` list unchanged; `concurrency` stays 2; `incremental` stays false.

Verification:
- Final full run exit code 0, score ≥ 80 (state the number)
- `git status --porcelain | grep -E "reports/|\.stryker-tmp/"` — empty
- Integration suite green; coverage 100 %

Completion Protocol: update status/AC/progress in docs/tasks/wave-4a-stryker-core.md; append `- 4A.3 ✅ <date> — final <score> % (<killed>/<total>) in <mm:ss>; equivalent <e>, disables <d>` with the final per-module table indented; commit `test(core): raise mutation score to <score> % and document equivalent mutants`.
````

---

## Task 4A.4 — Close-out: gates, code review, dashboard, PR with scores

**Status:** 📋 ToDo · **Priority:** P1 · **Size:** S · **Depends on:** 4A.1–4A.3

**Description.** Run the full gate set, run the code review to zero findings, update the plan dashboard and tasks index, and open the PR whose body carries the baseline → final scores, the per-module table, the equivalent-mutant ledger, the runtime statement and the note that the CI `mutation` job is a separate follow-up (W4-C) opened by the orchestrator once W4-B also passes.

**Acceptance criteria**
- [ ] `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test -- --coverage` green (100 % everywhere); `pnpm --filter @agent-hangar/core test:mutation` exit 0 on the final commit
- [ ] `/bymax-quality:code-review` on the branch with zero open findings (every `Stryker disable` is reviewed as a finding and must carry its justification; no other suppression)
- [ ] `docs/plan.md` §12 row `W4-A` → 🟨 with branch + PR number and Notes `score <final> %`; `docs/tasks/README.md` W4-A row → 🟨; this file's header Status → 🟨 PR open, Progress 4/4; README "Known gaps" row for W4-A is **not** edited here (W4-C / orchestrator updates README)
- [ ] PR opened with `gh pr create`; body: summary, config summary, baseline → final table, per-module table, equivalent-mutant ledger, code simplifications, runtime statement, "CI job: follow-up W4-C (orchestrator) once W4-B passes", gate results
- [ ] Returned to the orchestrator: `{ pr, branch, headSha, gates, coverage, contractChangeRequests }` (`coverage` includes `mutationScore`)

**Files to modify**
`docs/plan.md` (§12 W4-A row), `docs/tasks/README.md` (W4-A row), `docs/tasks/wave-4a-stryker-core.md` (header, log).

**Agent prompt**

````
You are a senior engineer closing out the core mutation-testing lane of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 · Node 24 · Vitest 4 · Stryker 10 · GitHub CLI.
Branch feat/w4a-stryker-core (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W4-A — Task 4A.4 of 4 (LAST)

PRECONDITIONS
- Tasks 4A.1–4A.3 done and committed; the final full run exited 0 with the score recorded in this file.

REQUIRED READING (only these):
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard", § "9. Wave 4" (last paragraph — the W4-C follow-up)
- docs/tasks/wave-4a-stryker-core.md completion log (your numbers and ledger)

TASK
Run all gates and the code review to zero findings, update the dashboards, and open the PR with scores and the ledger. Do not add the CI job — that is the orchestrator's W4-C follow-up.

DELIVERABLES

1. Gates: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test -- --coverage` (100 % in every package); `env -u DATABASE_URL -u REDIS_URL -u DOCKER_AVAILABLE pnpm --filter @agent-hangar/core test:mutation` exit 0 on HEAD (if the last code change was after the final run, re-run fully and update the numbers).
2. Rebase on latest main; re-run the mutation pass if main changed any file under the `mutate` globs.
3. `/bymax-quality:code-review` on `main..HEAD`; fix every finding (no suppressions; every `Stryker disable` must carry its per-line justification or be removed by a better test); re-run gates; repeat on every new commit before pushing.
4. Dashboards: docs/plan.md §12 row W4-A → `🟨 PR open` with `feat/w4a-stryker-core` / PR number and Notes `mutation score <final> % (break 80, target 90)`; docs/tasks/README.md W4-A → 🟨; this file header Status → 🟨, Progress 4/4. Do not edit README.md (W4-C updates "Known gaps" and the badge when both lanes pass).
5. Push; `gh pr create --base main --title "test(core): Stryker 10 mutation testing on packages/core (W4-A)" --body-file <generated>`. Body sections: Summary · Configuration (the key options) · Scores (baseline → final; counts; duration) · Per-module table · Equivalent-mutant ledger (File:line · Mutator · Verdict · Reason) · Code simplifications (commits) · `Stryker disable` directives (count + list) · Runtime statement · Follow-up: "CI `mutation` job (PR-scoped incremental with `--incremental` and a cached `incrementalFile`, nightly full run on schedule) and README badge/section are added by the orchestrator in W4-C once W4-B also passes" · Gates.
6. Return: `{ pr, branch, headSha, gates: { lint, format, typecheck, unit, mutation }, coverage: { core: '100/100/100/100', mutationScore: <n> }, contractChangeRequests: [] }`.

Constraints:
- English; Conventional Commits; no AI attribution anywhere. Do not wait for CI; do not merge.
- Owned paths only (see header) plus the two dashboard rows.

Verification:
- `gh pr view --json number,headRefOid` — PR exists
- `git diff --name-only main..HEAD | grep -vE '^(packages/core/|\.gitignore$|docs/plan\.md$|docs/tasks/README\.md$|docs/tasks/wave-4a-stryker-core\.md$)'` — empty
- `git log --format=%B main..HEAD | grep -i "co-authored-by\|generated with"` — empty

Completion Protocol: update status/AC/progress in docs/tasks/wave-4a-stryker-core.md (header Status → 🟨 PR open); append `- 4A.4 ✅ <date> — PR #<n> opened, score <final> %`; commit `chore: close out W4-A mutation lane` before opening the PR (then `docs(plan): record W4-A PR number`).
````

---

## Follow-up owned by the orchestrator — W4-C (not a task of this lane)

Opened **only when both W4-A and W4-B have passed** (`break: 80` on a full run, PRs merged): a third, tiny PR that adds the `mutation` CI job to `.github/workflows/ci.yml` — PR-scoped incremental (`stryker run --incremental` with `incrementalFile` restored/saved via the Actions cache keyed by package + branch; the incremental file is invalidated when the base branch changes) and a nightly **full** run on `schedule` with `incremental: false` and `reports/mutation/` uploaded as an artifact; plus the README mutation badge/section and the removal of the W4 rows from README "Known gaps". Until W4-C merges, `pnpm test:mutation` is a local-only gate and README "Known gaps" says so.

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)

- 4A.1 ✅ 2026-08-23 — `stryker.config.mjs` and `vitest.stryker.config.ts` added; the `mutate` list is the whole of `src/**` rather than the six directories this file names, minus the generated Prisma client, the test doubles and the integration-suite gate helper. Baseline measured at 3,927 mutants.
- 4A.2 ✅ 2026-08-23 — survivors triaged and killed by module. The recurring shapes were doubles kinder than the thing they stood in for, assertions comparing a constant with itself, and resources no test checked were given back (plan §9).
- 4A.3 ✅ 2026-08-23 — **100.00**, not the 80 this file asked for: `break` is set to 100 in every scope, so a single survivor fails the run. Equivalent mutants carry a `// Stryker disable` naming the reason in the source rather than in a pull-request ledger, which is where a later reader will look.
- 4A.4 ✅ 2026-08-23 — gates green (`lint`, `format:check`, `typecheck`, `test --coverage`); dashboards updated in plan §9 and §12. No pull request: the operator asked for the work to stay local, so there is nothing to review on the remote.
