# Wave 1 — Lane W1-B 🐳 — DockerWorkspaceRunner + workspace image

| | |
|---|---|
| **Lane** | W1-B 🐳 (Docker-integration lane — the orchestrator runs at most one 🐳 lane at a time) |
| **Status** | 🟦 running |
| **Progress** | 0/5 tasks |
| **Branch** | `feat/w1b-docker-runner` |
| **Owned paths** | `packages/core/src/runner/docker/**`, `infra/workspace/**` (Dockerfile, askpass.sh, .dockerignore, README.md, .gitignore) · additive-only edits allowed in `packages/core/vitest.config.ts` (`coverage.include`) and `packages/core/package.json` (`exports` subpath `./runner/docker`) |
| **Depends on** | W0 merged to `main` |
| **Unblocks** | W2-B 🐳 (worker processors) · coordination with W1-D (Dockerfile `COPY` lines applied by the orchestrator when merging the later of W1-B / W1-D) |
| **Source** | [docs/plan.md §6 W1-B](../plan.md) · spec [03 §1](../spec/03-interfaces.md) [05 §5](../spec/05-local-dev.md) [06 §2–3](../spec/06-testing.md) |
| **Last updated** | 2026-08-19 |

## Context

W0 froze the `WorkspaceRunner` contract in `packages/core/src/runner/types.ts` (including the `{ type: 'started'; execRef }` first `ExecEvent`), the typed error `WorkspaceImageMissing` in `packages/core/src/errors.ts`, the test doubles in `packages/core/src/testing/**` and the workspace image **base** in `infra/workspace/Dockerfile` (node:24-bookworm-slim, tools, user `agent` uid 1001, `/workspace`, `/opt/agent-runtime/askpass.sh`, `ENTRYPOINT ["sleep","infinity"]`, and the placeholder comment `# --- AGENT RUNTIME BUNDLE (added by W1-D) ---`). The folder `packages/core/src/runner/docker/` exists with a `.gitkeep` only.

This lane ships the one real runner — `DockerWorkspaceRunner` over dockerode — plus the hardening/verification of the workspace image. It is the only Wave 1 lane that talks to a real Docker daemon in tests. Everything else in the system tests against `FakeWorkspaceRunner`.

Quality bar (same as every lane): TypeScript strict, zero `any`, zero suppression comments, no `enum`, JSDoc on every export + file header, English only, test headers + a block comment on every `it()`, **100 % coverage on lines/branches/functions/statements** for `packages/core/src/runner/docker/**` from **unit** tests (the `@docker` integration suite is additional evidence, not the coverage source).

## Rules of this lane

1. **Owned paths only.** Create/edit only under `packages/core/src/runner/docker/**` and `infra/workspace/**`. The two additive exceptions are spelled out in the header (vitest `coverage.include`; `package.json` `exports` subpath). Root `package.json` scripts belong to W1-I — the `infra:image` script already exists; do not edit it.
2. **No new dependencies.** `dockerode` 5 + `@types/dockerode` are already installed by W0. If anything else seems needed, stop and report to the orchestrator (plan §3 rule 2).
3. **dockerode is imported only inside `packages/core/src/runner/docker/**`** (ESLint `no-restricted-imports` enforces it). The runner class takes an injectable Docker API so unit tests never touch dockerode; the real client is constructed only in `createDockerWorkspaceRunner()`.
4. **The runner never logs, throws or serialises env values.** `spec.env` carries secrets (GITHUB_TOKEN, OPENAI_API_KEY). Error messages and any debug output may mention env **keys**, never values. Unit tests assert with the canaries from `@agent-hangar/core/testing`.
5. **Integration tests are tagged `@docker`** and live in `*.integration.test.ts` files, run by `pnpm --filter @agent-hangar/core test:integration` (the split W0 configured). They run only when `DOCKER_AVAILABLE=1`; otherwise they **fail loudly when `CI` is set** and skip with a printed instruction locally. Never silently green.
6. Each test that creates a container destroys it in `afterEach`; `afterAll` lists by `ah.instance=test` and destroys leftovers. Use `AH_INSTANCE=test` conventions: prefix `ah-ws-test-`, label `ah.instance=test`.
7. Commit messages: Conventional Commits, English, no attribution trailers. Branch `feat/w1b-docker-runner`. One PR at the end (Task 1B.5).

## Reference docs

- [docs/plan.md](../plan.md) § "3. Parallelism rules", § "6. Wave 1" (W1-B block + coordination with W1-D), § "11. Orchestrator protocol"
- [spec 03 — Interface contracts](../spec/03-interfaces.md) § "1. WorkspaceRunner" (incl. "DockerWorkspaceRunner behaviour") and § "3. Agent runtime protocol" (how `exec` is used)
- [spec 05 — Local dev](../spec/05-local-dev.md) § "3. Environment model" (`WORKSPACE_IMAGE`, `WORKSPACE_NAME_PREFIX`, `DOCKER_HOST`), § "5. docker-compose services" (Workspace image subsection)
- [spec 06 — Testing](../spec/06-testing.md) § "2. Unit tests" (`runner/docker/` bullet), § "3. Integration tests" (DockerWorkspaceRunner bullet)
- Contract files (read, never edit): `packages/core/src/runner/types.ts`, `packages/core/src/errors.ts`, `packages/core/src/config/schema.ts`, `packages/core/src/testing/{canaries,fake-workspace-runner}.ts`

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 1B.1 | Docker socket resolution + container spec builder (pure) | 📋 | P0 | M | — |
| 1B.2 | Exec stream: demux, stdin pump, timeout/abort kill path (pure) | 📋 | P0 | M | 1B.1 |
| 1B.3 | `DockerWorkspaceRunner` class + factory + unit tests with a faked Docker API | 📋 | P0 | L | 1B.1, 1B.2 |
| 1B.4 | Workspace image hardening/verification, askpass token-file support, README, `@docker` integration suite | 📋 | P0 | M | 1B.3 |
| 1B.5 | Close-out: gates, code review, plan dashboard, PR | 📋 | P0 | S | 1B.1–1B.4 |

---

## Task 1B.1 — Docker socket resolution + container spec builder (pure)

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** Implement the two pure modules the runner is built on: `docker-socket.ts` (resolve where the Docker daemon is, in the order spec 03 §1 mandates, returning dockerode constructor options) and `container-spec.ts` (translate a `WorkspaceSpec` into dockerode `createContainer` options with the hardening flags, limits and labels). Both are 100 % unit-tested without Docker.

**Acceptance criteria**
- [ ] `resolveDockerSocket()` honours `DOCKER_HOST` (`unix://` and `tcp://`), then `~/.docker/run/docker.sock`, then `/var/run/docker.sock`; reports which source won; rejects `DOCKER_TLS_VERIFY=1` with a typed error
- [ ] `buildContainerCreateOptions()` produces: `name = prefix + workspaceId`, `Image`, `Env` as `KEY=VALUE[]`, `User: 'agent'`, `WorkingDir: '/workspace'`, `HostConfig { Memory, NanoCpus, PidsLimit, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Tmpfs: { '/tmp': '' }, NetworkMode: 'bridge' }`, **no** `Binds`/`Mounts`, `Labels` with `ah.instance`, `ah.workspace`, `ah.kind` always set and the caller's labels (`ah.chat` or `ah.jobRun`) passed through
- [ ] `DockerRunnerError` (code `DOCKER_RUNNER`) exists in `runner/docker/errors.ts` extending `AgentHangarError`
- [ ] `packages/core/vitest.config.ts` `coverage.include` extended with `src/runner/docker/**`; 100 % on the two modules

**Files to create**
`packages/core/src/runner/docker/{docker-socket.ts, docker-socket.test.ts, container-spec.ts, container-spec.test.ts, errors.ts, errors.test.ts}`; delete `packages/core/src/runner/docker/.gitkeep`; modify `packages/core/vitest.config.ts` (coverage.include only).

**Agent prompt**

````
You are a senior TypeScript/platform engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core is framework-free; dockerode 5 (+ @types/dockerode) is installed and may be imported ONLY under packages/core/src/runner/docker/**. Vitest 4 with @vitest/coverage-v8.
Branch feat/w1b-docker-runner (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-B 🐳 (DockerWorkspaceRunner + workspace image) — Task 1B.1 of 5 (FIRST)

PRECONDITIONS
- W0 merged to main; branch off latest main: `git checkout -b feat/w1b-docker-runner origin/main`.
- These contract files exist and are read-only for you: packages/core/src/runner/types.ts (WorkspaceSpec, WorkspaceHandle, ExecSpec, ExecEvent incl. `started`, WorkspaceSnapshot, WorkspaceHealth, WorkspaceRunner), packages/core/src/errors.ts (AgentHangarError, WorkspaceImageMissing, ConfigError, ProtocolError), packages/core/src/config/schema.ts (WORKSPACE_IMAGE, WORKSPACE_NAME_PREFIX, DOCKER_HOST), packages/core/src/testing/canaries.ts.
- packages/core/src/runner/docker/ contains only a .gitkeep.

REQUIRED READING (only these):
- docs/spec/03-interfaces.md § "1. WorkspaceRunner" (the interface and the "DockerWorkspaceRunner behaviour" bullets)
- docs/spec/05-local-dev.md § "3. Environment model" (rows WORKSPACE_IMAGE, WORKSPACE_NAME_PREFIX, DOCKER_HOST)
- docs/spec/06-testing.md § "2. Unit tests" (the `runner/docker/` bullet)
- packages/core/src/runner/types.ts, packages/core/src/errors.ts
- CLAUDE.md (rules and gates)

TASK
Implement the pure building blocks of the Docker runner: socket resolution and the container create-options builder, plus the lane's typed error. No Docker calls in this task.

DELIVERABLES

1. `packages/core/src/runner/docker/errors.ts` — `export class DockerRunnerError extends AgentHangarError { readonly code = 'DOCKER_RUNNER' as const; constructor(message: string, options?: { cause?: unknown }) }`. Used for daemon/runtime failures that are not `WorkspaceImageMissing`. Test: `code`, `message`, `instanceof AgentHangarError`, `cause` preserved.

2. `packages/core/src/runner/docker/docker-socket.ts`
   - `export interface DockerSocketResolution { options: DockerodeOptions; source: 'DOCKER_HOST' | 'user-socket' | 'system-socket' }` where `DockerodeOptions` is `import type Dockerode from 'dockerode'` → `Dockerode.DockerOptions` (type-only import).
   - `export interface ResolveDockerSocketDeps { env?: Readonly<Record<string, string | undefined>>; homedir?: () => string; exists?: (path: string) => boolean }` defaulting to `process.env`, `os.homedir`, `fs.existsSync`.
   - `export function resolveDockerSocket(deps: ResolveDockerSocketDeps = {}): DockerSocketResolution`:
     a. `DOCKER_HOST` set and non-empty → if it starts with `unix://` → `{ socketPath: <path after the scheme> }`; if `tcp://host:port` → `{ host, port: Number(port), protocol: 'http' }`; if `DOCKER_TLS_VERIFY` is `'1'` → throw `DockerRunnerError('DOCKER_TLS_VERIFY is not supported by this runner; use a unix socket or plain tcp')`; any other scheme or unparsable value → throw `DockerRunnerError('unsupported DOCKER_HOST "<value>"')`. Source `'DOCKER_HOST'`.
     b. else if `exists(join(homedir(), '.docker/run/docker.sock'))` → `{ socketPath }`, source `'user-socket'` (Docker Desktop on macOS).
     c. else `{ socketPath: '/var/run/docker.sock' }`, source `'system-socket'` (no existence check — the daemon call itself will fail with a clear error later).
   - Tests (docker-socket.test.ts): DOCKER_HOST unix; DOCKER_HOST tcp with port parsing; DOCKER_HOST tcp with TLS → throws; DOCKER_HOST garbage → throws; empty string DOCKER_HOST falls through; user socket present; fallback to system socket; deps defaults are used when omitted (call once with no args and only assert the shape, do not depend on the host machine).

3. `packages/core/src/runner/docker/container-spec.ts`
   - `export interface ContainerSpecOptions { namePrefix: string; instance: string }`.
   - `export const WORKSPACE_USER = 'agent'`, `export const WORKSPACE_DIR = '/workspace'`, `export const LABEL_INSTANCE = 'ah.instance'`, `LABEL_WORKSPACE = 'ah.workspace'`, `LABEL_KIND = 'ah.kind'` (also `LABEL_CHAT = 'ah.chat'`, `LABEL_JOB_RUN = 'ah.jobRun'` for consumers).
   - `export function buildContainerCreateOptions(spec: WorkspaceSpec, opts: ContainerSpecOptions): Dockerode.ContainerCreateOptions` (pure, no I/O):
     ```ts
     return {
       name: `${opts.namePrefix}${spec.workspaceId}`,
       Image: spec.image,
       Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
       User: WORKSPACE_USER,
       WorkingDir: WORKSPACE_DIR,
       Tty: false,
       OpenStdin: false,
       Labels: { ...spec.labels, [LABEL_INSTANCE]: opts.instance, [LABEL_WORKSPACE]: spec.workspaceId, [LABEL_KIND]: spec.kind },
       HostConfig: {
         Memory: spec.limits.memoryBytes,
         NanoCpus: Math.round(spec.limits.cpus * 1_000_000_000),
         PidsLimit: spec.limits.pids,
         CapDrop: ['ALL'],
         SecurityOpt: ['no-new-privileges'],
         Tmpfs: { '/tmp': '' },
         NetworkMode: 'bridge',
       },
     };
     ```
     Rules: fixed labels win over caller labels (spread order as shown); no `Binds`, `Mounts`, `Privileged`, `Devices`; `diskBytes` is advisory and ignored (document in JSDoc: Docker Desktop's default storage driver does not enforce per-container quotas). Validate: `workspaceId` must match `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/` (Docker name charset after the prefix) else throw `DockerRunnerError`; `cpus > 0`, `memoryBytes > 0`, `pids > 0` else throw `DockerRunnerError`; env keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/` else throw (never include the value in the message).
   - Tests (container-spec.test.ts): exact options snapshot for a CHAT spec with `ah.chat` label and for a JOB spec with `ah.jobRun`; fixed labels override caller-supplied `ah.workspace`; NanoCpus rounding (`cpus: 1.5` → `1_500_000_000`); invalid workspaceId throws; zero/negative limits throw; invalid env key throws and the error message does not contain the env value (use `GITHUB_CANARY` from `@agent-hangar/core/testing` as the value, assert `not.toContain`); no Binds/Mounts keys present; Env encodes `=` inside values correctly (`A=b=c`).

4. `packages/core/vitest.config.ts` — add `'src/runner/docker/**'` to `coverage.include` (keep thresholds 100/100/100/100). Remove `src/runner/docker/.gitkeep`.

Constraints:
- Follow /bymax-workflow:standards: TS strict, JSDoc on every export + file header, English comments only, no `enum`, no suppression comments, test file header + block comment on every it().
- `import type Dockerode from 'dockerode'` only — no runtime dockerode import in these two modules.
- No new dependencies; owned paths only.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green; 100 % on `src/runner/docker/**`
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-1b-docker-runner.md (task index row and task block)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/5 tasks`)
4. Append a completion log entry at the end of the file: `- 1B.1 ✅ <YYYY-MM-DD> — <one-line summary>`
5. Commit: `feat(core): add docker socket resolution and container spec builder`
````

---

## Task 1B.2 — Exec stream: demux, stdin pump, timeout/abort kill path (pure)

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** M · **Depends on:** 1B.1

**Description.** Implement `exec-stream.ts`: a demuxer for Docker's multiplexed attach stream (8-byte frame headers), a stdin writer that accepts `string | Uint8Array | AsyncIterable<Uint8Array>` and always closes stdin, and the async generator that pumps a hijacked exec stream into `ExecEvent`s while honouring `timeoutMs` and `AbortSignal` by invoking an injected `kill()` and yielding `exit { code: null, signal: 'TIMEOUT' | 'ABORTED' }`. Pure: tested with in-memory duplex streams and fake timers.

**Acceptance criteria**
- [ ] `createDockerDemuxer()` handles frames split across chunks (header split, payload split), several frames per chunk, stream types 0/1 → stdout, 2 → stderr, unknown type → `ProtocolError`
- [ ] `writeStdin(stream, stdin)` writes the three input shapes, respects backpressure (`await drain`), always calls `stream.end()` (also when `stdin` is undefined), and ends early when the abort signal fires
- [ ] `pumpExecStream(params)` yields stdout/stderr events in order, then `exit { code }` from `inspectExitCode()`; on timeout calls `kill('TIMEOUT')` once and yields `exit { code: null, signal: 'TIMEOUT' }`; on abort yields `exit { code: null, signal: 'ABORTED' }`; never throws on non-zero exit; stream `error` → `DockerRunnerError`
- [ ] 100 % coverage on `exec-stream.ts`

**Files to create**
`packages/core/src/runner/docker/{exec-stream.ts, exec-stream.test.ts}`.

**Agent prompt**

````
You are a senior TypeScript/platform engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core framework-free; dockerode 5 only under src/runner/docker/**. Vitest 4 (fake timers available).
Branch feat/w1b-docker-runner (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-B 🐳 — Task 1B.2 of 5 (MIDDLE)

PRECONDITIONS
- Task 1B.1 done (errors.ts, docker-socket.ts, container-spec.ts exist, coverage.include extended).

REQUIRED READING (only these):
- docs/spec/03-interfaces.md § "1. WorkspaceRunner" (ExecSpec/ExecEvent and the `exec` bullets of "DockerWorkspaceRunner behaviour")
- packages/core/src/runner/types.ts (ExecEvent incl. `started`, ExecSpec)
- Docker Engine API docs, section "Attach to a container" → "Stream format" (the 8-byte header: byte 0 = stream type 0/1/2, bytes 1–3 zero, bytes 4–7 big-endian uint32 payload size)

TASK
Implement the stream plumbing that the runner's exec() will use, as pure functions over Node streams, fully unit-tested with PassThrough/Duplex streams and fake timers.

DELIVERABLES

1. `packages/core/src/runner/docker/exec-stream.ts`
   a. `export interface DockerDemuxer { push(chunk: Uint8Array): ExecEvent[]; pendingBytes(): number }` and `export function createDockerDemuxer(): DockerDemuxer`. State machine: buffer incoming bytes; while ≥ 8 bytes: read type (byte 0) and size (readUInt32BE at 4); wait until the payload is complete; emit `{ type: 'stdout' | 'stderr', data }` (type 0 and 1 → stdout, 2 → stderr; anything else → throw `ProtocolError('unexpected docker stream type <n>')`); never emit an event with an empty payload (size 0 frames are skipped). `pendingBytes()` returns leftover bytes (used by tests and for a diagnostic when the stream ends mid-frame).
   b. `export type ExecStdin = ExecSpec['stdin']` and `export async function writeStdin(stream: NodeJS.WritableStream & { end(): unknown }, stdin: ExecStdin, signal?: AbortSignal): Promise<void>`: string → UTF-8 once; Uint8Array → once; AsyncIterable → chunk by chunk; when `write()` returns false await the `'drain'` event; if `signal` aborts mid-way stop iterating; always `stream.end()` in `finally` (a process waiting on stdin must see EOF even when no stdin was given).
   c. `export interface PumpExecParams { stream: NodeJS.ReadableStream; demuxer: DockerDemuxer; timeoutMs?: number; signal?: AbortSignal; kill: (reason: 'TIMEOUT' | 'ABORTED') => Promise<void>; inspectExitCode: () => Promise<number | null>; setTimeoutFn?: typeof setTimeout; clearTimeoutFn?: typeof clearTimeout }` and `export async function* pumpExecStream(params: PumpExecParams): AsyncGenerator<ExecEvent>`. Behaviour:
      - iterate `for await (const chunk of stream)` yielding every demuxed event in order;
      - if `timeoutMs` is set, arm a timer; on fire set `terminated = 'TIMEOUT'`, call `kill('TIMEOUT')` (await it; a rejection is ignored — the caller's `kill` already has its own fallback and the stream is destroyed next anyway; document this), and `stream.destroy()` so the loop ends;
      - if `signal` is already aborted or aborts during the pump → `terminated = 'ABORTED'`, `kill('ABORTED')`, `stream.destroy()`;
      - after the loop: if `terminated` → yield `{ type: 'exit', code: null, signal: terminated }`; else yield `{ type: 'exit', code: await inspectExitCode() }`;
      - a stream `'error'` that is not our own destroy → throw `DockerRunnerError('exec stream failed', { cause })`;
      - `finally`: clear the timer, remove the abort listener. Never throws because of a non-zero exit code.
   d. `export function execWrapperCommand(execRef: string, cmd: readonly string[]): string[]` — returns `['sh', '-c', 'mkdir -p /tmp/ah-exec && echo $$ > "/tmp/ah-exec/$0.pid" && exec "$@"', execRef, ...cmd]`. The wrapper records the shell's pid (kept by `exec "$@"`) in `/tmp/ah-exec/<execRef>.pid` so `signal()` can target the real process (dockerode's `exec.inspect().Pid` is the host pid and useless inside the container). `execRef` must match `/^[0-9a-f-]{36}$/` (UUID) — throw `DockerRunnerError` otherwise (prevents shell injection through the ref). Export also `export const EXEC_PID_DIR = '/tmp/ah-exec'` and `export function killCommand(execRef: string, sig: 'INT' | 'TERM' | 'KILL'): string[]` → `['sh', '-c', 'kill -<sig> "$(cat "/tmp/ah-exec/$0.pid")"', execRef]` with the same ref validation.

2. `packages/core/src/runner/docker/exec-stream.test.ts` — it() list:
   - demuxer: one complete stdout frame; one stderr frame; header split across two chunks; payload split across three chunks; two frames in one chunk; zero-length frame skipped; unknown type 7 throws ProtocolError; `pendingBytes()` after a partial header
   - writeStdin: string; Uint8Array; async iterable of three chunks; undefined still ends the stream; backpressure (`write` returns false → waits for drain; use a Writable with `highWaterMark: 1`); abort mid-iterable stops and still ends
   - pumpExecStream: stdout then stderr then exit 0 (inspect returns 0); exit 3 propagated, no throw; timeout path (fake timers: advance past timeoutMs → kill called once with 'TIMEOUT', exit `{ code: null, signal: 'TIMEOUT' }`, inspectExitCode NOT called); pre-aborted signal → immediate kill('ABORTED') + exit ABORTED; abort during stream; stream error → DockerRunnerError; timer cleared on normal completion (advance timers after completion and assert kill not called)
   - execWrapperCommand / killCommand: exact arrays; invalid execRef throws; every signal name
   Use `PassThrough` for streams and a helper `frame(type, payload)` building Docker headers.

Constraints:
- Follow /bymax-workflow:standards (JSDoc + headers, English, no enum, no suppression, it() comments).
- No dockerode runtime import here (types only if any). No new dependencies; owned paths only.
- No real timers in tests (`vi.useFakeTimers()` around timeout cases).

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green, 100 % on exec-stream.ts
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1b-docker-runner.md; append `- 1B.2 ✅ <date> — <summary>`; commit `feat(core): add docker exec stream demux, stdin pump and kill path`.
````

---

## Task 1B.3 — `DockerWorkspaceRunner` class + factory + unit tests with a faked Docker API

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** L · **Depends on:** 1B.1, 1B.2

**Description.** Implement the runner itself: `create` (image check → createContainer → start → readiness probe), `exec` (started event first, wrapper command with pid file, hijacked stream, stdin, timeout/abort), `signal` (kill via pid file), `snapshot` (git state of `/workspace`), `destroy` (stop + remove, 404 = success), `health` (inspect → healthy/unhealthy/gone), `list` (by labels scoped to the instance). The class depends on a narrow `DockerApi` interface so unit tests drive it with an in-memory fake; `createDockerWorkspaceRunner()` builds the real dockerode client. Public subpath export `@agent-hangar/core/runner/docker`.

**Acceptance criteria**
- [ ] `DockerWorkspaceRunner implements WorkspaceRunner` with `kind = 'docker'`; all seven methods behave as spec 03 §1 + "DockerWorkspaceRunner behaviour"
- [ ] `create` throws `WorkspaceImageMissing` (message contains `pnpm infra:image`) when the image is absent; cleans up the container if the readiness probe fails or the signal aborts
- [ ] `exec` yields `{ type: 'started', execRef }` first, then stdout/stderr, then exactly one `exit`; timeout → `exit { code: null, signal: 'TIMEOUT' }` after a `kill -KILL` through the pid file, falling back to `container.kill()` if the kill exec itself fails
- [ ] `destroy` is idempotent (404 and 304 swallowed); `health` maps inspect states; `list` filters by `ah.instance` + given labels
- [ ] No env value ever appears in error messages or in `JSON.stringify(runner)`; `packages/core/package.json` exports `./runner/docker`; 100 % coverage on `docker-workspace-runner.ts` and `index.ts` from unit tests

**Files to create/modify**
`packages/core/src/runner/docker/{docker-api.ts, docker-workspace-runner.ts, docker-workspace-runner.test.ts, index.ts, testing/fake-docker-api.ts}`; modify `packages/core/package.json` (`exports` → add `./runner/docker`).

**Agent prompt**

````
You are a senior TypeScript/platform engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core framework-free; dockerode 5 only under src/runner/docker/**. Vitest 4.
Branch feat/w1b-docker-runner (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-B 🐳 — Task 1B.3 of 5 (MIDDLE)

PRECONDITIONS
- Tasks 1B.1–1B.2 done: errors.ts, docker-socket.ts, container-spec.ts, exec-stream.ts exist with 100 % coverage.
- Contract: packages/core/src/runner/types.ts (WorkspaceRunner etc.), packages/core/src/errors.ts (WorkspaceImageMissing), packages/core/src/testing/canaries.ts, packages/core/src/testing/fake-clock.ts (Clock interface).

REQUIRED READING (only these):
- docs/spec/03-interfaces.md § "1. WorkspaceRunner" (entire section)
- docs/spec/04-flows.md § "(a)" steps 33–38 and the "Worker crash mid-turn" edge case (how `list()` and `signal()` are used)
- packages/core/src/runner/types.ts, packages/core/src/errors.ts
- The four modules you built in 1B.1–1B.2
- dockerode 5 typings in node_modules/@types/dockerode/index.d.ts (methods: getImage().inspect, createContainer, getContainer().{start,stop,remove,kill,inspect,exec}, Exec.{start,inspect}, listContainers)

TASK
Implement DockerWorkspaceRunner against a narrow, injectable Docker API so the class is 100 % unit-tested with an in-memory fake, and a factory that wires the real dockerode client using resolveDockerSocket().

DELIVERABLES

1. `packages/core/src/runner/docker/docker-api.ts` — the minimal surface the runner needs, as interfaces (structural subset of dockerode so the real client satisfies them without adapters):
   ```ts
   export interface DockerExecApi { start(opts: { hijack: true; stdin: true }): Promise<NodeJS.ReadWriteStream>; inspect(): Promise<{ ExitCode: number | null; Running: boolean }> }
   export interface DockerContainerApi {
     id: string;
     start(): Promise<unknown>;
     stop(opts: { t: number }): Promise<unknown>;
     remove(opts: { v: boolean; force: boolean }): Promise<unknown>;
     kill(): Promise<unknown>;
     inspect(): Promise<{ Id: string; State: { Status: string; Running: boolean; StartedAt: string; OOMKilled?: boolean; ExitCode?: number }; Config: { Labels: Record<string, string> } }>;
     exec(opts: { Cmd: string[]; AttachStdin: boolean; AttachStdout: boolean; AttachStderr: boolean; Tty: boolean; WorkingDir?: string; Env?: string[]; User?: string }): Promise<DockerExecApi>;
   }
   export interface DockerApi {
     getImage(name: string): { inspect(): Promise<unknown> };
     createContainer(opts: Dockerode.ContainerCreateOptions): Promise<DockerContainerApi>;
     getContainer(id: string): DockerContainerApi;
     listContainers(opts: { all: boolean; filters: { label: string[] } }): Promise<Array<{ Id: string; Labels: Record<string, string> }>>;
   }
   export function isDockerNotFound(err: unknown): boolean   // statusCode 404
   export function isDockerNotModified(err: unknown): boolean // statusCode 304
   export function isDockerConflict(err: unknown): boolean    // statusCode 409
   ```
   (dockerode errors carry `statusCode`; read it defensively from `unknown`.)

2. `packages/core/src/runner/docker/docker-workspace-runner.ts`
   - `export interface DockerWorkspaceRunnerOptions { docker: DockerApi; instance: string; namePrefix: string; clock?: Clock; readiness?: { attempts: number; delayMs: number } /* default 25 × 200 ms */; setTimeoutFn?: typeof setTimeout; randomUUID?: () => string }`.
   - `export class DockerWorkspaceRunner implements WorkspaceRunner { readonly kind = 'docker'; … }`.
   - `create(spec, opts)`:
     1. `await docker.getImage(spec.image).inspect()`; 404 → throw `new WorkspaceImageMissing(spec.image)` (W0's error already embeds `pnpm infra:image`; if its constructor takes a message, pass one that names the image and the command). Any other error → `DockerRunnerError('cannot inspect image <name>', { cause })`.
     2. `buildContainerCreateOptions(spec, { namePrefix, instance })` → `docker.createContainer`; 409 → `DockerRunnerError('container name already exists: <name>')`.
     3. `container.start()`.
     4. Readiness: up to `attempts` times run an internal `runCapture(container, ['true'])` (see 6) until exit 0, sleeping `delayMs` between tries (injected setTimeout); abort signal checked before each try. On exhaustion or abort: best-effort `destroy` and throw `DockerRunnerError('workspace did not become ready')` / `DockerRunnerError('create aborted')`.
     5. Return `{ workspaceId: spec.workspaceId, runnerRef: container.id }`.
   - `exec(handle, spec)` is an `async *` generator:
     - `execRef = randomUUID()`; yield `{ type: 'started', execRef }` FIRST (before any daemon call, so callers can `signal()` even if exec setup hangs — document);
     - `container = docker.getContainer(handle.runnerRef)`; `exec = await container.exec({ Cmd: execWrapperCommand(execRef, spec.cmd), AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, WorkingDir: spec.cwd ?? WORKSPACE_DIR, Env: spec.env ? toEnvArray(spec.env) : undefined, User: WORKSPACE_USER })`; `stream = await exec.start({ hijack: true, stdin: true })`;
     - start `writeStdin(stream, spec.stdin, spec.signal)` without awaiting (store the promise; await it in `finally` and ignore its rejection only if the stream was destroyed by us);
     - `yield* pumpExecStream({ stream, demuxer: createDockerDemuxer(), timeoutMs: spec.timeoutMs, signal: spec.signal, kill: () => this.killExec(container, execRef), inspectExitCode: async () => (await exec.inspect()).ExitCode })`;
     - container 404 at any step → yield `{ type: 'exit', code: null, signal: 'GONE' }` and return (the workspace disappeared; never throw from exec for that).
   - private `killExec(container, execRef)`: run `killCommand(execRef, 'KILL')` via `runCapture`; if that throws or exits non-zero → `await container.kill()` (fallback kills PID 1 = `sleep infinity`, so the container stops; `health` will report unhealthy; documented).
   - `signal(handle, execRef, sig)`: `runCapture(container, killCommand(execRef, sig))`; non-zero exit (pid file missing = process already gone) resolves silently; 404 container resolves silently.
   - `snapshot(handle)`: via `runCapture` in `/workspace`: `git rev-parse --is-inside-work-tree` (non-zero → return `{ takenAt, git: { branch: null, headSha: null, dirty: false, ahead: 0, behind: 0 }, summary: '' }`), `git rev-parse --abbrev-ref HEAD` (`HEAD` → branch null), `git rev-parse HEAD` (fails on empty repo → null), `git status --porcelain` (dirty = output non-empty), `git rev-list --left-right --count origin/<branch>...HEAD` only when branch is non-null (parse "behind\tahead"; failure → 0/0), `git diff --stat`. `summary` = porcelain + "\n" + diffstat, truncated to 16 384 bytes with a trailing `\n[truncated]`. `takenAt = clock.now()`.
   - `destroy(handle)`: `stop({ t: 10 })` ignoring 304/404; `remove({ v: true, force: true })` ignoring 404; other errors → `DockerRunnerError`.
   - `health(handle)`: `inspect()`; 404 → `{ status: 'gone' }`; `State.Running` → `{ status: 'healthy', uptimeMs: clock.now().getTime() - Date.parse(State.StartedAt) }` (clamp ≥ 0); else `{ status: 'unhealthy', reason: State.OOMKilled ? 'oom-killed' : `status=${State.Status} exit=${State.ExitCode ?? 'unknown'}` }`.
   - `list(labels)`: `listContainers({ all: true, filters: { label: [`ah.instance=${instance}`, ...Object.entries(labels).map(([k,v]) => `${k}=${v}`)] } })` → map to `{ workspaceId: Labels['ah.workspace'] ?? '', runnerRef: Id }`, dropping entries without `ah.workspace`.
   - private `runCapture(container, cmd, cwd = WORKSPACE_DIR): Promise<{ code: number | null; stdout: string; stderr: string }>` — exec without stdin (`AttachStdin: false`, start with `{ hijack: true, stdin: false }` — widen the DockerExecApi.start type accordingly), demux, collect, inspect exit code. Used by readiness, kill, signal, snapshot.
   - Hygiene: no logging; every thrown message is built from ids/names only; `toEnvArray` lives in container-spec.ts (export it) — never copy env into error causes.

3. `packages/core/src/runner/docker/index.ts` — re-export the public surface: `DockerWorkspaceRunner`, `DockerWorkspaceRunnerOptions`, `createDockerWorkspaceRunner`, `resolveDockerSocket`, `buildContainerCreateOptions`, label constants, `DockerRunnerError`, the `DockerApi` types. `export function createDockerWorkspaceRunner(config: { instance: string; namePrefix: string; env?: NodeJS.ProcessEnv; clock?: Clock }): DockerWorkspaceRunner` → `new Dockerode(resolveDockerSocket({ env }).options)` — the ONLY runtime import of dockerode in the package (`import Dockerode from 'dockerode'`). Unit test it with `vi.mock('dockerode')` to assert the options passed and that the returned instance is a DockerWorkspaceRunner.

4. `packages/core/src/runner/docker/testing/fake-docker-api.ts` — `export class FakeDockerApi implements DockerApi` (test-only helper; NOT exported from the public index — tests import it by relative path). Behaviour: `images: Set<string>`; `containers: Map<id, { opts, running, labels, execs }>`; `createContainer` assigns `c<N>` ids, rejects 409 on duplicate name; `getContainer(id)` returns a handle whose methods reject with `{ statusCode: 404 }` when the id is unknown; `exec()` records the Cmd and returns a scripted `DockerExecApi` — the fake takes `execScripts: Array<{ match: (cmd: string[]) => boolean; stdout?: string; stderr?: string; exitCode?: number | null; hang?: boolean; failStart?: boolean }>` and builds the hijacked stream as a `PassThrough` fed with Docker-framed bytes (`hang: true` never ends the stream so timeout/abort paths can be tested; the pump's `stream.destroy()` ends it); default script: `true` → exit 0, `kill -…` → exit 0, everything else → exit 0 with empty output; `listContainers` filters by label equality; `inspect` reflects `running`/`StartedAt`/labels; expose `calls: string[]` for assertions. Put it under `src/runner/docker/testing/` and add that folder to `coverage.include` too (it is owned code and must be 100 %).

5. `packages/core/src/runner/docker/docker-workspace-runner.test.ts` — it() list (each with FakeDockerApi + FakeClock + a no-op setTimeout):
   - create: happy path returns handle with container id and the create options carry name/labels/limits; image missing → WorkspaceImageMissing with `pnpm infra:image` in message; image inspect other error → DockerRunnerError; 409 name conflict → DockerRunnerError; readiness never ready → container removed and DockerRunnerError; abort signal before readiness → destroy called and DockerRunnerError('create aborted'); env value (GITHUB_CANARY) never appears in any thrown message or in `JSON.stringify(runner)`
   - exec: first event is `started` with a UUID; stdout/stderr/exit 0 ordering; exit 3; cwd/env/user passed to container.exec; stdin string written and stream ended; stdin async iterable; timeout → kill command executed through pid file + exit TIMEOUT; kill exec fails → container.kill fallback; abort signal → exit ABORTED; container 404 → exit `{ code: null, signal: 'GONE' }` and no throw
   - signal: runs `kill -INT` with the execRef pid file; non-zero exit resolves; 404 resolves
   - snapshot: non-git dir → null fields; branch/head/dirty/ahead-behind parsed; detached HEAD → branch null; summary truncated at 16 KB with `[truncated]`
   - destroy: stop+remove called with `{t:10}` / `{v:true, force:true}`; 404 on stop and remove → resolves; 304 on stop → continues to remove; other error → DockerRunnerError; calling twice resolves
   - health: running → healthy with uptime from clock; stopped → unhealthy with status/exit; OOMKilled → 'oom-killed'; 404 → gone
   - list: label filter includes `ah.instance=<instance>`; entries without `ah.workspace` dropped
   - createDockerWorkspaceRunner: dockerode constructed with resolved options (vi.mock)

6. `packages/core/package.json` — add to `exports`: `"./runner/docker": { "types": "./dist/runner/docker/index.d.ts", "import": "./dist/runner/docker/index.js" }` (this is the one out-of-folder edit; it keeps dockerode out of the main barrel so apps/web and the agent-runtime bundle never pull it). Mention it in the PR description.

Constraints:
- Follow /bymax-workflow:standards (JSDoc + headers, English, no enum, no suppression, it() comments). Functions ≤ 50 lines — split the snapshot parsing into small helpers (`parseAheadBehind`, `truncateSummary`) exported for direct tests.
- No new dependencies; owned paths only (+ the one package.json exports key).
- Do not call the real Docker daemon in this task's tests.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green; 100 % on `src/runner/docker/**`
- `pnpm typecheck && pnpm lint` — exit 0 (lint must not flag the dockerode import in index.ts thanks to the W0 override glob)
- `pnpm --filter @agent-hangar/core build && node -e "import('@agent-hangar/core/runner/docker').then(m => console.log(typeof m.createDockerWorkspaceRunner))"` from apps/worker → prints `function`

Completion Protocol: update status/AC/progress in docs/tasks/wave-1b-docker-runner.md; append `- 1B.3 ✅ <date> — <summary>`; commit `feat(core): implement DockerWorkspaceRunner over dockerode`.
````

---

## Task 1B.4 — Workspace image hardening/verification, askpass token-file support, README, `@docker` integration suite

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** M · **Depends on:** 1B.3

**Description.** Verify and finish the workspace image W0 started (build time, non-root, tools present, no secrets in image config, placeholder intact), extend `askpass.sh` to read the token from `AH_GIT_TOKEN_FILE` when set (so W1-D's runtime can keep `GITHUB_TOKEN` out of the agent's shell env), prepare `.dockerignore`/`.gitignore` for the runtime bundle W1-D will drop into `infra/workspace/runtime/`, write `infra/workspace/README.md`, and add the `@docker` integration suite covering every behaviour listed in spec 06 §3 for the runner.

**Acceptance criteria**
- [ ] `docker build -t agent-hangar/workspace:dev infra/workspace` succeeds in < 3 min on a warm cache; `docker run --rm agent-hangar/workspace:dev id -u` → `1001`; `git`, `rg`, `jq`, `python3`, `node`, `pnpm` (corepack) resolve; `docker image inspect` shows `Config.User=agent`, `WorkingDir=/workspace`, `Entrypoint=["sleep","infinity"]`, and no `Env` entry matching `TOKEN|KEY|SECRET`
- [ ] The placeholder `# --- AGENT RUNTIME BUNDLE (added by W1-D) ---` is present and untouched; `.dockerignore` allows `runtime/`; `infra/workspace/.gitignore` ignores `runtime/`
- [ ] `askpass.sh`: Username prompt → `x-access-token`; otherwise prints the content of `$AH_GIT_TOKEN_FILE` when that variable is set and the file is readable, else `$GITHUB_TOKEN`; never echoes the prompt; exit 0
- [ ] `infra/workspace/README.md` documents contents, build command, security properties, the W1-D COPY lines that will be added, and the `infra:image` flow
- [ ] `packages/core/src/runner/docker/docker-workspace-runner.integration.test.ts` (describe tagged `@docker`) green locally with `DOCKER_AVAILABLE=1`; fails loudly with `CI=1` and no Docker; skips with a printed instruction otherwise

**Files to create/modify**
`infra/workspace/{Dockerfile (minimal hardening only), askpass.sh, .dockerignore, .gitignore, README.md}`, `packages/core/src/runner/docker/docker-workspace-runner.integration.test.ts`, `packages/core/src/runner/docker/testing/docker-available.ts` (gate helper).

**Agent prompt**

````
You are a senior platform engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: macOS + Docker Desktop (OrbStack/Colima compatible) · workspace image node:24-bookworm-slim · dockerode 5 · Vitest 4 (integration split via `*.integration.test.ts` + `pnpm --filter @agent-hangar/core test:integration`, as W0 configured).
Branch feat/w1b-docker-runner (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-B 🐳 — Task 1B.4 of 5 (MIDDLE)

PRECONDITIONS
- Tasks 1B.1–1B.3 done (runner implemented, 100 % unit coverage).
- infra/workspace/{Dockerfile, askpass.sh, .dockerignore} exist from W0 (Task 0.6): base image, user agent uid 1001, /workspace, askpass at /opt/agent-runtime/askpass.sh, git config, the placeholder comment, ENTRYPOINT sleep infinity.
- Docker is available on your machine (this is the 🐳 lane). Use `AH_INSTANCE=test` conventions for everything you create.

REQUIRED READING (only these):
- docs/spec/05-local-dev.md § "5. docker-compose services" → "Workspace image" subsection, § "3. Environment model" (WORKSPACE_IMAGE row)
- docs/spec/06-testing.md § "3. Integration tests" (DockerWorkspaceRunner bullet) and the first paragraph of § 3 (loud skip rule)
- docs/plan.md § "6. Wave 1" W1-B and W1-D blocks (Dockerfile COPY coordination), § "11. Orchestrator protocol" (MERGE ORDER paragraph)
- infra/workspace/Dockerfile, infra/workspace/askpass.sh, infra/workspace/.dockerignore (current state)
- packages/core/src/runner/docker/index.ts (what you are testing)

TASK
Verify and finish the workspace image, make askpass.sh support a token file, prepare the image folder for the W1-D runtime bundle, document it, and write the real-Docker integration suite for the runner.

DELIVERABLES

1. `infra/workspace/Dockerfile` — keep W0's structure. Allowed changes only: (a) add `LABEL org.opencontainers.image.title="agent-hangar-workspace"` and `LABEL ah.image="workspace"` near the top; (b) make sure `/tmp` is not baked with content; (c) ensure `chmod 755 /opt/agent-runtime/askpass.sh` and `mkdir -p /opt/agent-runtime && chown -R agent:agent /opt/agent-runtime`; (d) `ENV GIT_TERMINAL_PROMPT=0`. Do NOT add the runtime COPY lines and do NOT move/rename the placeholder comment `# --- AGENT RUNTIME BUNDLE (added by W1-D) ---`. No secrets, no `.env`, no repo sources.
2. `infra/workspace/askpass.sh` — POSIX sh:
   ```sh
   #!/bin/sh
   # Git credential helper for GIT_ASKPASS. Prints the username for "Username" prompts and the
   # token otherwise. The token comes from AH_GIT_TOKEN_FILE (written by the agent runtime so the
   # agent's shell env never carries GITHUB_TOKEN) or, as a fallback, from GITHUB_TOKEN.
   case "$1" in *Username*) printf 'x-access-token\n'; exit 0;; esac
   if [ -n "${AH_GIT_TOKEN_FILE:-}" ] && [ -r "$AH_GIT_TOKEN_FILE" ]; then cat "$AH_GIT_TOKEN_FILE"; printf '\n'; exit 0; fi
   printf '%s\n' "${GITHUB_TOKEN:-}"
   ```
   Test it in the integration suite (see 6) by exec'ing it inside a container with a token file and with the env var.
3. `infra/workspace/.dockerignore` — keep "ignore everything" and explicitly allow `!Dockerfile`, `!askpass.sh`, `!runtime/` (the folder W1-D's bundle is copied into by `pnpm infra:image`). `infra/workspace/.gitignore` with a single line `runtime/` (the copied bundle is a build artifact).
4. `infra/workspace/README.md` (English) — sections: What is in the image (base, tools, user, dirs, entrypoint) · Build (`pnpm infra:image` and the raw `docker build -t agent-hangar/workspace:dev infra/workspace`) · Runtime bundle (explain the placeholder; the exact two lines W1-D's PR asks the orchestrator to add:
   `COPY --chown=agent:agent runtime/cli.js /opt/agent-runtime/cli.js`
   `COPY --chown=agent:agent runtime/cli.js.map /opt/agent-runtime/cli.js.map`
   and that `pnpm infra:image` first builds `@agent-hangar/agent-runtime` and copies `dist/cli.js*` into `infra/workspace/runtime/` — see W1-D's task file) · askpass and the token file contract (`AH_GIT_TOKEN_FILE` → `GITHUB_TOKEN` fallback; Username → `x-access-token`) · Security properties (non-root, cap-drop ALL, no-new-privileges, tmpfs /tmp, no mounts, bridge egress only — enforced by the runner, listed here for readers) · How to verify (`docker image inspect` commands) · Troubleshooting (image missing → `WorkspaceImageMissing`, socket resolution order).
5. `packages/core/src/runner/docker/testing/docker-available.ts` — `export function dockerGate(): { run: boolean; reason: string }`: `process.env.DOCKER_AVAILABLE === '1'` → run; else if `process.env.CI` → **throw** `new Error('Integration suite requires DOCKER_AVAILABLE=1 in CI (Docker daemon + workspace image). Refusing to skip silently.')`; else run=false with reason `'set DOCKER_AVAILABLE=1 (and build the image with pnpm infra:image) to run the @docker suite'`. Unit-test all three branches (include this file in coverage).
6. `packages/core/src/runner/docker/docker-workspace-runner.integration.test.ts` — `const gate = dockerGate(); (gate.run ? describe : describe.skip)('@docker DockerWorkspaceRunner', …)` with `console.warn(gate.reason)` when skipping. Setup: `createDockerWorkspaceRunner({ instance: 'test', namePrefix: 'ah-ws-test-' })`, image = `process.env.WORKSPACE_IMAGE ?? 'agent-hangar/workspace:dev'`, helper `spec(id, extra?)` building a WorkspaceSpec with limits `{ cpus: 1, memoryBytes: 512 MiB, pids: 256 }`, labels `{ 'ah.chat': 'chat-test' }`, env `{ AH_TEST_VAR: 'visible', GITHUB_TOKEN: GITHUB_CANARY }`; `afterEach` destroys created handles; `afterAll` `list({})` and destroys leftovers; `testTimeout` 60 s. Helper `collect(runner.exec(...))` → `{ execRef, stdout, stderr, exit }`. it() list (every bullet of spec 06 §3 for the runner):
   - create → health healthy with uptimeMs ≥ 0
   - exec `echo hello` → first event `started`, stdout "hello\n", exit 0
   - exec `cat` with stdin "ping" → stdout "ping", exit 0 (stdin closed → cat exits)
   - exec `sh -c 'exit 3'` → exit 3; exec with `cwd: '/tmp'` and `pwd` → "/tmp"
   - exec `sleep 30` with `timeoutMs: 1000` → exit `{ code: null, signal: 'TIMEOUT' }` within 5 s, and a following `exec echo ok` still works (container alive)
   - signal INT reaches the process: exec `sh -c 'trap "echo got-int; exit 130" INT; while :; do sleep 0.2; done'`, wait for `started`, `signal(handle, execRef, 'INT')` → stdout contains `got-int`, exit 130
   - snapshot on a real git repo: exec `git init -b main && git -c user.name=t -c user.email=t@t commit --allow-empty -m init && echo x > f.txt` → snapshot `branch 'main'`, 40-hex headSha, `dirty true`, ahead/behind 0, summary contains `f.txt`
   - destroy → health gone; destroy again resolves
   - list by labels: two workspaces with different `ah.chat`, `list({ 'ah.chat': 'a' })` returns only A; `list({})` returns both
   - isolation: write `/workspace/only-a` in A → `ls /workspace` in B does not show it
   - limits applied: `docker inspect` via the runner's own Docker API or `docker inspect` CLI → `HostConfig.Memory === 512 MiB`, `PidsLimit === 256`, `NanoCpus === 1e9`, `CapDrop` contains `ALL`, `SecurityOpt` contains `no-new-privileges`, `Tmpfs['/tmp']` defined, `Binds`/`Mounts` empty, `NetworkMode 'bridge'`, `Config.User 'agent'`
   - env injected: exec `printenv AH_TEST_VAR` → "visible"; image config: `docker image inspect` `Config.Env` has no entry containing `AH_TEST_VAR`, `TOKEN`, `KEY`; `GITHUB_TOKEN` value is present in the container (by design) but `assertNoCanary(JSON.stringify(image inspect))` passes
   - askpass: exec `sh -c 'printf "%s" "$GITHUB_TOKEN" > /tmp/tok && AH_GIT_TOKEN_FILE=/tmp/tok /opt/agent-runtime/askpass.sh "Password for https://github.com"'` → prints the canary; `/opt/agent-runtime/askpass.sh "Username for https://github.com"` → `x-access-token`; without the file → falls back to `$GITHUB_TOKEN`
   - missing image → `create({ image: 'agent-hangar/does-not-exist:nope' })` rejects with `WorkspaceImageMissing` whose message contains `pnpm infra:image`
   - image properties: `id -u` → 1001; `git --version`, `rg --version`, `jq --version`, `python3 --version`, `node --version` (v24), `pnpm --version` all exit 0
7. Manual verification of the image (record the numbers in the PR description): `time docker build -t agent-hangar/workspace:dev infra/workspace` (< 3 min warm), `docker image inspect agent-hangar/workspace:dev --format '{{json .Config}}' | grep -Ei 'token|secret|api_key'` → no output.

Constraints:
- Follow /bymax-workflow:standards (headers, JSDoc, English, it() comments). Shell must run under macOS bash 3.2 / dash.
- Use canaries from @agent-hangar/core/testing for any secret-shaped value; never real-looking tokens.
- Owned paths only; no root package.json edits (the `infra:image` script exists; W1-D's PR carries the script change request).
- No new dependencies.

Verification:
- `docker build -t agent-hangar/workspace:dev infra/workspace` — succeeds
- `DOCKER_AVAILABLE=1 pnpm --filter @agent-hangar/core test:integration` — `@docker` suite green; no `ah-ws-test-*` containers left (`docker ps -a --filter label=ah.instance=test` empty)
- `CI=1 pnpm --filter @agent-hangar/core test:integration` without DOCKER_AVAILABLE — fails with the loud message
- `pnpm --filter @agent-hangar/core test -- --coverage` — still 100 % on src/runner/docker/** (gate helper included)
- `pnpm typecheck && pnpm lint && pnpm format:check` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1b-docker-runner.md; append `- 1B.4 ✅ <date> — <summary>`; commits `build(infra): harden workspace image, token-file askpass and document it` and `test(core): add @docker integration suite for DockerWorkspaceRunner`.
````

---

## Task 1B.5 — Close-out: gates, code review, plan dashboard, PR

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** S · **Depends on:** 1B.1–1B.4

**Description.** Run every gate, take `/bymax-quality:code-review` to zero findings, update the plan dashboard and the task index, open the PR with the structured summary from plan §11 (including the coordination notes for the orchestrator), and return the result object.

**Acceptance criteria**
- [ ] `pnpm lint && pnpm format:check && pnpm typecheck && pnpm --filter @agent-hangar/core test -- --coverage` green; coverage 100/100/100/100 on `src/runner/docker/**`
- [ ] `DOCKER_AVAILABLE=1 pnpm --filter @agent-hangar/core test:integration` green locally (evidence pasted in the PR)
- [ ] `/bymax-quality:code-review` run on the branch with zero open findings (no suppressions)
- [ ] `docs/plan.md` §12 row W1-B → 🟨 with branch/PR; `docs/tasks/README.md` row updated; PR opened; result object returned

**Files to create/modify**
`docs/plan.md` (§12 row only), `docs/tasks/README.md` (W1-B row only), this file (header + log).

**Agent prompt**

````
You are a senior engineer closing out lane W1-B of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 · Node 24 · dockerode 5 · Vitest 4 · GitHub CLI.
Branch feat/w1b-docker-runner (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-B 🐳 — Task 1B.5 of 5 (LAST)

PRECONDITIONS
- Tasks 1B.1–1B.4 done and committed on this branch.

REQUIRED READING (only these):
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard"
- docs/tasks/README.md
- CLAUDE.md (gates list)

TASK
Run all gates, fix every review finding, update the dashboards, open the PR and return the structured result.

DELIVERABLES

1. Gates, all green: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm --filter @agent-hangar/core test -- --coverage` (100 % lines/branches/functions/statements on `src/runner/docker/**` incl. `testing/**`), `DOCKER_AVAILABLE=1 pnpm --filter @agent-hangar/core test:integration` (the `@docker` suite; paste the summary line into the PR). `pnpm build` also passes (core build + subpath export resolvable).
2. Run `/bymax-quality:code-review` on the branch (scope: `main..HEAD`). Resolve EVERY finding — CRITICAL, HIGH, MEDIUM, LOW — by changing code (no suppression comments, no `// eslint-disable`, no `@ts-expect-error`). Re-run the gates after fixes. Repeat until zero findings.
3. Update `docs/plan.md` §12 row `W1-B 🐳` → `🟨 PR open`, branch `feat/w1b-docker-runner`, PR number; coverage column `100/100/100/100 (runner/docker)`; notes: "subpath export `@agent-hangar/core/runner/docker`; askpass supports AH_GIT_TOKEN_FILE". Update `docs/tasks/README.md` row W1-B (status 🟨, link). Update this file's header (Status 🟨 PR open, Progress 5/5).
4. Open the PR: `gh pr create --base main --head feat/w1b-docker-runner --title "feat(core): DockerWorkspaceRunner and workspace image (W1-B)" --body-file <generated>`. Body sections: Summary · What was built (file list) · Out-of-folder edits (vitest coverage.include; package.json exports subpath) · Coordination notes for the orchestrator (1. apply W1-D's two Dockerfile COPY lines under the placeholder when merging the later of W1-B/W1-D; 2. askpass.sh now honours AH_GIT_TOKEN_FILE — W1-D relies on it; 3. consumers import the runner from `@agent-hangar/core/runner/docker`) · How to run (`pnpm infra:image`, `DOCKER_AVAILABLE=1 pnpm --filter @agent-hangar/core test:integration`) · Gate results · Coverage numbers · Image build time and `docker image inspect` secret grep result · Known gaps (none expected; list any).
5. Return to the orchestrator exactly: `{ pr: <number>, branch: 'feat/w1b-docker-runner', headSha: '<sha>', gates: { lint, format, typecheck, unit, integrationDocker, build }, coverage: { lines: 100, branches: 100, functions: 100, statements: 100 }, contractChangeRequests: [] }` (if you had to request any contract change, list it with the file path and reason instead of an empty array).

Constraints:
- English; Conventional Commits; no AI-attribution trailers anywhere (commits, PR body, comments).
- Do not wait for CI; do not merge; do not edit paths outside your ownership except the three dashboard files named above.

Verification:
- `gh pr view --json number,headRefOid,url` — PR exists and headRefOid equals `git rev-parse HEAD`
- `git status --porcelain` — empty; `git log --format=%B main..HEAD | grep -i "co-authored-by\|generated with"` — no output

Completion Protocol: update status/AC/progress in docs/tasks/wave-1b-docker-runner.md (lane header Status → 🟨 PR open); append `- 1B.5 ✅ <date> — PR #<n> opened`; commit `docs(tasks): close out lane W1-B` before opening the PR.
````

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)
