# Wave 1 — Lane W1-D — Agent runtime (inside the container)

| | |
|---|---|
| **Lane** | W1-D (no Docker, no Postgres, no Redis — pure Node + git in a temp dir) |
| **Status** | 📋 ToDo |
| **Progress** | 0/5 tasks |
| **Branch** | `feat/w1d-agent-runtime` |
| **Owned paths** | `packages/agent-runtime/**` (src, tests, `esbuild.config.mjs`, `vitest.config.ts`, `package.json` scripts of this package, `scripts/`) · the two Dockerfile `COPY` lines and the `infra:image` root-script change are **requested via the PR description** (W1-B owns `infra/workspace/**`, W1-I owns root `package.json` scripts) |
| **Depends on** | W0 merged to `main` |
| **Unblocks** | W2-B 🐳 (worker processors) · coordination with W1-B (Dockerfile `COPY` lines applied by the orchestrator when merging the later of W1-B / W1-D) |
| **Source** | [docs/plan.md §6 W1-D](../plan.md) · spec [03 §3](../spec/03-interfaces.md) [04 (a)](../spec/04-flows.md) [06 §2](../spec/06-testing.md) |
| **Last updated** | 2026-08-19 |

## Context

The agent runtime is the program the worker `exec`s inside every workspace container: `node /opt/agent-runtime/cli.js turn`. It reads one `TurnRequest` (NDJSON) from stdin, prepares `/workspace` (clone/checkout), runs the model ↔ tools loop and streams `AgentEvent`s to stdout, one JSON object per line. W0 froze the protocol (`packages/core/src/agent-protocol/{schemas,types,ndjson}.ts`), the model contract (`packages/core/src/model/types.ts`), `SECRET_SHAPE_PATTERNS` (`packages/core/src/secrets/types.ts`), the errors (`packages/core/src/errors.ts`) and `FakeAgentModelProvider` (`packages/core/src/testing/fake-agent-model-provider.ts`). `packages/agent-runtime` exists as an empty workspace (`src/index.ts`, `package.json` with `zod`, `openai`, `@agent-hangar/core` and dev `esbuild`).

Two facts shape this lane:

1. **The runtime is bundled** (esbuild → `dist/cli.js`, single ESM file, no `node_modules` in the image). Production code may import from `@agent-hangar/core` (barrel) and `FakeAgentModelProvider` from `@agent-hangar/core/testing`; the bundle must tree-shake away every host-only module that the core barrel reaches (Prisma, pg, pino, bullmq, ioredis, dockerode). Task 1D.1 sets the esbuild plugin that marks everything under `packages/core/` side-effect-free and a bundle check that proves `node dist/cli.js --version` runs from an empty directory.
2. **Secrets reach the runtime only through the container env** (`GITHUB_TOKEN`, `OPENAI_API_KEY`). The agent's `run_shell` child env must not carry them. For git to still push, the runtime writes the token to a 0600 file on tmpfs and points `askpass.sh` at it through `AH_GIT_TOKEN_FILE` (W1-B's Task 1B.4 teaches `askpass.sh` that variable; `GITHUB_TOKEN` in the env remains the fallback).

Quality bar: TypeScript strict, zero `any`, zero suppression comments, no `enum`, JSDoc on every export + file header, English only, test headers + a block comment on every `it()`, **100 % coverage on lines/branches/functions/statements** for `packages/agent-runtime/src/**` (only `src/bin.ts`, a 3-line entry, is excluded and documented).

## Rules of this lane

1. **Owned paths only**: `packages/agent-runtime/**`. Anything the runtime needs in `infra/workspace/**` (Dockerfile COPY lines) or in the root `package.json` scripts (`infra:image`) is written **into the PR description** as exact text for the orchestrator — never edited here.
2. **No new dependencies.** Runtime uses `node:child_process`, `node:fs/promises`, `node:path`, `zod`, `@agent-hangar/core`. If something else seems required, stop and report (plan §3 rule 2).
3. **Model provider seam.** W1-C builds `OpenAIModelProvider` in parallel; this lane cannot import it. `src/provider.ts` resolves `AGENT_MODEL_PROVIDER=fake` fully (built-in scripts + `AGENT_FAKE_SCRIPT_JSON` override) and exposes an injectable factory for `openai`; wiring `createModelProvider('openai')` from core is a one-line change listed in the PR description for W3-A (or the orchestrator when W1-C is merged).
4. **Redact before emit.** Every event goes through `redact.ts` (shape patterns from `SECRET_SHAPE_PATTERNS` + the exact values of `GITHUB_TOKEN`/`OPENAI_API_KEY` present in the runtime's own env). The worker redacts again (defence in depth).
5. **Tests use a temp dir as `/workspace`** and `git init --bare` repos as "GitHub". Never call the network. Canaries from `@agent-hangar/core/testing` for any secret-shaped value.
6. Vitest: `coverage.include: ['src/**']`, exclude `src/bin.ts` and `**/*.test.ts`; thresholds 100/100/100/100. `@agent-hangar/core` must be built (`pnpm --filter @agent-hangar/core build`, or `pnpm typecheck` from root which runs `tsc -b`) before running this package's tests/bundle — mirror whatever alias W0 used in `apps/worker/vitest.config.ts` if it resolves core from source.
7. Commit messages: Conventional Commits, English, no attribution trailers. Branch `feat/w1d-agent-runtime`. One PR at the end (Task 1D.5).

## Reference docs

- [docs/plan.md](../plan.md) § "3. Parallelism rules", § "6. Wave 1" (W1-D block, W1-B block for the image, W1-C block for the provider seam), § "11. Orchestrator protocol"
- [spec 03 — Interface contracts](../spec/03-interfaces.md) § "2. AgentModelProvider" (types the loop consumes), § "3. Agent runtime protocol" (transport, TurnRequest, AgentEvent, tools table, loop), § "6. Secrets service" (shape patterns)
- [spec 04 — Flows](../spec/04-flows.md) § "(a)" (steps 37–50 and the edge cases: limits → `stoppedBy: 'limit'`, 429 retries, cancel)
- [spec 06 — Testing](../spec/06-testing.md) § "2. Unit tests" (`packages/agent-runtime` block), § "6. CI pipeline" item 7 (`node cli.js --version` smoke)
- Contract files (read, never edit): `packages/core/src/agent-protocol/{schemas,types,ndjson}.ts`, `packages/core/src/model/types.ts`, `packages/core/src/secrets/types.ts` (`SECRET_SHAPE_PATTERNS`), `packages/core/src/errors.ts` (`ProtocolError`, `ConfigError`), `packages/core/src/testing/{fake-agent-model-provider,canaries}.ts`

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 1D.1 | Package scaffold: protocol I/O, redaction, version, `--version` CLI, esbuild config + bundle check | 📋 | P0 | M | — |
| 1D.2 | Tools: path confinement, `run_shell`, `read_file`, `write_file`, `list_dir`, registry + JSON schemas, child env scrubbing | 📋 | P0 | L | 1D.1 |
| 1D.3 | `prepare.ts` (clone/checkout/expectedHeadSha) + `git-events.ts` (push detection) | 📋 | P0 | M | 1D.2 |
| 1D.4 | `loop.ts` step loop + provider seam + `turn` command wiring (cancel, heartbeat, limits, retries) | 📋 | P0 | L | 1D.2, 1D.3 |
| 1D.5 | Close-out: gates, bundle size, code review, plan dashboard, PR with orchestrator instructions | 📋 | P0 | S | 1D.1–1D.4 |

---

## Task 1D.1 — Package scaffold: protocol I/O, redaction, version, `--version` CLI, esbuild config + bundle check

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** Set up the package for real: Vitest config with 100 % thresholds, the NDJSON protocol adapters over the core codec (`readTurnRequest`, event writer with backpressure, stderr diagnostics), the runtime redactor, the version constant, the CLI dispatcher with `--version`, the esbuild bundle config with the core tree-shake plugin, and a bundle check script. Building the bundle in the first task surfaces any tree-shaking problem immediately.

**Acceptance criteria**
- [ ] `packages/agent-runtime/vitest.config.ts` (node env, v8, include `src/**`, exclude `src/bin.ts` + tests, thresholds 100×4) and package scripts `build`, `test`, `lint`, `typecheck`, `check:bundle`
- [ ] `protocol.ts`: `readTurnRequest(stdin)` parses the first valid `TurnRequest` via `parseNdjsonStream(turnRequestSchema)` and throws `ProtocolError` on malformed/absent input; `createEventWriter(stdout, redactor)` → `{ emit(event), lastEmittedAt() }` writes `encodeLine(redacted)` honouring backpressure; `createDiagnostics(stderr, redactor)` → `diag(message)`
- [ ] `redact.ts`: `createRuntimeRedactor({ values })` → `{ redactText, redactEvent }` applying exact values (longest first) then `SECRET_SHAPE_PATTERNS` with `[REDACTED]`; `redactEvent` covers every text-carrying field of `AgentEvent` and is idempotent
- [ ] `cli.ts` exports `runCli(argv, io): Promise<number>`; `--version` prints `RUNTIME_VERSION`; unknown command → usage on stderr, exit 64; `turn` is a stub returning 70 until 1D.4 (tested as such, replaced later)
- [ ] `esbuild.config.mjs` bundles `src/bin.ts` → `dist/cli.js` (ESM, node24, sourcemap, shebang, createRequire banner, `define` for the version, core side-effect-free plugin, chmod 755); `scripts/check-bundle.mjs` asserts size < 2 MB, no host-only module markers, and `node dist/cli.js --version` works from an empty temp dir
- [ ] 100 % coverage on everything in `src/**` except `src/bin.ts`

**Files to create**
`packages/agent-runtime/{vitest.config.ts, esbuild.config.mjs, scripts/check-bundle.mjs, src/{bin.ts, cli.ts, cli.test.ts, protocol.ts, protocol.test.ts, redact.ts, redact.test.ts, version.ts, version.test.ts, index.ts}}`; modify `packages/agent-runtime/package.json` (scripts, `bin`, `files`).

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/agent-runtime depends on zod, openai (unused until the provider seam is wired) and @agent-hangar/core (workspace); esbuild (dev) bundles it to one ESM file that runs inside the workspace container with no node_modules. Vitest 4 + @vitest/coverage-v8.
Branch feat/w1d-agent-runtime (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-D (agent runtime) — Task 1D.1 of 5 (FIRST)

PRECONDITIONS
- W0 merged to main; branch off latest main: `git checkout -b feat/w1d-agent-runtime origin/main`.
- packages/agent-runtime exists with package.json (deps above), tsconfig.json extending the base (rootDir src, outDir dist), an empty src/index.ts.
- Contract files (read-only): packages/core/src/agent-protocol/{schemas,types,ndjson}.ts (turnRequestSchema, agentEventSchema, TurnRequest, AgentEvent, encodeLine, parseNdjsonStream, createNdjsonParser), packages/core/src/secrets/types.ts (SECRET_SHAPE_PATTERNS), packages/core/src/errors.ts (ProtocolError), packages/core/src/testing/canaries.ts.
- Build core first: `pnpm --filter @agent-hangar/core build` (tsc -b also does it).

REQUIRED READING (only these):
- docs/spec/03-interfaces.md § "3. Agent runtime protocol" (transport paragraph, TurnRequest, AgentEvent) and § "6. Secrets service" (shape patterns + replacement token)
- docs/spec/06-testing.md § "2. Unit tests" (`packages/agent-runtime` block) and § "6. CI pipeline" item 7
- packages/core/src/agent-protocol/ndjson.ts, schemas.ts (the codec and schemas you wrap), packages/core/src/secrets/types.ts
- apps/worker/vitest.config.ts (mirror how W0 resolves @agent-hangar/core in tests)
- CLAUDE.md

TASK
Scaffold the runtime package: test config, protocol adapters over the core NDJSON codec, runtime redactor, version constant, CLI dispatcher with --version, esbuild bundle config + bundle check. Build the bundle at the end of this task to prove the tree-shaking strategy works.

DELIVERABLES

1. `packages/agent-runtime/package.json` — keep deps unchanged. Set `"type": "module"`, `"bin": { "agent-runtime": "./dist/cli.js" }`, `"files": ["dist"]`, scripts: `"build": "tsc -b && node esbuild.config.mjs"`, `"check:bundle": "node scripts/check-bundle.mjs"`, `"test": "vitest run --coverage"`, `"test:watch": "vitest"`, `"lint": "eslint ."`, `"typecheck": "tsc -b"`. `vitest.config.ts`: `environment: 'node'`, `coverage: { provider: 'v8', include: ['src/**'], exclude: ['src/bin.ts', '**/*.test.ts'], thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 } }`, `testTimeout: 20000` (git-backed tests later).

2. `src/version.ts`:
   ```ts
   declare const __AGENT_RUNTIME_VERSION__: string | undefined;
   /** Version string baked in by esbuild (`define`); falls back for tests/dev. */
   export const RUNTIME_VERSION: string =
     typeof __AGENT_RUNTIME_VERSION__ === 'string' ? __AGENT_RUNTIME_VERSION__ : '0.0.0-dev';
   ```
   Test both branches: default import → `'0.0.0-dev'`; `vi.stubGlobal('__AGENT_RUNTIME_VERSION__', '1.2.3')` + `vi.resetModules()` + dynamic import → `'1.2.3'`.

3. `src/redact.ts`:
   - `export const REDACTED = '[REDACTED]'`.
   - `export interface RuntimeRedactor { redactText(text: string): string; redactEvent(event: AgentEvent): AgentEvent }`.
   - `export function createRuntimeRedactor(opts: { values?: readonly (string | undefined)[] } = {}): RuntimeRedactor` — exact values: drop undefined/empty/shorter than 8 chars, sort by length desc, replace all occurrences (split/join, not RegExp, to avoid escaping bugs); then every pattern in `SECRET_SHAPE_PATTERNS` (use a fresh `new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g')` per call so shared lastIndex state never leaks). `redactEvent` returns a new object with these fields redacted: `prepare.progress.message`, `assistant.delta.text`, `assistant.message.text`, `tool.call.args` (JSON.stringify → redact → JSON.parse; if the parse fails return the redacted string), `tool.output.delta.text`, `turn.completed.finalMessage`, `turn.failed.error.message`; all other variants returned unchanged (same reference is fine).
   - Tests: each shape pattern (use `GITHUB_CANARY`, `OPENAI_CANARY`, a `github_pat_…` sample, `sk-proj-…`, `Authorization: Bearer xyz…`); exact value inside a URL and inside JSON; longest-first (value A contains value B); idempotent (`redact(redact(x)) === redact(x)`); no false positive on a 40-hex sha; every AgentEvent variant through `redactEvent` (text variants changed, others identical); args object containing a canary; args that are a plain string; regex lastIndex isolation (call twice with the same input → same output).

4. `src/protocol.ts`:
   - `export async function readTurnRequest(stdin: AsyncIterable<Uint8Array>): Promise<TurnRequest>` — `for await (const item of parseNdjsonStream(stdin, turnRequestSchema))`: first item that is a TurnRequest → return it; if the first item is the codec's `protocol.error` shape → throw `new ProtocolError('invalid TurnRequest: <reason>')`; stream ends without an item → `ProtocolError('no TurnRequest received on stdin')`. (Check how W0's parser surfaces invalid lines — it yields `{ type: 'protocol.error', line, reason }` values instead of throwing; branch on that shape.)
   - `export interface EventWriter { emit(event: AgentEvent): Promise<void>; lastEmittedAt(): number }` and `export function createEventWriter(stdout: NodeJS.WritableStream, redactor: RuntimeRedactor, now: () => number = Date.now): EventWriter` — `emit` serialises `encodeLine(redactor.redactEvent(event))`; if `write()` returns false await `'drain'`; serialise emits (a promise chain) so two concurrent `emit`s never interleave; updates `lastEmittedAt`.
   - `export function createDiagnostics(stderr: NodeJS.WritableStream, redactor: RuntimeRedactor): (message: string) => void` — writes `redactText(message) + '\n'`; swallows write errors (stderr is best-effort).
   - Tests: valid request from a single chunk; request split across chunks; leading invalid line → ProtocolError with reason; empty stdin → ProtocolError; writer emits one line per event ending in `\n` with redaction applied (canary in assistant.delta → `[REDACTED]` on the wire); backpressure (Writable with highWaterMark 1 → second emit waits for drain); concurrent emits keep order; diagnostics redact and append newline.

5. `src/cli.ts`:
   - `export interface CliIo { stdin: AsyncIterable<Uint8Array>; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream; env: Readonly<Record<string, string | undefined>>; signals: { onSigint(handler: () => void): () => void } /* returns unsubscribe */ ; cwd: string }`.
   - `export const EXIT = { ok: 0, runtimeFailure: 1, protocolError: 2, usage: 64, notImplemented: 70 } as const`.
   - `export async function runCli(argv: readonly string[], io: CliIo): Promise<number>`: `--version` | `-v` → `stdout.write(RUNTIME_VERSION + '\n')` → 0; `turn` → for now `stderr.write('turn: not implemented yet\n')` → `EXIT.notImplemented` (replaced in 1D.4); anything else (incl. empty argv) → usage text on stderr (`usage: cli.js turn | --version`) → `EXIT.usage`.
   - `export function createNodeIo(): CliIo` — process stdin/stdout/stderr/env/cwd, `onSigint` via `process.on('SIGINT', …)` returning `process.off`. Unit-test it by calling it and checking the shape (no side effects at creation).
   - `src/bin.ts` (excluded from coverage, ≤ 3 lines): `import { createNodeIo, runCli } from './cli.js'; process.exitCode = await runCli(process.argv.slice(2), createNodeIo());`
   - `src/index.ts` — export the public surface for tests/other tooling (`runCli`, `createRuntimeRedactor`, protocol functions, `RUNTIME_VERSION`); keep it a pure barrel (excluded from coverage only if W0's convention excludes barrels — otherwise import it in a test).
   - Tests: `--version` prints version; `-v` alias; unknown command → usage + 64; empty argv → 64; `turn` → 70 (temporary test, delete in 1D.4).

6. `esbuild.config.mjs` (ESM, runs with plain node):
   ```js
   import { build } from 'esbuild';
   import { chmod, readFile } from 'node:fs/promises';
   const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
   /** Marks every module under packages/core as side-effect-free so unused host-only imports (prisma, pg, pino, bullmq, ioredis, dockerode) are tree-shaken out of the runtime bundle. */
   const coreSideEffectFree = {
     name: 'core-side-effect-free',
     setup(b) {
       b.onResolve({ filter: /.*/ }, async (args) => {
         if (args.pluginData?.ahResolved) return undefined;
         const fromCore = args.importer.includes('/packages/core/') || args.path.startsWith('@agent-hangar/core');
         if (!fromCore) return undefined;
         const r = await b.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: { ahResolved: true } });
         if (r.errors.length > 0) return { errors: r.errors };
         return { path: r.path, external: r.external, sideEffects: false };
       });
     },
   };
   await build({
     entryPoints: ['src/bin.ts'], outfile: 'dist/cli.js', bundle: true, platform: 'node', target: 'node24',
     format: 'esm', sourcemap: true, minify: false, legalComments: 'none', treeShaking: true,
     banner: { js: "#!/usr/bin/env node\nimport { createRequire as __ahCreateRequire } from 'node:module';\nconst require = __ahCreateRequire(import.meta.url);" },
     define: { __AGENT_RUNTIME_VERSION__: JSON.stringify(pkg.version) },
     plugins: [coreSideEffectFree],
     logLevel: 'info',
   });
   await chmod('dist/cli.js', 0o755);
   ```
   (`external` is intentionally empty: the container has no node_modules.) If esbuild's `onResolve` result shape differs in the installed version, adapt — the intent is: resolved path + `sideEffects: false` for every module reached through packages/core.

7. `scripts/check-bundle.mjs` — (a) `dist/cli.js` exists and `statSync().size < 2 * 1024 * 1024`; (b) the bundle text contains none of the markers `@prisma/client`, `PrismaClient`, `from "pg"`, `pino`, `bullmq`, `ioredis`, `dockerode` (grep with word boundaries; print which marker was found); (c) copy `dist/cli.js` + `.map` into a fresh `mkdtemp` directory and run `node cli.js --version` there with `env: { PATH: process.env.PATH }` — stdout must equal `pkg.version + '\n'`, exit 0 (proves self-containment: no node_modules reachable). Exit 1 with a clear message on any failure; print the size in KB on success.

8. Build now: `pnpm --filter @agent-hangar/agent-runtime build && pnpm --filter @agent-hangar/agent-runtime check:bundle`. If the marker check fails because a host-only module survived tree-shaking, first inspect with `esbuild --metafile` (`metafile: true` + write `dist/meta.json`, then find the import chain); fix within esbuild.config.mjs (plugin coverage). Only if the chain cannot be cut from here (e.g. a core file with genuine top-level side effects), stop and report to the orchestrator with `contractChangeRequests: ['packages/core/<file>: <what needs to change and why>']` — do not edit packages/core.

Constraints:
- Follow /bymax-workflow:standards: TS strict, JSDoc on every export + file header, English, no enum, no suppression, test headers + it() comments.
- No new dependencies; owned paths only (packages/agent-runtime/**).
- Never log or print env values; the redactor exists precisely so tests can prove that.

Verification:
- `pnpm --filter @agent-hangar/agent-runtime test` — green, 100 % on src/** (bin.ts excluded)
- `pnpm --filter @agent-hangar/agent-runtime build && pnpm --filter @agent-hangar/agent-runtime check:bundle` — prints the size, exits 0
- `node packages/agent-runtime/dist/cli.js --version` — prints the package version
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-1d-agent-runtime.md (task index row and task block)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/5 tasks`)
4. Append a completion log entry at the end of the file: `- 1D.1 ✅ <YYYY-MM-DD> — <one-line summary>`
5. Commit: `feat(agent-runtime): scaffold protocol adapters, redaction, cli and bundle`
````

---

## Task 1D.2 — Tools: path confinement, `run_shell`, `read_file`, `write_file`, `list_dir`, registry + JSON schemas, child env scrubbing

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** L · **Depends on:** 1D.1

**Description.** Implement the four tools the model can call, the path-confinement helper they share, the child-environment builder that scrubs secrets and wires `GIT_ASKPASS`/`AH_GIT_TOKEN_FILE`, and the registry that exposes strict-mode JSON schemas (`ToolDefinition[]`) plus a single `execute()` entry point with Zod-validated args. Every tool is tested against a temp directory acting as `/workspace`.

**Acceptance criteria**
- [ ] `tools/paths.ts` `resolveInsideWorkspace(root, p)` accepts relative and in-root absolute paths, rejects `../` escapes, absolute paths outside root, and symlink escapes (realpath of the deepest existing ancestor), returning the absolute path
- [ ] `child-env.ts` `createChildEnv(parentEnv, { tokenFile? })` removes `GITHUB_TOKEN` and `OPENAI_API_KEY`, keeps `PATH`/`HOME`/everything else, sets `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` (existing or `/opt/agent-runtime/askpass.sh`), `AH_GIT_TOKEN_FILE` when given; `materializeGitToken(env, dir)` writes the token 0600 and returns the path or null
- [ ] `run_shell`: `bash -lc` in `/workspace` (or confined `cwd`), detached process group, timeout → `SIGKILL` the group → `TIMED_OUT`, abort → `SIGTERM` then `SIGKILL` after 2 s, interleaved output streamed via `onOutput`, truncated to `maxOutputBytes` with `\n[truncated: N bytes total]`, exit code reported, child env scrubbed
- [ ] `read_file` (numbered lines, `startLine`/`endLine`, truncation), `write_file` (mkdir -p, byte count, no write through escaping symlink), `list_dir` (`.gitignore`-aware via `git ls-files --cached --others --exclude-standard` when inside a git repo, readdir otherwise; `depth` ≤ 5 default 1; entry cap 500 with note)
- [ ] `tools/index.ts`: `TOOL_DEFINITIONS` derived from Zod schemas with `z.toJSONSchema` (strict-mode compatible: `additionalProperties: false`, every key in `required`, optionals nullable); `createToolExecutor(ctx)` → `execute(name, rawArgs, hooks)` never throws (invalid args / unknown tool → FAILED result)
- [ ] 100 % coverage on `src/tools/**` and `src/child-env.ts`

**Files to create**
`packages/agent-runtime/src/{child-env.ts, child-env.test.ts, tools/{paths.ts, paths.test.ts, result.ts, schemas.ts, schemas.test.ts, run-shell.ts, run-shell.test.ts, read-file.ts, read-file.test.ts, write-file.ts, write-file.test.ts, list-dir.ts, list-dir.test.ts, index.ts, index.test.ts}}`.

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 (node:child_process, node:fs/promises, node:path — no execa/globby) · zod 4 (`z.toJSONSchema` available) · @agent-hangar/core types · Vitest 4.
Branch feat/w1d-agent-runtime (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-D — Task 1D.2 of 5 (MIDDLE)

PRECONDITIONS
- Task 1D.1 done (vitest config, redact.ts, protocol.ts, cli.ts, bundle).
- Contract: packages/core/src/model/types.ts (ToolDefinition), packages/core/src/agent-protocol/schemas.ts (toolNameSchema, `tool.result` status union 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT'), packages/core/src/testing/canaries.ts.
- `git` and `bash` are installed on the dev machine (tests spawn them).

REQUIRED READING (only these):
- docs/spec/03-interfaces.md § "3. Agent runtime protocol" → the "Tools exposed to the model" table and the secrets paragraph
- docs/spec/06-testing.md § "2. Unit tests" (`packages/agent-runtime` first bullet)
- packages/core/src/model/types.ts (ToolDefinition: JSON Schema draft 2020-12, strict mode requested)
- infra/workspace/askpass.sh (W0 version; W1-B extends it to read AH_GIT_TOKEN_FILE — you only need the contract: Username prompt → x-access-token, else token from AH_GIT_TOKEN_FILE or GITHUB_TOKEN)

TASK
Implement the tool layer: shared path confinement, scrubbed child env with token file, the four tools, Zod schemas → strict JSON schemas, and an executor that never throws. Everything tested against a temp dir.

DELIVERABLES

1. `src/tools/result.ts` — `export interface ToolResult { output: string; exitCode: number | null; bytes: number; status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' }` and helpers `failure(message)` (`{ output: message, exitCode: null, bytes: Buffer.byteLength(message), status: 'FAILED' }`) and `truncateOutput(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean }` — if `Buffer.byteLength(text) > maxBytes`: keep the first `maxBytes` bytes cut at a UTF-8 boundary (use `Buffer.from(text).subarray(0, max).toString()` then strip a trailing replacement char) and append `\n[truncated: <total> bytes total]`; `bytes` is always the untruncated size.

2. `src/tools/paths.ts` — `export class PathEscapeError extends Error { readonly code = 'path_escape' }`; `export async function resolveInsideWorkspace(root: string, userPath: string): Promise<string>`: `abs = path.resolve(root, userPath)`; `rel = path.relative(root, abs)`; reject if `rel.startsWith('..')` or `path.isAbsolute(rel)`; then walk up from `abs` to the deepest existing ancestor, `fs.realpath` it, and require `realAncestor === realRoot || realAncestor.startsWith(realRoot + path.sep)` (realRoot = realpath(root)); return `abs` (not the realpath — callers create missing files under the logical path). Also `export function displayPath(root, abs)` → relative path with forward slashes for messages.
   Tests (tmp root via `fs.mkdtemp`): `'src/a.ts'` ok; `'./x'` ok; `'/…/root/sub'` absolute inside ok; `'../outside'` rejects; `'/etc/passwd'` rejects; `'sub/../../x'` rejects; symlink `root/link → /tmp` then `'link/file'` rejects; symlink inside root → ok; missing deep path `'new/dir/file'` ok (ancestor check on `root`); root with symlinked tmp (macOS `/var` → `/private/var`) ok.

3. `src/child-env.ts` — `export const DEFAULT_ASKPASS = '/opt/agent-runtime/askpass.sh'`, `export const SCRUBBED_KEYS = ['GITHUB_TOKEN', 'OPENAI_API_KEY'] as const`; `export function createChildEnv(parent: Readonly<Record<string, string | undefined>>, opts: { tokenFile?: string | null } = {}): Record<string, string>` — copy defined entries, delete scrubbed keys, set `GIT_TERMINAL_PROMPT: '0'`, `GIT_ASKPASS: parent.GIT_ASKPASS ?? DEFAULT_ASKPASS`, `AH_GIT_TOKEN_FILE` only when `opts.tokenFile`; `export async function materializeGitToken(parent, dir: string): Promise<string | null>` — if `parent.GITHUB_TOKEN` non-empty: `mkdir -p dir` (0700), write `<dir>/git-token` with mode 0o600 (`writeFile(path, token, { mode: 0o600 })` then `chmod` to be safe), return path; else null. `export async function removeGitToken(path: string | null)` — `rm -f` semantics.
   Tests: scrubbed keys absent; PATH/HOME/other keys kept; undefined values dropped; GIT_ASKPASS default vs preserved; GIT_TERMINAL_PROMPT set; token file written with mode 0600 containing exactly the canary (`GITHUB_CANARY`), returned path set as AH_GIT_TOKEN_FILE; no token → null and no variable; removeGitToken on missing path resolves.

4. `src/tools/schemas.ts` — Zod (strict-mode-compatible shapes: `.strict()` objects, optionals expressed as `.nullable()` and present in the object):
   `runShellArgs = z.object({ command: z.string().min(1), cwd: z.string().nullable(), timeoutMs: z.number().int().positive().nullable() }).strict()`,
   `readFileArgs = z.object({ path: z.string().min(1), startLine: z.number().int().positive().nullable(), endLine: z.number().int().positive().nullable() }).strict()`,
   `writeFileArgs = z.object({ path: z.string().min(1), content: z.string() }).strict()`,
   `listDirArgs = z.object({ path: z.string().nullable(), depth: z.number().int().min(1).max(5).nullable() }).strict()`;
   `export const TOOL_SCHEMAS = { run_shell: runShellArgs, read_file: …, write_file: …, list_dir: … } as const` (keys = ToolName); `export function toToolDefinition(name: ToolName, description: string, schema): ToolDefinition` using `z.toJSONSchema(schema, { target: 'draft-2020-12' })` and post-asserting `additionalProperties === false` and `required` lists every property (throw at module init otherwise — tests cover by calling the function with a non-strict schema). Provide the four descriptions (one paragraph each, telling the model: run_shell runs bash -lc in /workspace with a timeout, output truncated; read_file numbered lines with optional range; write_file creates parents, returns bytes; list_dir respects .gitignore, depth ≤ 5, capped at 500 entries). Export `TOOL_DEFINITIONS: readonly ToolDefinition[]` in `tools/index.ts` (see 9).
   Tests: each schema accepts the spec example and rejects extra keys / wrong types; JSON schema has `additionalProperties:false` and full `required`; nullable optionals encoded as `["string","null"]`-style (assert `anyOf`/`type` array as zod 4 emits); `toToolDefinition` throws for a non-strict schema.

5. `src/tools/run-shell.ts` — `export interface RunShellContext { workspaceRoot: string; env: Record<string, string> /* already scrubbed */; defaultTimeoutMs: number; maxOutputBytes: number; spawn?: typeof import('node:child_process').spawn; setTimeoutFn?: typeof setTimeout; clearTimeoutFn?: typeof clearTimeout }`, `export interface RunShellHooks { onOutput?(stream: 'stdout' | 'stderr', text: string): void; signal?: AbortSignal }`, `export async function runShell(args: RunShellArgs, ctx: RunShellContext, hooks: RunShellHooks = {}): Promise<ToolResult & { command: string }>`:
   - `cwd = args.cwd ? await resolveInsideWorkspace(root, args.cwd) : root` (PathEscapeError → `failure('cwd escapes /workspace')`); cwd must be an existing directory else FAILED.
   - `child = spawn('bash', ['-lc', args.command], { cwd, env: ctx.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`; decode stdout/stderr as UTF-8 (`StringDecoder`), call `onOutput` per chunk, append to one interleaved buffer in arrival order, count total bytes.
   - timeout = `args.timeoutMs ?? ctx.defaultTimeoutMs`; on fire: `process.kill(-child.pid, 'SIGKILL')` (ignore ESRCH), mark `TIMED_OUT`.
   - `hooks.signal` abort: `process.kill(-child.pid, 'SIGTERM')`, then after 2 000 ms `SIGKILL` if still running; status FAILED, output gets `\n[cancelled]`.
   - on `close(code, signal)`: `exitCode = code` (null when killed), status = TIMED_OUT if timed out else `code === 0 ? 'SUCCEEDED' : 'FAILED'`; output = `truncateOutput(buffer, ctx.maxOutputBytes).text`; `bytes` = total. `spawn` error (ENOENT) → FAILED with message.
   - Return includes `command: args.command` (git-events uses it).
   Tests (real bash, tmp root): `echo hi` → SUCCEEDED, output "hi\n", exit 0; `exit 3` → FAILED exit 3; stderr interleaved (`echo a; echo b >&2`) and onOutput called with both streams; `pwd` in cwd `sub` → path; cwd `../` → FAILED path_escape; `sleep 5` with timeoutMs 200 → TIMED_OUT, exitCode null, finishes < 2 s; child of the shell also killed (`bash -c 'sleep 5 & wait'` — after timeout `pgrep -f` / `ps` shows no sleep; or assert `close` arrives quickly); abort signal → FAILED with `[cancelled]`; output > maxOutputBytes (`head -c 100000 /dev/zero | tr '\0' a`) → truncated note with total; env scrubbed: `printenv GITHUB_TOKEN` → empty output, exit 1; `printenv GIT_ASKPASS` → askpass path; `printenv AH_GIT_TOKEN_FILE` → the file; `cat "$AH_GIT_TOKEN_FILE"` → canary (demonstrates the contract; the file is 0600 and on tmpfs in production); spawn failure (inject spawn that emits `error`) → FAILED.

6. `src/tools/read-file.ts` — `readFile(args, ctx: { workspaceRoot; maxOutputBytes })`: resolve path; not found → FAILED "file not found: <rel>"; directory → FAILED "is a directory"; read UTF-8; lines 1-based; `startLine`/`endLine` clamp to [1, n] (`endLine < startLine` → FAILED); output `${lineNo}\t${line}` joined by `\n`; truncate with `truncateOutput`; `bytes` = file size; SUCCEEDED exit 0. Tests: whole file numbered; range; clamped range; inverted range FAILED; missing FAILED; directory FAILED; escape FAILED; truncation note; empty file → "" with exit 0.

7. `src/tools/write-file.ts` — `writeFile(args, ctx)`: resolve path; `mkdir -p dirname`; if the target exists and is a symlink, resolve it through `resolveInsideWorkspace(root, realpath)` again (escape → FAILED); write UTF-8; output `wrote <bytes> bytes to <rel>`; SUCCEEDED exit 0. Tests: new nested file created; overwrite; byte count of multibyte content; escape via `../`; escape via symlink target outside root; writing to a path whose parent is a file → FAILED (ENOTDIR message).

8. `src/tools/list-dir.ts` — `listDir(args, ctx: { workspaceRoot; maxOutputBytes; maxEntries?: 500; spawn? })`: base = resolve(`args.path ?? '.'`); not a directory → FAILED; depth = `args.depth ?? 1`; if `git rev-parse --is-inside-work-tree` succeeds at `base` (spawn `git`, cwd base, scrubbed-agnostic env) → run `git ls-files --cached --others --exclude-standard -z -- .` in base, split on `\0`, keep entries whose path depth ≤ depth, synthesize intermediate directories (with trailing `/`), dedupe, sort; else `fs.readdir` recursively to depth, skipping `.git` always; cap at `maxEntries` with a final line `[… N more entries omitted]`; output one entry per line relative to `base`; truncate; SUCCEEDED. Tests: plain dir depth 1 (dirs with `/`); depth 2; `.git` hidden; git repo with `.gitignore` (ignored file absent, untracked-unignored present); entry cap note (create 600 files); invalid path FAILED; escape FAILED; `depth` > 5 rejected by schema (tested in schemas) and clamped defensively in code.

9. `src/tools/index.ts` — `export const TOOL_DEFINITIONS: readonly ToolDefinition[]` (4 entries, order run_shell, read_file, write_file, list_dir); `export interface ToolExecutorContext { workspaceRoot: string; childEnv: Record<string, string>; toolTimeoutMs: number; maxToolOutputBytes: number }`; `export interface ToolExecutor { execute(name: string, rawArgs: unknown, hooks?: RunShellHooks): Promise<ToolResult & { command?: string }> }`; `export function createToolExecutor(ctx: ToolExecutorContext): ToolExecutor` — unknown name → `failure('unknown tool: <name>')`; `TOOL_SCHEMAS[name].safeParse(rawArgs)` failure → `failure('invalid arguments for <name>: <zod issues joined>')`; dispatch; wrap any thrown error into `failure(err.message)` (never throws). Tests: dispatch to each tool (spy), unknown tool, invalid args, thrown error wrapped, `TOOL_DEFINITIONS` names match `toolNameSchema` options.

Constraints:
- Follow /bymax-workflow:standards (JSDoc + headers, English, no enum, no suppression, it() comments). Keep functions ≤ 50 lines; extract helpers (`buildTree`, `clampRange`, `killGroup`).
- Never put secret values into ToolResult messages; tests assert no canary in outputs of failure paths.
- No new dependencies; owned paths only.
- Tests must clean their temp dirs (`afterEach` rm -rf) and never touch the real filesystem outside `os.tmpdir()`.

Verification:
- `pnpm --filter @agent-hangar/agent-runtime test` — green, 100 % on src/**
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1d-agent-runtime.md; append `- 1D.2 ✅ <date> — <summary>`; commit `feat(agent-runtime): add confined tools, scrubbed child env and tool registry`.
````

---

## Task 1D.3 — `prepare.ts` (clone/checkout/expectedHeadSha) + `git-events.ts` (push detection)

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** M · **Depends on:** 1D.2

**Description.** Implement the workspace preparation step (validate the repo URL, clone the base branch at full depth with `GIT_ASKPASS` + token file, fetch/checkout or create the work branch, compare HEAD with `expectedHeadSha`, emit `prepare.progress`/`prepare.done`) and the `git.pushed` detection used by the loop after `run_shell`. Tested against local bare repositories created with `git init --bare`.

**Acceptance criteria**
- [ ] `assertGithubHttpsUrl(url)` accepts `https://github.com/<owner>/<repo>[.git]` and rejects credentials (`user:pass@`), other hosts, `ssh://`, `git@`, query/fragment
- [ ] `prepare(repo, deps)`: `clone: true` → clone base (no `--depth`), then `workBranch`: exists on origin → fetch + `checkout -B workBranch origin/workBranch`; missing → `checkout -b workBranch` from base; `workBranch === baseBranch` → stay; `clone: false` → require an existing repo in `/workspace` and skip cloning; emits `prepare.progress` messages and one `prepare.done { headSha, branch }`; `expectedHeadSha` mismatch → a `prepare.progress` warning (not a failure)
- [ ] git runs with the scrubbed child env (`createChildEnv` + token file), never with the token in the URL
- [ ] `looksLikeGitPush({ command, output, exitCode })` + `resolveGitHead(git, cwd)` → `{ branch, sha }`; the loop emits `git.pushed` only on success
- [ ] 100 % coverage on `prepare.ts`, `git.ts`, `git-events.ts`

**Files to create**
`packages/agent-runtime/src/{git.ts, git.test.ts, prepare.ts, prepare.test.ts, git-events.ts, git-events.test.ts, testing/bare-repo.ts}`.

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 (node:child_process spawn for git) · @agent-hangar/core protocol types · Vitest 4. `git` ≥ 2.30 on the dev machine.
Branch feat/w1d-agent-runtime (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-D — Task 1D.3 of 5 (MIDDLE)

PRECONDITIONS
- Tasks 1D.1–1D.2 done (protocol writer, redactor, child-env with token file, tools).
- Contract: packages/core/src/agent-protocol/schemas.ts (`TurnRequest['repo']`, `TurnRequest['prepare']`, `prepare.progress`, `prepare.done`, `git.pushed` event shapes).

REQUIRED READING (only these):
- docs/spec/03-interfaces.md § "3. Agent runtime protocol" (TurnRequest.repo / prepare fields, prepare.* and git.pushed events, the "Loop" paragraph)
- docs/spec/04-flows.md § "(a)" steps 40–41 and § "(b)" (restore: `expectedHeadSha`, workBranch semantics — read only the paragraphs that mention them)
- docs/spec/06-testing.md § "2. Unit tests" (`packages/agent-runtime` bullets: prepare against a bare repo, git.pushed detection)
- src/child-env.ts, src/protocol.ts (your own, from 1D.1–1D.2)

TASK
Implement repository preparation and git push detection with a small injectable git runner, tested end-to-end against local bare repos.

DELIVERABLES

1. `src/git.ts` — `export interface GitRunner { run(args: readonly string[], opts: { cwd: string; env: Record<string, string>; timeoutMs?: number }): Promise<{ code: number | null; stdout: string; stderr: string }> }`; `export function createGitRunner(spawnFn = spawn): GitRunner` (spawn `git`, collect stdout/stderr, default timeout 10 min → SIGKILL, never throws on non-zero — returns the code; spawn error → code null + stderr message). `export class GitError extends Error { constructor(message, readonly code: number | null, readonly stderr: string) }` and `export async function gitOrThrow(git, args, opts): Promise<string>` (trimmed stdout; non-zero → GitError carrying the first 500 chars of stderr; the URL is credential-free and askpass output never reaches stderr, and every message is redacted again by the event writer before it hits stdout). Tests: success stdout; non-zero code; spawn error; timeout (fake `sleep`-like spawn); gitOrThrow throws GitError with stderr.

2. `src/testing/bare-repo.ts` (test helper, included in coverage — keep it small and test it): `export async function createBareRepoWithSeed(opts: { branch?: 'main'; files?: Record<string, string>; extraBranches?: string[] }): Promise<{ bareDir: string; url: string /* file:// URL */; headSha: string; cleanup(): Promise<void> }>` — `git init --bare`, then a scratch clone in which files are committed (`-c user.name=test -c user.email=test@example.com`) and pushed to `main` (+ extra branches created from main with one more empty commit each); returns the seed sha. Test it by cloning the URL and reading the log.

3. `src/prepare.ts`
   - `export function assertGithubHttpsUrl(url: string): void` — `new URL(url)`; require `protocol === 'https:'`, `hostname === 'github.com'`, `username === '' && password === ''`, no `search`/`hash`, pathname `/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/`; otherwise throw `PrepareError('repository URL must be https://github.com/<owner>/<repo> without credentials')`. `export class PrepareError extends Error { readonly code = 'prepare' }`.
   - `export interface PrepareDeps { workspaceRoot: string; git: GitRunner; env: Record<string, string> /* child env from createChildEnv */; emit: (e: AgentEvent) => Promise<void>; urlPolicy?: 'github-https' | 'any' /* default 'github-https'; tests use 'any' for file:// */ }`.
   - `export async function prepare(repo: TurnRequest['repo'], prepareOpts: TurnRequest['prepare'], deps: PrepareDeps): Promise<{ headSha: string; branch: string }>`:
     1. if `urlPolicy === 'github-https'` → `assertGithubHttpsUrl(repo.url)`.
     2. `isRepo = (await git.run(['rev-parse','--is-inside-work-tree'], { cwd: root, env })).code === 0`.
     3. if `prepareOpts.clone`: if `isRepo` → emit progress `Workspace already has a repository; fetching…` and `gitOrThrow(['fetch','origin','--prune'])`; else: root must be empty or non-existent (create it) → emit `Cloning <url> (branch <baseBranch>)…` → `gitOrThrow(['clone','--branch', repo.baseBranch, '--', repo.url, '.'], { cwd: root })` (full depth; no `--depth`). Else (`clone: false`): if `!isRepo` → throw `PrepareError('/workspace has no repository and prepare.clone is false')`.
     4. work branch: if `repo.workBranch !== repo.baseBranch`: `lsRemote = git.run(['ls-remote','--heads','origin', repo.workBranch])`; if stdout non-empty → `gitOrThrow(['fetch','origin', `${repo.workBranch}:refs/remotes/origin/${repo.workBranch}`])` then `gitOrThrow(['checkout','-B', repo.workBranch, `origin/${repo.workBranch}`])`, progress `Checked out <workBranch> at <sha7>`; else `gitOrThrow(['checkout','-b', repo.workBranch])` (from the base HEAD), progress `Created <workBranch> from <baseBranch> at <sha7>`. If equal → `gitOrThrow(['checkout', repo.baseBranch])`, progress `On <baseBranch> at <sha7>`.
     5. `headSha = gitOrThrow(['rev-parse','HEAD'])`; `branch = gitOrThrow(['rev-parse','--abbrev-ref','HEAD'])`.
     6. if `repo.expectedHeadSha && repo.expectedHeadSha !== headSha` → emit progress `Warning: expected HEAD <exp7> but found <head7>; the branch moved since the last snapshot`.
     7. emit `prepare.done { headSha, branch }`; return.
     Git failures (GitError) propagate as `PrepareError(`git ${args[0]} failed: ${stderr-first-line}`)` — the loop maps it to `turn.failed { code: 'prepare' }`.
   - Tests (real git, bare repo helper, `urlPolicy: 'any'`, collecting emitted events): clone base + missing workBranch → created, events in order (`Cloning…`, `Created…`, `prepare.done` with sha = seed sha, branch = workBranch); workBranch exists on origin (extraBranches) → checked out at its sha, `prepare.done.branch` = workBranch; `workBranch === baseBranch`; `expectedHeadSha` mismatch → warning progress present, still `prepare.done`; `expectedHeadSha` match → no warning; `clone: false` on a prepared root → no clone, fetch not called, `prepare.done`; `clone: false` on empty root → PrepareError; `clone: true` on an already-cloned root → fetch path; non-existent base branch → PrepareError with `git clone failed`; URL policy: github https accepted; `https://user:tok@github.com/a/b` rejected; `http://github.com/a/b` rejected; `https://gitlab.com/a/b` rejected; `git@github.com:a/b.git` rejected; `?x=1` rejected; the env passed to git has no GITHUB_TOKEN and has GIT_ASKPASS (inspect a spy GitRunner wrapper around the real one).

4. `src/git-events.ts` — `export function looksLikeGitPush(input: { command: string; output: string; exitCode: number | null }): boolean` → `exitCode === 0 && (/(^|[;&|]\s*)git\s+([^;&|]*\s)?push\b/.test(command) || /^To (https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/m.test(output) && /\s->\s/.test(output))`; `export async function resolveGitHead(git: GitRunner, cwd: string, env): Promise<{ branch: string; sha: string } | null>` — `rev-parse --abbrev-ref HEAD` + `rev-parse HEAD`, null if either fails. Tests: `git push`; `git push -u origin feat`; `cd x && git push`; `git pushover` not matched; non-zero exit not matched; output-based detection (`To https://github.com/a/b.git\n   abc..def  main -> main`); `Everything up-to-date` with command match → true; resolveGitHead on a repo and on a non-repo (null).

Constraints:
- Follow /bymax-workflow:standards (JSDoc + headers, English, no enum, no suppression, it() comments). Functions ≤ 50 lines — split prepare into `cloneOrFetch`, `checkoutWorkBranch`, `verifyHead`.
- Never place credentials in URLs or messages; never log env; no network in tests.
- No new dependencies; owned paths only.

Verification:
- `pnpm --filter @agent-hangar/agent-runtime test` — green, 100 % on src/**
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1d-agent-runtime.md; append `- 1D.3 ✅ <date> — <summary>`; commit `feat(agent-runtime): add repository preparation and git push detection`.
````

---

## Task 1D.4 — `loop.ts` step loop + provider seam + `turn` command wiring (cancel, heartbeat, limits, retries)

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** L · **Depends on:** 1D.2, 1D.3

**Description.** Implement the model ↔ tools loop exactly as spec 03 §3 "Loop" and spec 04 (a) edge cases: per step `provider.stream()` → collect deltas and tool calls → execute tools sequentially emitting `tool.call` / `tool.output.delta` / `tool.result` → append `tool_call` + `tool_result` items → stop when no tool calls, or on `maxSteps` / `maxTurnMs` (`stoppedBy: 'limit'` with an explanatory `assistant.message`), cancellation via `AbortSignal` (→ `turn.cancelled`), `rate_limit` retries (3× backoff), heartbeat every 10 s while idle, `git.pushed` after a successful push. Then wire the real `turn` command: read `TurnRequest`, build redactor/writer/diagnostics, resolve the provider (`fake` built-in; `openai` through the seam), materialize the git token, prepare, run the loop, clean up, map exit codes, SIGINT → abort.

**Acceptance criteria**
- [ ] `runTurnLoop(deps)` produces the event sequence of spec 03 §3 with exact ordering; `turn.completed` carries summed `usage`, `steps`, `finalMessage` (last assistant text) and `stoppedBy: 'limit'` when a limit stopped it
- [ ] Cancellation: abort before/during model stream or during a tool → `turn.cancelled`, nothing after it; `maxTurnMs` enforced between steps and as a deadline for the current stream; `rate_limit` error → retry up to 3 times (1 s/2 s/4 s, injected sleep) then `turn.failed { code: 'rate_limit' }`; other provider errors → `turn.failed { code }` immediately
- [ ] Every `tool.call` is followed by its `tool.result`; invalid tool args/unknown tool produce a FAILED `tool.result` and a `tool_result` item (the model sees the error); `git.pushed` emitted after a successful push
- [ ] `heartbeat` emitted only when no event was written in the last 10 s (fake timers); cleared at the end
- [ ] `provider.ts`: `fake` → `FakeAgentModelProvider` with built-in scripts (`fake-scripts.ts`) or `AGENT_FAKE_SCRIPT_JSON`; `openai` → injected factory or `ConfigError` explaining the seam; unknown → `ConfigError`
- [ ] `cli.ts turn`: exit 0 on completed/cancelled/failed-by-turn, 2 on protocol error, 1 on runtime exception (after emitting `turn.failed { code: 'runtime' }`); token file removed in `finally`; SIGINT handler unsubscribed
- [ ] 100 % coverage on `loop.ts`, `provider.ts`, `fake-scripts.ts`, `cli.ts`

**Files to create/modify**
`packages/agent-runtime/src/{loop.ts, loop.test.ts, provider.ts, provider.test.ts, fake-scripts.ts, fake-scripts.test.ts, turn.ts, turn.test.ts}`; modify `src/cli.ts` + `cli.test.ts` (replace the stub), `src/index.ts`.

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · @agent-hangar/core (AgentModelProvider, ModelEvent, ConversationItem, TurnRequest, AgentEvent, ConfigError) · FakeAgentModelProvider from @agent-hangar/core/testing · Vitest 4 with fake timers.
Branch feat/w1d-agent-runtime (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-D — Task 1D.4 of 5 (MIDDLE)

PRECONDITIONS
- Tasks 1D.1–1D.3 done (protocol, redact, tools + executor, child-env, prepare, git-events).
- Contract: packages/core/src/model/types.ts (AgentModelProvider.stream/listModels, ModelEvent variants, ConversationItem), packages/core/src/agent-protocol/schemas.ts (AgentEvent variants incl. `turn.completed.stoppedBy?: 'limit'`), packages/core/src/testing/fake-agent-model-provider.ts (script map keyed by last user message, `simpleAnswer`, `toolThenAnswer`, abort ends the stream silently), packages/core/src/errors.ts (ConfigError).

REQUIRED READING (only these):
- docs/spec/03-interfaces.md § "2. AgentModelProvider" (ModelEvent semantics: `tool_call` is emitted once args are complete; `response.done` carries usage; `error` has `retryable`) and § "3. Agent runtime protocol" (AgentEvent list, the "Loop" paragraph, exit-code semantics, cancellation sentence)
- docs/spec/04-flows.md § "(a)" loop block and "Edge cases" (OpenAI 401 / 429 retries / limits → stoppedBy 'limit' / cancel)
- docs/spec/06-testing.md § "2. Unit tests" (`packages/agent-runtime` second bullet) and § "4. Playwright E2E" table (the prompts the built-in fake scripts must answer: "list files and create NOTES.md", "show NOTES.md", "print date", the cancel spec's long `run_shell sleep 60`)
- packages/core/src/testing/fake-agent-model-provider.ts (exact constructor/script API)
- Your own src/protocol.ts, src/tools/index.ts, src/prepare.ts, src/git-events.ts, src/child-env.ts

TASK
Implement the turn loop, the provider seam with built-in fake scripts, and the real `turn` command; replace the 1D.1 stub.

DELIVERABLES

1. `src/loop.ts`
   - `export interface LoopDeps { request: TurnRequest; provider: AgentModelProvider; tools: ToolExecutor; toolDefinitions: readonly ToolDefinition[]; emit: (e: AgentEvent) => Promise<void>; lastEmittedAt: () => number; workspaceRoot: string; childEnv: Record<string, string>; git: GitRunner; signal: AbortSignal; now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; heartbeatMs?: number /* 10_000 */; setIntervalFn?; clearIntervalFn? }`.
   - `export type LoopOutcome = { kind: 'completed' } | { kind: 'cancelled' } | { kind: 'failed'; code: string }`.
   - `export async function runTurnLoop(deps: LoopDeps): Promise<LoopOutcome>`:
     ```
     startedAt = now(); items = [...request.items]; usage = {input:0, output:0}; seq = 0; finalMessage = ''; steps = 0
     heartbeat = setInterval(() => { if (now() - lastEmittedAt() >= heartbeatMs) void emit({type:'heartbeat', at: iso(now())}) }, heartbeatMs)
     try {
       for (step = 1; step <= limits.maxSteps; step++) {
         if (signal.aborted) return cancelled()
         if (now() - startedAt >= limits.maxTurnMs) return await stopForLimit('time')
         await emit({type:'step.started', step}); steps = step
         const res = await streamStep()      // see below; returns {text, toolCalls, usage, responseId} | {cancelled} | {failed, code}
         if cancelled → emit turn.cancelled; return
         if failed → emit turn.failed {code, message}; return {kind:'failed', code}
         usage += res.usage
         if (res.text) { await emit({type:'assistant.message', text}); items.push({role:'assistant', content: text}); finalMessage = text }
         if (res.toolCalls.length === 0) { await emit({type:'turn.completed', usage, steps, finalMessage}); return completed }
         for (const call of res.toolCalls) {
           if (signal.aborted) return cancelled()
           seq++; args = parseJson(call.arguments)  // invalid JSON → args = { _raw: call.arguments } and the executor returns FAILED via schema
           await emit({type:'tool.call', callId, name, args, seq})
           t0 = now(); result = await tools.execute(call.name, args, { signal, onOutput: (stream, text) => void emit({type:'tool.output.delta', callId, stream, text}) })
           await emit({type:'tool.result', callId, exitCode: result.exitCode, bytes: result.bytes, durationMs: now()-t0, status: result.status})
           items.push({type:'tool_call', callId, name, arguments: call.arguments}, {type:'tool_result', callId, output: result.output})
           if (call.name === 'run_shell' && result.command && looksLikeGitPush({command: result.command, output: result.output, exitCode: result.exitCode})) { head = await resolveGitHead(git, workspaceRoot, childEnv); if (head) await emit({type:'git.pushed', ...head}) }
           if (signal.aborted) return cancelled()
         }
       }
       return await stopForLimit('steps')
     } finally { clearInterval(heartbeat) }
     ```
     `stopForLimit(reason)`: emit `assistant.message` with text `Stopped after <steps> steps/<minutes> min (limit reached). Work so far: <finalMessage || 'no final message'>` → set finalMessage to that text → emit `turn.completed { usage, steps, finalMessage, stoppedBy: 'limit' }` → `{ kind: 'completed' }`.
     `streamStep()`: up to 4 attempts (1 + 3 retries): `for await (ev of provider.stream({ model, instructions, items, tools: toolDefinitions, signal }))`: `text.delta` → emit `assistant.delta` + append; `text.done` → text = ev.text (authoritative); `tool_call` → push; `tool_call.arguments.delta` → ignore (emitted for UIs by providers; the runtime waits for the complete `tool_call`); `response.done` → usage/responseId; `error` → if `code === 'rate_limit'` and attempts remain → `await sleep(backoffMs, signal)` (1000·2^(attempt-1)) and retry the whole step (discard partial text, emit nothing extra); else return `{ failed, code, message }`. If the stream ends because of abort (`signal.aborted` true after the loop, no response.done) → `{ cancelled }`. If the stream ends without `response.done` and not aborted → treat as `{ failed, code: 'unknown', message: 'model stream ended without response.done' }`. Provider throwing → `{ failed, code: 'unknown', message }`.
     Emitted `turn.failed.error.message` is the provider message (redaction happens in the writer).
   - Tests (FakeAgentModelProvider, real ToolExecutor on a tmp root, fake timers, collecting events via a recording writer; helper `eventTypes(events)`):
     - no tool calls → `[step.started, assistant.delta…, assistant.message, turn.completed]`, usage summed, finalMessage = text, no stoppedBy
     - tool then answer (`toolThenAnswer` with `write_file` NOTES.md) → exact order `step.started, tool.call(seq 1), tool.result(SUCCEEDED), step.started, assistant.delta, assistant.message, turn.completed`; `items` passed to the second stream contain `tool_call` + `tool_result`; file exists on disk
     - two tool calls in one step executed sequentially (seq 1, 2; second starts after first result — assert with timestamps from an injected `now`)
     - `run_shell` output streamed as `tool.output.delta` before `tool.result`
     - invalid args (tool_call with `arguments: '{"nope":1}'`) → `tool.result` FAILED and the `tool_result` output contains "invalid arguments"; non-JSON arguments → FAILED
     - unknown tool name → FAILED result, loop continues
     - maxSteps = 1 with a script that always calls a tool → `assistant.message` (limit text) + `turn.completed { stoppedBy: 'limit', steps: 1 }`
     - maxTurnMs exceeded between steps (advance injected now) → limit completion
     - cancel before start → `turn.cancelled` only; cancel during model stream (script with delayMs, abort mid-way) → `turn.cancelled`, no `turn.completed`; cancel during a long `run_shell sleep 30` → tool killed, `turn.cancelled` within the test timeout, nothing after it
     - rate_limit error twice then success → two sleeps (1000, 2000) and completion; four rate_limit errors → `turn.failed { code: 'rate_limit' }`; `auth` error → immediate `turn.failed { code: 'auth' }`; provider throws → `turn.failed { code: 'unknown' }`; stream without response.done → failed unknown
     - heartbeat: with a script delayMs 25 s, advancing fake timers by 10 s emits `heartbeat`; when events were emitted < 10 s ago no heartbeat; interval cleared after completion (advance 60 s → no more heartbeats)
     - git.pushed: run_shell `git push` against a bare repo (use testing/bare-repo.ts: clone into the tmp root, commit, the script calls `run_shell {command:'git commit --allow-empty -m x && git push origin HEAD'}`) → `git.pushed { branch, sha }` emitted after the `tool.result`; failed push (bad remote) → no git.pushed

2. `src/fake-scripts.ts` — `export function builtInFakeScript(): Record<string, ScriptedStep[]>` keyed by the E2E prompts (use the exact FakeAgentModelProvider script types): `'list files and create NOTES.md'` → step 1 `tool_call list_dir {path:'.', depth:1}` + response.done; step 2 `tool_call write_file {path:'NOTES.md', content:'# Notes\n\nCreated by Agent Hangar fake provider.\n'}`; step 3 text "I listed the repository and created NOTES.md." + response.done; `'show NOTES.md'` → `read_file {path:'NOTES.md'}` then text echoing "Here is NOTES.md"; `'print date'` → `run_shell {command:'date'}` then text; `'sleep'`-containing default for the cancel spec: key `'run a long command'` → `run_shell {command:'sleep 60'}` then text; `default` → text "Done." + response.done. Each `response.done` carries `usage {inputTokens: 10, outputTokens: 5}` and a unique responseId. Test: every key yields well-formed ModelEvents (tool_call arguments are valid JSON that passes TOOL_SCHEMAS), default present.

3. `src/provider.ts` — `export interface ProviderFactories { openai?: (opts: { apiKey: string; baseURL?: string }) => AgentModelProvider }`; `export function createProvider(name: string, env: Readonly<Record<string, string | undefined>>, factories: ProviderFactories = {}): AgentModelProvider`: `'fake'` → `new FakeAgentModelProvider({ script: env.AGENT_FAKE_SCRIPT_JSON ? JSON.parse(env.AGENT_FAKE_SCRIPT_JSON) : builtInFakeScript() })` (invalid JSON → ConfigError); `'openai'` → `factories.openai` present → call it with `{ apiKey: env.OPENAI_API_KEY ?? '', baseURL: env.OPENAI_BASE_URL }` (empty key → ConfigError('OPENAI_API_KEY is not set in the workspace environment')), absent → `ConfigError('openai provider is not wired in this build; see packages/agent-runtime/src/provider.ts (wired by W3-A via @agent-hangar/core createModelProvider)')`; anything else → ConfigError. Export `resolveProviderName(env)` → `env.AGENT_MODEL_PROVIDER ?? 'openai'`. Tests: fake default script; fake with JSON override; invalid JSON; openai with factory (spy receives key/baseURL); openai without key; openai without factory; unknown; default name.

4. `src/turn.ts` — `export interface TurnDeps { io: CliIo; providerFactories?: ProviderFactories; workspaceRoot?: string /* '/workspace' */; runtimeDir?: string /* '/tmp/ah-runtime' */; git?: GitRunner; urlPolicy?: 'github-https' | 'any' }`; `export async function runTurnCommand(deps: TurnDeps): Promise<number>`:
   1. `redactor = createRuntimeRedactor({ values: [env.GITHUB_TOKEN, env.OPENAI_API_KEY] })`; `writer = createEventWriter(io.stdout, redactor)`; `diag = createDiagnostics(io.stderr, redactor)`.
   2. `request = await readTurnRequest(io.stdin)` — ProtocolError → `diag(message)`; return `EXIT.protocolError` (no event can be emitted without a turnId).
   3. `controller = new AbortController()`; `unsubscribe = io.signals.onSigint(() => controller.abort())`.
   4. `tokenFile = await materializeGitToken(env, runtimeDir)`; `childEnv = createChildEnv(env, { tokenFile })`.
   5. `await writer.emit({ type: 'turn.started', turnId, at })`.
   6. `provider = createProvider(resolveProviderName(env), env, providerFactories)` — ConfigError → emit `turn.failed { code: 'config', message }` → return 0.
   7. `await prepare(request.repo, request.prepare, { workspaceRoot, git, env: childEnv, emit, urlPolicy })` — PrepareError/GitError → emit `turn.failed { code: 'prepare', message }` → return 0.
   8. `outcome = await runTurnLoop({ … })` → return 0 for all outcomes.
   9. Any other exception → emit `turn.failed { code: 'runtime', message: err.message }` (best effort) + `diag(stack)` → return `EXIT.runtimeFailure`.
   10. `finally`: `unsubscribe()`, `removeGitToken(tokenFile)`.
   - `src/cli.ts`: `turn` → `runTurnCommand({ io })` (replace the stub; keep `runCli` signature; allow `runCli(argv, io, { providerFactories, workspaceRoot, runtimeDir, urlPolicy })` third param for tests). Delete the 1D.1 "turn → 70" test; drop `EXIT.notImplemented`.
   - Tests (turn.test.ts, using in-memory stdin/stdout, fake provider via env `AGENT_MODEL_PROVIDER=fake`, tmp workspaceRoot, bare repo URL with `urlPolicy:'any'`): full happy path with `prepare.clone:true` → stdout lines parse with `agentEventSchema` in order `turn.started, prepare.progress…, prepare.done, step.started, …, turn.completed`, exit 0; malformed stdin → exit 2, stderr has reason, stdout empty; `AGENT_MODEL_PROVIDER=openai` without factory → `turn.failed { code:'config' }`, exit 0; bad repo (non-existent base branch) → `turn.failed { code:'prepare' }`, exit 0; SIGINT during a long fake step → `turn.cancelled`, exit 0, token file removed; a provider whose `stream` throws is caught by the loop → `turn.failed { code: 'unknown' }`, exit 0; runtime exception path: inject a `git` runner that throws a plain `Error` (not GitError) from `run` during prepare → `turn.failed { code: 'runtime' }`, exit 1, stack on stderr; stdout never contains `GITHUB_CANARY`/`OPENAI_CANARY` when they are in env and the fake script echoes `$GITHUB_TOKEN` via run_shell (it is scrubbed → empty) and echoes `cat $AH_GIT_TOKEN_FILE` (→ redacted on the wire: assert `[REDACTED]` and `assertNoCanary(stdout)`); token file does not exist after the turn.

5. `src/index.ts` — add `runTurnLoop`, `createProvider`, `builtInFakeScript`, `runTurnCommand` to the barrel.

Constraints:
- Follow /bymax-workflow:standards (JSDoc + headers, English, no enum, no suppression, it() comments). Functions ≤ 50 lines: split the loop into `streamStep`, `executeToolCalls`, `stopForLimit`, `maybeEmitGitPushed`.
- No real timers in unit tests except where a real child process is required (cancel-during-sleep, run_shell); keep those < 5 s.
- No network; no new dependencies; owned paths only.
- Never emit an event after `turn.completed` / `turn.failed` / `turn.cancelled` (assert in tests with a helper that checks the terminal event is last).

Verification:
- `pnpm --filter @agent-hangar/agent-runtime test` — green, 100 % on src/**
- `pnpm --filter @agent-hangar/agent-runtime build && pnpm --filter @agent-hangar/agent-runtime check:bundle` — passes (bundle now includes the fake provider; still < 2 MB, no host-only markers)
- Manual demo (the CLI hardcodes `/workspace`, so the end-to-end demo is the `turn.test.ts` happy path): `pnpm --filter @agent-hangar/agent-runtime test -- src/turn.test.ts` — prints the emitted NDJSON lines when run with `--reporter=verbose`
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1d-agent-runtime.md; append `- 1D.4 ✅ <date> — <summary>`; commit `feat(agent-runtime): implement turn loop, provider seam and turn command`.
````

---

## Task 1D.5 — Close-out: gates, bundle size, code review, plan dashboard, PR with orchestrator instructions

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** S · **Depends on:** 1D.1–1D.4

**Description.** Run every gate including the bundle check, take `/bymax-quality:code-review` to zero findings, optionally smoke the bundle inside the workspace image if Docker is available, update the plan dashboard and task index, and open the PR whose description carries the exact Dockerfile lines, the `infra:image` script change and the CI step for the orchestrator, plus the provider seam note. Return the result object.

**Acceptance criteria**
- [ ] `pnpm lint && pnpm format:check && pnpm typecheck && pnpm --filter @agent-hangar/agent-runtime test` green, 100/100/100/100 on `src/**` (only `src/bin.ts` excluded)
- [ ] `pnpm --filter @agent-hangar/agent-runtime build && pnpm --filter @agent-hangar/agent-runtime check:bundle` green; size recorded in the PR (< 2 MB)
- [ ] `/bymax-quality:code-review` zero open findings
- [ ] PR body contains verbatim: the two Dockerfile `COPY` lines, the `infra:image` script text, the CI step, the provider seam note; `docs/plan.md` §12 W1-D → 🟨 with branch/PR; `docs/tasks/README.md` updated; result object returned

**Files to create/modify**
`docs/plan.md` (§12 row only), `docs/tasks/README.md` (W1-D row only), this file (header + log).

**Agent prompt**

````
You are a senior engineer closing out lane W1-D of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 · Node 24 · esbuild · Vitest 4 · GitHub CLI.
Branch feat/w1d-agent-runtime (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-D — Task 1D.5 of 5 (LAST)

PRECONDITIONS
- Tasks 1D.1–1D.4 done and committed on this branch.

REQUIRED READING (only these):
- docs/plan.md § "11. Orchestrator protocol" (MERGE ORDER paragraph about W1-B/W1-D), § "12. Status dashboard"
- docs/tasks/README.md
- docs/tasks/wave-1b-docker-runner.md Task 1B.4 deliverables 3–4 (the `runtime/` folder and README that W1-B prepares — your COPY lines must match: source `runtime/cli.js`, build context `infra/workspace`)
- CLAUDE.md (gates list)

TASK
Run all gates (incl. bundle check), fix every review finding, update dashboards, open the PR with the orchestrator instructions, return the structured result.

DELIVERABLES

1. Gates, all green: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm --filter @agent-hangar/agent-runtime test` (100 % lines/branches/functions/statements on `src/**`, `src/bin.ts` excluded), `pnpm --filter @agent-hangar/agent-runtime build`, `pnpm --filter @agent-hangar/agent-runtime check:bundle` (record the KB). `pnpm build` at root passes.
2. Optional smoke (only if Docker and the image `agent-hangar/workspace:dev` are available locally; do not fail the lane without it): `docker run --rm -v "$PWD/packages/agent-runtime/dist:/opt/rt:ro" agent-hangar/workspace:dev node /opt/rt/cli.js --version` prints the version → paste in the PR.
3. Run `/bymax-quality:code-review` on `main..HEAD`. Resolve EVERY finding (CRITICAL, HIGH, MEDIUM, LOW) by changing code — no suppression comments. Re-run gates after fixes. Repeat until zero findings.
4. Update `docs/plan.md` §12 row `W1-D` → `🟨 PR open`, branch `feat/w1d-agent-runtime`, PR number, coverage `100/100/100/100 (agent-runtime src/**)`, notes "Dockerfile COPY lines + infra:image change in PR body; openai provider seam for W3-A". Update `docs/tasks/README.md` row W1-D. Update this file's header (Status 🟨 PR open, Progress 5/5).
5. Open the PR: `gh pr create --base main --head feat/w1d-agent-runtime --title "feat(agent-runtime): container-side turn runtime (W1-D)" --body-file <generated>`. Body sections, in order:
   - Summary (what the runtime does; protocol; tools; limits; cancellation; redaction)
   - Files (list)
   - **Instructions for the orchestrator (apply when merging the later of W1-B / W1-D)** — verbatim blocks:
     a. `infra/workspace/Dockerfile`, directly under `# --- AGENT RUNTIME BUNDLE (added by W1-D) ---`:
        ```
        COPY --chown=agent:agent runtime/cli.js /opt/agent-runtime/cli.js
        COPY --chown=agent:agent runtime/cli.js.map /opt/agent-runtime/cli.js.map
        ```
        (build context is `infra/workspace`; `runtime/` is populated by `pnpm infra:image` and git-ignored by W1-B's `infra/workspace/.gitignore`).
     b. Root `package.json` script (owned by W1-I — replace the current `infra:image` value):
        ```
        "infra:image": "pnpm --filter @agent-hangar/agent-runtime build && rm -rf infra/workspace/runtime && mkdir -p infra/workspace/runtime && cp packages/agent-runtime/dist/cli.js packages/agent-runtime/dist/cli.js.map infra/workspace/runtime/ && docker build -t \"${WORKSPACE_IMAGE:-agent-hangar/workspace:dev}\" infra/workspace"
        ```
        (`infra/scripts/setup.sh` should call `pnpm infra:image` instead of a raw `docker build` — one-line change for W1-I.)
     c. `.github/workflows/ci.yml` `integration` and `build` jobs: replace `docker build -t agent-hangar/workspace:dev infra/workspace` with `pnpm infra:image`; the `build` job's smoke becomes `docker run --rm agent-hangar/workspace:dev node /opt/agent-runtime/cli.js --version`.
     d. Provider seam: once W1-C is merged, in `packages/agent-runtime/src/cli.ts` pass `providerFactories: { openai: (o) => createModelProvider('openai', o) }` (or the exact factory W1-C exports) — one line; W3-A owns this wiring. Until then `AGENT_MODEL_PROVIDER=openai` yields `turn.failed { code: 'config' }` and `fake` works end-to-end.
     e. `askpass.sh` contract relied upon: `AH_GIT_TOKEN_FILE` (W1-B Task 1B.4).
   - How to run (`pnpm --filter @agent-hangar/agent-runtime test`, `build`, `check:bundle`, the turn test as the manual demo)
   - Gate results · Coverage numbers · Bundle size · Smoke result (if run)
   - Known gaps (openai wiring pending W1-C/W3-A; nothing else expected — list anything real)
6. Return to the orchestrator exactly: `{ pr: <number>, branch: 'feat/w1d-agent-runtime', headSha: '<sha>', gates: { lint, format, typecheck, unit, build, bundleCheck }, coverage: { lines: 100, branches: 100, functions: 100, statements: 100 }, contractChangeRequests: [] }` (list any requested contract change with path and reason instead of an empty array).

Constraints:
- English; Conventional Commits; no AI-attribution trailers anywhere (commits, PR body, comments).
- Do not wait for CI; do not merge; do not edit infra/workspace/**, root package.json or .github/** — those changes travel in the PR body only.

Verification:
- `gh pr view --json number,headRefOid,url` — PR exists and headRefOid equals `git rev-parse HEAD`
- `git status --porcelain` — empty; `git log --format=%B main..HEAD | grep -i "co-authored-by\|generated with"` — no output
- `git diff --stat main..HEAD -- infra root package.json .github` — no changes outside owned paths except docs/plan.md, docs/tasks/README.md, this file

Completion Protocol: update status/AC/progress in docs/tasks/wave-1d-agent-runtime.md (lane header Status → 🟨 PR open); append `- 1D.5 ✅ <date> — PR #<n> opened`; commit `docs(tasks): close out lane W1-D` before opening the PR.
````

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)
