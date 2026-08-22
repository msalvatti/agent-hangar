# 06 — Testing Strategy

| | |
|---|---|
| **Status** | ✅ Approved — 2026-08-19 |
| **Revision** | 2026-08-20 — corrected against `.github/workflows/ci.yml` and the Vitest configs: coverage policy raised from the tiered numbers originally written here to 100 % on four metrics everywhere, mutation scope expanded to `packages/agent-runtime`, and the CI job list matched to what actually runs |
| **Owner** | Maximiliano |
| **Last updated** | 2026-08-19 |

Principle: tests verify **behaviour**, not line coverage. The mutation gate on `packages/core` is the real quality signal; coverage is a floor, not the goal.

## 1. Layers

| Layer | Tool | Runs against | Where | Runtime budget |
|---|---|---|---|---|
| Unit | Vitest 4 | pure functions, fakes | every package | < 30 s |
| Integration | Vitest 4 | real local Docker, Postgres, Redis (compose test profile) | `packages/core`, `apps/worker`, `apps/web` | < 5 min |
| E2E | Playwright 1.62 | full stack with `AGENT_MODEL_PROVIDER=fake` | `apps/web/e2e` | < 5 min |
| Mutation | Stryker 10 + `@stryker-mutator/vitest-runner` | unit suites of the mutated packages | `packages/core`, `packages/agent-runtime` | < 10 min (CI incremental) |

Coverage thresholds (Vitest `coverage.thresholds`): **100 % lines, branches, functions and statements** on every path a package lists in `coverage.include`, in all four workspaces and in the `scripts` project — the bar was raised from the tiered numbers originally written here and is enforced by the configuration, never lowered in a diff. Composition roots that only wire real clients together are excluded and their logic is tested through fakes instead (`apps/worker/src/main.ts`, `packages/agent-runtime/src/bin.ts`), as is the generated shadcn code under `apps/web/src/shared/ui/**`. Every `it()` carries a one-line comment stating the behaviour proved.

## 2. Unit tests (fast, no I/O)

`packages/core`

- **secrets/** — AES-256-GCM roundtrip; different iv per write; tampered ciphertext/authTag throws `SecretIntegrityError`; wrong key throws; `last4` for values shorter than 4; master key file: created 0600 when missing, refused when world-readable, `keyVersion` preserved; `reveal` never returns for unknown key.
- **redaction/** — exact-value redaction (including values appearing inside JSON and URLs), shape patterns (`ghp_`, `github_pat_`, `sk-`, `sk-proj-`, `Bearer`), `redactJson` deep objects/arrays, idempotence, no false positive on ordinary hex; pino serializer integration.
- **scheduling/** — cron validation (5-field, tz), `nextRunAt` computation across DST boundaries, overlap policy decision, scheduler key = job id, reconcile diff (DB vs scheduler list → upsert/remove sets).
- **workspace lifecycle/** — state machine transitions (`CREATING→READY→BUSY→READY→DESTROYED`, illegal transitions throw), "ensure workspace" decision (live? restore? image missing?), idle-TTL selection, the collector's three reconciliation arms (orphan container, missing container, abandoned teardown — and `BUSY` excluded from all three), restore-context builder (ordering, windowing, `TOOL_SUMMARY` compaction, restoration notice text, `expectedHeadSha` propagation).
- **agent-protocol/** — Zod schemas for `TurnRequest`/`AgentEvent`; NDJSON framing (partial lines, multiple events per chunk, invalid line → `protocol.error`, never throws the stream).
- **model/openai/** — event mapping from recorded Responses API stream fixtures (text deltas, function call arguments deltas, completed with usage, failed, 401/429 mapping) using a fake SDK client; model id comes from config; `store:false` sent.
- **runner/docker/** — pure parts only: socket resolution order, container spec builder (labels, limits, security opts, env), exec demux parser; dockerode itself is faked here (real Docker in integration).
- **config/** — env schema: defaults derived from `AH_INSTANCE`/`AH_PORT_BASE`, Conductor var precedence, slugification.

`packages/agent-runtime`

- Tool implementations against a temp dir: path confinement (`../`, absolute, symlink escape), truncation with notice, `run_shell` timeout and exit code, env scrubbing (no `GITHUB_TOKEN`/`OPENAI_API_KEY` in child env, `GIT_ASKPASS` present).
- Loop with a `FakeAgentModelProvider` (scripted events): stops when no tool calls; honours `maxSteps`; cancellation via `AbortSignal` emits `turn.cancelled`; every tool call yields `tool.call` + `tool.result`; `git.pushed` detection from `run_shell` output.

`apps/web`

- Route handlers with fake repositories/queues: validation errors, archive/restore state changes, settings responses never contain plaintext, SSE framing helper (id/event/data, heartbeat), and a resume point the stream no longer holds refused rather than replayed from what survives.
- UI components (Vitest + Testing Library): masked secret field, composer disabled states, tool-call card rendering of redacted args, streaming reducer.

`apps/worker`

- Turn processor with fake runner + fake provider: persists messages/tool logs in order, sets statuses, destroys job workspaces in `finally`, stalled-job recovery path.

## 3. Integration tests (real local infrastructure)

Run with `pnpm test:integration`; compose test profile brings up `postgres`/`redis` on `AH_INSTANCE=test` ports; Docker socket required (skipped with a loud message if absent, **never** silently green).

- **DockerWorkspaceRunner** (`packages/core`, tag `@docker`): `create` → `health` healthy → `exec echo` streams stdout → `exec` with stdin → `exec` timeout kills → `signal INT` reaches process → `snapshot` on a real git repo (dirty/ahead) → `destroy` → `health` gone; `list` by labels; `imageExists` answers `true` for the built image and `false` for one the host does not have; two concurrent workspaces have different filesystems (write in A, not visible in B); limits applied (`docker inspect` shows memory/pids); env injected visible to process but image has none; missing image → `WorkspaceImageMissing`.
- **Persistence** (Prisma against Postgres): repositories redact on write (canary value never stored), message `seq` gap-free under concurrency (transaction), partial unique index "one live workspace per chat", cascades.
- **Queues** (BullMQ against Redis): `upsertJobScheduler` creates exactly one scheduler per job; edit updates pattern; disable removes; reconcile on boot converges; worker `maxRetriesPerRequest:null`.
- **SSE endpoint**: XADD events → client receives framed events; `Last-Event-ID` replay returns only later entries; heartbeat present; stream expiry → `event: expired`; a resume point a real `XTRIM` has removed → `event: expired` and close, never the surviving tail.
- **Worker end-to-end with fake provider + real Docker**: `run-turn` job → container created → agent-runtime executes scripted tool calls (`write_file`, `run_shell`) in the container → ToolCallLog rows, Message rows, Turn SUCCEEDED → idle GC destroys → next turn restores and `prepare.done` emitted; a row parked in `STOPPING` with its container still up has that container really removed by the next collection pass; the published heartbeat reports the real image presence.

## 4. Playwright E2E (critical flows)

Stack: `pnpm dev` in test mode (`AGENT_MODEL_PROVIDER=fake`, real Docker, real Postgres/Redis on the test instance, a local git server container — `infra/test/gitserver` — so no GitHub network is needed; GitHub API calls for the repo picker are served by an MSW mock in test mode). Each spec resets the DB.

| Spec | Steps | Asserts |
|---|---|---|
| `chat-create-run.spec` | Open app → New chat → choose repo/branch → send "list files and create NOTES.md" | Transcript streams `Cloning…`, tool cards for `list_dir`/`write_file`, final assistant message; status pill goes Preparing → Running → Done; DB has Turn SUCCEEDED |
| `chat-archive-restore.spec` | Continue above → Archive → chat appears in Archived → Restore → send "show NOTES.md" | After archive, container gone (`docker ps` via API `/api/health` counters); after restore, system notice visible, new turn shows `Cloning…`, history intact |
| `scheduled-job-run.spec` | Scheduled → New job (cron `* * * * *`, prompt "print date") → wait ≤ 90 s (or click Run now) | Run row appears, status Succeeded, output visible; opening run shows tool calls, and the push line when the run pushed; `/api/health` shows zero live job workspaces |
| `settings-save-mask.spec` | Settings → paste fake PAT `ghp_…` + key `sk-…` → Save → reload | Fields show `••••••••<last4>`; `GET /api/settings` body has no plaintext; Replace/Remove work; a turn run afterwards logs contain `[REDACTED]` where the canary would be |
| `settings-missing.spec` | No secrets → New chat | Composer blocked with link to Settings; no container created |
| `cancel-turn.spec` | Fake provider scripted with a long `run_shell sleep 60` → Cancel | Turn CANCELLED within 5 s, workspace still READY |

Playwright runs headless in CI on `ubuntu-latest` (Docker available); locally `pnpm test:e2e --ui`.

## 5. Mutation testing (Stryker)

Scope = the modules where a surviving mutant would mean a real defect:

| Package | Mutated directories | Break threshold |
|---|---|---|
| `packages/core` | `src/secrets/**`, `src/redaction/**`, `src/scheduling/**`, `src/workspace/**` (lifecycle + restore context), `src/agent-protocol/**`, `src/model/openai/mapping.ts` | **80** (CI fails below); target 90 |
| `packages/agent-runtime` | `src/tools/**` (path confinement, truncation, env scrubbing) | **80** |

Config notes (from prior experience): vitest runner version pinned equal to core; `incremental: true` only on full-scope runs; `concurrency: 2`; no `// Stryker disable` without a one-line reason; equivalent mutants fixed by changing code to the value that serves, not by suppression. Reports uploaded as CI artifacts (`reports/mutation/`).

## 6. CI pipeline (`.github/workflows/ci.yml`)

Jobs on `ubuntu-latest`, Node 24, pnpm 11 via `pnpm/setup@v2` with store cache:

1. **lint** — ESLint (flat config, `no-restricted-imports` for dockerode outside the runner), Prettier check, and a suppression ban.
2. **typecheck** — `tsc -b` across workspaces.
3. **unit** — Vitest with coverage thresholds; uploads `coverage/`.
4. **integration** — services `postgres:18`, `redis:8`; `AH_INSTANCE=test`, `DOCKER_AVAILABLE=1` and `AH_ALLOW_DESTRUCTIVE_TESTS=1` so nothing is skipped silently; builds the workspace image first.
5. **e2e** — Playwright with the fake provider; traces on failure. One job, run twice from a matrix over `E2E_MODE`. The `mock` leg drives a production build against the in-browser mock API and is the only one that exercises the bootstrap the app ships for a developer with no infrastructure; the `real` leg runs the whole stack and is the only one that reaches the worker, a workspace container, the runtime and the local git server. Neither is a superset of the other, so both are required and `fail-fast` is off. Each leg uploads its report under its own name.
6. **build** — `pnpm build` and `docker build` of the workspace image; smoke-start the image and run `node cli.js --version`.
7. **secret-scan** — `gitleaks` through its container image: the working tree, the commits of the pull request, and the full history on `main`.

The **mutation** job described in §5 is not part of the pipeline yet; it is added once both packages define `test:mutation` and pass their thresholds.

No `continue-on-error` anywhere, and every job declares `timeout-minutes`. Branch protection on `main` currently requires no check: the repository is a single-maintainer, pull-request-only branch, and the gate that holds is the review before the merge rather than a server-side rule. Requiring the checks is a settings change, not a pipeline one — the names to require are `lint`, `typecheck`, `unit`, `integration`, `e2e (mock)`, `e2e (real)`, `build` and `secret-scan`.

## 7. Test doubles (kept in `packages/core/src/testing/`)

- `FakeWorkspaceRunner` — in-memory filesystem per handle, scripted exec responses; used by worker and web tests.
- `FakeAgentModelProvider` — plays a script of `ModelEvent`s keyed by the last user message; supports delays and tool-call sequences; used by unit, integration, and E2E (`AGENT_MODEL_PROVIDER=fake`).
- `FakeClock`, `FakeKeyFile`, recorded OpenAI stream fixtures (`fixtures/openai/*.ndjson`, captured once with a real key and redacted).
