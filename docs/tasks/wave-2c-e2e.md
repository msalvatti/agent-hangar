# Wave 2 — Lane W2-C — Playwright E2E harness + specs (authoring)

| | |
|---|---|
| **Lane** | W2-C (one agent; runs in parallel with W2-A and W2-B 🐳) |
| **Status** | 🟨 In review |
| **Progress** | 6/6 tasks |
| **Branch** | `feat/w2c-e2e` |
| **Owned paths** | `apps/web/e2e/**`, `infra/test/gitserver/**`, `apps/web/playwright.config.ts` (`webServer`, `globalSetup`/`globalTeardown`, projects) · plus, by explicit exception: `apps/web/package.json` (`scripts.test:e2e` only), `.github/workflows/ci.yml` (**body of the `e2e` job only**) |
| **Depends on** | W0, W1-G (shell + chats UI, MSW), W1-H (scheduled + settings UI, MSW) — merged to `main`. W2-A/W2-B may still be in progress: specs are authored against the UI + mocked API and only fully executed in W3-A |
| **Unblocks** | W3-A (end-to-end wiring & stabilisation runs the suite for real) |
| **Source** | [docs/plan.md §7 W2-C](../plan.md) · spec [06 §4](../spec/06-testing.md) [04 (a)(b)(c)(d)](../spec/04-flows.md) [10 §3–4](../spec/10-ui-design.md) [05 §3](../spec/05-local-dev.md) |
| **Last updated** | 2026-08-20 |

## Context

Spec 06 §4 defines six Playwright specs that prove the product's critical flows against the **full stack** (real Postgres/Redis on the `test` instance, real Docker workspaces, `AGENT_MODEL_PROVIDER=fake`, a local git server container so no GitHub network is needed, a local stub for the GitHub REST API used by the repo picker). This lane builds the harness and writes those six specs **now**, in parallel with the API (W2-A) and worker (W2-B) lanes, so that W3-A only has to run, fix and stabilise — not author.

Because the backend is not finished while this lane runs, every spec is written to two modes selected by `E2E_MODE`:

- **`mock`** — the Next dev server runs with `NEXT_PUBLIC_API_MOCK=1` (W1-G/H MSW handlers). No Docker, no compose, no worker. Every selector and page-object interaction is exercised; assertions that need the real stack are guarded and mark the test **skipped at that point** (`test.skip(isMock, '…')`) rather than failing. This is how W2-C validates its own work and how CI runs the `e2e` job until W3-A flips it.
- **`real`** — full stack as spec 06 §4 describes. W3-A is the first lane to run it end to end; this lane must make it bootable (compose up, migrate, gitserver, stub, web + worker via Playwright `webServer`) and leave TODO-free specs.

Infrastructure decisions taken here (state them in the PR description):

1. **Local git server** = a tiny image in `infra/test/gitserver/` (`node:24-bookworm-slim` + `git`) running a ~90-line Node HTTP shim that delegates to `git http-backend` (smart HTTP, receive-pack enabled), serving bare repos from `/repos`. Smart HTTP was chosen over `git daemon` because the workspace runtime clones `http(s)://` URLs through `GIT_ASKPASS` exactly like GitHub, so no scheme exception is needed anywhere. The seed repo is `/repos/sample.git` (`main` branch, a README and a `src/index.js`).
2. **Reachability from workspace containers**: the gitserver port is published on the host (`0.0.0.0:<AH_PORT_BASE+7>`) and repo URLs use `E2E_GITSERVER_HOST` (default `host.docker.internal` — Docker Desktop/OrbStack; the CI job sets `172.17.0.1`, the Linux `docker0` gateway). The API must allow that host: `ALLOWED_REPO_HOSTS=github.com,<E2E_GITSERVER_HOST>` (config var added by W2-A — if absent on `main` when you start, it is a contractChangeRequest).
3. **GitHub API stub** = an in-process Node `http` server (`apps/web/e2e/support/github-stub.ts`) on `127.0.0.1:<AH_PORT_BASE+8>` answering `/user/repos`, `/repos/:owner/:repo`, `/repos/:owner/:repo/branches` with fixtures whose `html_url` points at the gitserver; the web server receives `GITHUB_API_BASE_URL=http://127.0.0.1:<port>` (config var added by W2-A).
4. **Fake provider script** is data: `apps/web/e2e/fake-provider/script.json` (`Record<prompt, ScriptedStep[]>` — the `FakeAgentModelProvider` script shape from W0, which is JSON-serialisable). The worker in fake mode loads it from `FAKE_PROVIDER_SCRIPT_PATH` (contract for W1-C's registry / W2-B — contractChangeRequest if not supported).
5. **Test instance** = `AH_INSTANCE=test`, `AH_PORT_BASE=${E2E_PORT_BASE:-3900}` → web 3900, postgres 3901, redis 3902, gitserver 3907, github stub 3908. Compose project `agent-hangar-test`, DB `agent_hangar_test`, workspace prefix `ah-ws-test-` — nothing collides with a developer's `default` instance.

## Rules of this lane

1. **Owned paths only** (table above). Never edit `apps/web/src/**` or `apps/web/app/**`: if a selector you need does not exist and no accessible role/name reaches the element, record a **contractChangeRequest** for W1-G/W1-H listing the exact `data-testid` to add (Task 2C.3 produces that list) and write the page object against the id anyway, with a comment naming the request.
2. **No new dependencies.** `@playwright/test` 1.62, `@agent-hangar/core` (+ `/testing`), Node stdlib (`node:http`, `node:child_process`, `node:fs`) are all you need. The gitserver image uses apt/Node only.
3. Specs are **deterministic**: no fixed `sleep`; use `expect.poll` / `toPass` with explicit timeouts named in a constants file; each test starts from a reset DB (and, in real mode, reaped `ah-ws-test-*` containers, flushed test Redis queues through the API).
4. **Canaries only** for secrets (`GITHUB_CANARY`, `OPENAI_CANARY` from `@agent-hangar/core/testing`); the suite asserts with `assertNoCanary` wherever plaintext could leak (API bodies, transcript text, tool-call args).
5. Gates for this lane: `pnpm lint`, `pnpm format:check`, `pnpm typecheck` (the `e2e/` folder is type-checked — it has its own `tsconfig.json` referencing the web one), `pnpm --filter web test:e2e` in `mock` mode green (all six spec files run; real-stack assertions skipped with the reason text), harness unit tests (Vitest, for the pure helpers: env resolution, fixture parsing, stub routing) 100 % on `apps/web/e2e/support/**` pure modules — include `'e2e/support/**'` in `apps/web/vitest.config.ts` `coverage.include` ONLY for the pure modules listed in Task 2C.2 (process-spawning helpers are excluded by name and exercised by the E2E run itself; say so in the config comment).
6. Standards: TypeScript strict, no `enum`, no suppression comments, JSDoc on every export + file header, every `test()`/`it()` preceded by a block comment stating the behaviour proved, English only, Conventional Commits, no AI-attribution trailers. Branch `feat/w2c-e2e`, one PR (Task 2C.6).

## Reference docs

- [docs/plan.md](../plan.md) § "3. Parallelism rules", § "7. Wave 2" (W2-C), § "8. Wave 3" (W3-A — what it expects from you), § "11. Orchestrator protocol"
- [spec 06 — Testing](../spec/06-testing.md) § "4. Playwright E2E" (the six specs), § "6. CI pipeline" (e2e job), § "7. Test doubles"
- [spec 04 — Sequence flows](../spec/04-flows.md) (a)(b)(c)(d) — what the UI must show at each step
- [spec 10 — UI design](../spec/10-ui-design.md) § "3. App shell", § "4. Screens" (states and copy the specs assert), § "8. Accessibility" (roles/names to prefer over test ids)
- [spec 05 — Local dev](../spec/05-local-dev.md) § "3. Environment model", § "5. docker-compose services"
- [spec 03 — Interface contracts](../spec/03-interfaces.md) § "4. HTTP API" (endpoints the specs call directly: `/api/health`, `/api/settings`, `/api/chats/:id`, `/api/jobs`)
- Code to read: `apps/web/src/features/**` and `apps/web/app/(app)/**` (W1-G/H components — selectors), `apps/web/src/mocks/**` (MSW behaviour in mock mode), `packages/core/src/testing/{fake-agent-model-provider,canaries}.ts` and `persistence/testing/db.ts` (`connectTestDb`, `truncateAll`), `packages/core/src/config/instance.ts` (`resolveInstance`), `infra/docker-compose.yml`, `infra/scripts/env.sh`, `.github/workflows/ci.yml`, `apps/web/playwright.config.ts` (W0 skeleton)

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 2C.1 | Local git server image + seed repo + GitHub API stub | ✅ | P0 | M | — |
| 2C.2 | Harness: env, Playwright config (`webServer`, modes), fixtures, DB reset, fake-provider script | ✅ | P0 | L | 2C.1 |
| 2C.3 | Page objects + selector contract validated against the MSW UI | ✅ | P0 | M | 2C.2 |
| 2C.4 | Chat specs: `chat-create-run`, `chat-archive-restore`, `cancel-turn` | ✅ | P0 | M | 2C.3 |
| 2C.5 | Scheduled + settings specs, CI `e2e` job body, mock-mode validation run | ✅ | P0 | M | 2C.3 |
| 2C.6 | Close-out: gates, code review, dashboard, PR | ✅ | P0 | S | 2C.1–2C.5 |

---

## Task 2C.1 — Local git server image + seed repo + GitHub API stub

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** Build the smallest git-over-HTTP server image that the workspace container can clone from and push to, with a deterministic seed repository; and an in-process stub of the GitHub REST endpoints the repo picker uses, returning URLs that point at that server.

**Acceptance criteria**
- [x] `infra/test/gitserver/Dockerfile` builds `agent-hangar/gitserver:test` (< 1 min, no npm deps); `server.mjs` (Node stdlib only) proxies `GET /<repo>.git/info/refs?service=…`, `POST /<repo>.git/git-upload-pack`, `POST /<repo>.git/git-receive-pack` to `git http-backend` with `GIT_PROJECT_ROOT=/repos`, `GIT_HTTP_EXPORT_ALL=1`, receive-pack enabled; `GET /healthz` → 200
- [x] `seed.sh` creates `/repos/sample.git` (bare, default branch `main`, commits: `README.md`, `src/index.js`, `.gitignore`) idempotently at container start; `docker run --rm -p 3907:8080 agent-hangar/gitserver:test` then `git clone http://127.0.0.1:3907/sample.git` works and a push of a new branch succeeds
- [x] `apps/web/e2e/support/github-stub.ts` exports `startGithubStub({ port, repoBaseUrl })` / `stop()` serving `/user/repos`, `/repos/:owner/:repo`, `/repos/:owner/:repo/branches` from fixtures; `401` when `Authorization` header is missing or not `Bearer ghp_…`; unknown path → 404; unit-tested (routing + payload shapes) at 100 %
- [x] `apps/web/e2e/support/gitserver.ts` exports `startGitServer({ port, image })`/`stopGitServer()` using `docker run -d --rm -p 0.0.0.0:<port>:8080 --name ah-e2e-gitserver-<instance>`, waits for `/healthz`, idempotent (reuses a running container), and `docker stop` on teardown

**Files to create**
`infra/test/gitserver/{Dockerfile,server.mjs,seed.sh,.dockerignore,README.md}`, `apps/web/e2e/support/{github-stub,github-stub.test,gitserver}.ts`, `apps/web/e2e/fixtures/github/{repos.json,branches.json}`.

**Agent prompt**

````
You are a senior platform + test engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — a local-first web app where AI agents answer questions and perform coding tasks against GitHub repositories inside isolated, disposable Docker workspaces; plus cron-scheduled jobs that run in fresh workspaces, and a settings page with encrypted credentials (GitHub PAT, OpenAI API key).
Stack: pnpm 11 workspaces · TypeScript ~6.0.3 strict · Node 24 LTS · Next.js 16.3 · Playwright 1.62 · Docker (Desktop/OrbStack locally, Engine on ubuntu-latest in CI) · git smart HTTP via `git http-backend`.
Specification lives in docs/spec/ (01–10); execution plan in docs/plan.md. You are in a git worktree on branch feat/w2c-e2e, branched off the latest main.

CURRENT LANE: W2-C (E2E harness + specs) — Task 2C.1 of 6 (FIRST)

PRECONDITIONS
- W0, W1-G, W1-H merged to main; branch off latest main. `pnpm install --frozen-lockfile && pnpm typecheck` pass.
- Docker available locally (`docker info`).
- Read CLAUDE.md (ownership map, gates, rules).

REQUIRED READING (only these):
- docs/spec/06-testing.md § "4. Playwright E2E" (first paragraph: stack description)
- docs/spec/03-interfaces.md § "3. Agent runtime protocol" (how the runtime clones: credential-free https URL + `GIT_ASKPASS`), § "4. HTTP API" (`GET /api/repos`, `GET /api/repos/branches`)
- docs/spec/05-local-dev.md § "3. Environment model" (port block)
- packages/core/src/api/contracts.ts (`repoSummary`, `branchSummary` — what the web maps GitHub payloads into; your stub returns GitHub-shaped JSON, not these)
- infra/workspace/Dockerfile and infra/workspace/askpass.sh (what the workspace has: git, askpass)

TASK
Create the local git server image with a seeded repository, a host-side launcher for it, and the GitHub REST stub the repo picker will hit in test mode.

DELIVERABLES

1. `infra/test/gitserver/Dockerfile`:
   `FROM node:24-bookworm-slim`; `apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*`; `COPY server.mjs seed.sh /srv/`; `RUN chmod +x /srv/seed.sh`; `VOLUME` not needed; `EXPOSE 8080`; `ENV GIT_PROJECT_ROOT=/repos GIT_HTTP_EXPORT_ALL=1`; `ENTRYPOINT ["/bin/sh","-c","/srv/seed.sh && exec node /srv/server.mjs"]`. Runs as root inside the test container (acceptable for a test fixture; say so in README.md).
2. `infra/test/gitserver/server.mjs` (ESM, stdlib only, ≈ 90 lines, JSDoc file header):
   - `http.createServer` on `0.0.0.0:8080`. `GET /healthz` → `200 ok`.
   - For any other path: match `^/([A-Za-z0-9._-]+\.git)(/.*)$`; else 404. Spawn `git http-backend` with env: `GIT_PROJECT_ROOT=/repos`, `GIT_HTTP_EXPORT_ALL=1`, `PATH_INFO=/<repo>.git<rest>`, `REQUEST_METHOD`, `QUERY_STRING` (from the URL), `CONTENT_TYPE` (request header), `CONTENT_LENGTH` if present, `REMOTE_ADDR=127.0.0.1`, `REMOTE_USER=e2e` (so receive-pack is permitted — `http.receivepack=true` is also set in `seed.sh`), `SERVER_PROTOCOL=HTTP/1.1`, `GATEWAY_INTERFACE=CGI/1.1`, `HTTP_CONTENT_ENCODING` if present. Pipe the request body to the child's stdin; parse the CGI response (headers until the first blank line, `Status:` header → status code, default 200), then pipe the rest to the response. On child error → 500. Log one line per request to stdout (`method path status ms`).
3. `infra/test/gitserver/seed.sh` (`#!/bin/sh`, `set -eu`): if `/repos/sample.git` is missing: `git init -q --bare --initial-branch=main /repos/sample.git`; `git -C /repos/sample.git config http.receivepack true`; create a temp work tree, `git init -q -b main`, write `README.md` ("# sample\n\nSeed repository for Agent Hangar E2E."), `src/index.js` (`console.log('hello from sample');`), `.gitignore` (`node_modules/`), commit as `E2E Seed <seed@localhost>` with fixed `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` (`2026-01-01T00:00:00Z`) so the seed SHA is deterministic, `git push -q /repos/sample.git main`; also push a second branch `feature/docs` with one extra commit touching `docs/notes.md` (the branch picker must list two branches). `git -C /repos/sample.git update-server-info`. Idempotent (guard on existence).
4. `infra/test/gitserver/.dockerignore` (`*` except the three files), `infra/test/gitserver/README.md` (6 lines: purpose, build/run commands, URL shape `http://<host>:<port>/sample.git`, "test fixture, not for production").
5. `apps/web/e2e/support/gitserver.ts`: `export interface GitServerHandle { url: string; containerName: string }`; `export async function startGitServer(opts: { port: number; image?: string; instance: string; host: string }): Promise<GitServerHandle>` — `docker image inspect <image>` else `docker build -t <image> infra/test/gitserver`; if a container named `ah-e2e-gitserver-<instance>` is running, reuse; else `docker run -d --rm --name … -p 0.0.0.0:<port>:8080 <image>`; poll `http://127.0.0.1:<port>/healthz` until 200 (timeout 60 s, `ETIMEDOUT`-safe); return `{ url: \`http://${opts.host}:${opts.port}\`, containerName }` (the `host` is what the WORKSPACE container will dial — `host.docker.internal` or `172.17.0.1` — while the health poll always uses 127.0.0.1). `export async function stopGitServer(handle): Promise<void>` — `docker stop` (ignore "No such container"). Use `node:child_process` `execFile` promisified; never `exec` with string interpolation.
6. `apps/web/e2e/support/github-stub.ts`: `export interface GithubStub { baseUrl: string; close(): Promise<void>; requests: Array<{ method: string; path: string; authorized: boolean }> }`; `export function startGithubStub(opts: { port: number; repoBaseUrl: string }): Promise<GithubStub>`. Pure router `export function routeGithubRequest(method, pathname, authHeader, fixtures): { status: number; body: unknown }` (unit-testable): no `Authorization` or not matching `/^Bearer ghp_[A-Za-z0-9]+$/` → 401 `{ message: 'Bad credentials' }`; `GET /user/repos` → fixtures `repos.json` with `html_url`/`clone_url` rewritten to `${repoBaseUrl}/${name}.git` and `full_name` `e2e/sample` (+ a second repo `e2e/other` to make the picker list meaningful); `GET /repos/e2e/sample` → repo object with `default_branch: 'main'`; `GET /repos/e2e/sample/branches` → `[{ name: 'main', commit: { sha } }, { name: 'feature/docs', commit: { sha } }]`; other → 404 `{ message: 'Not Found' }`. Fixtures in `apps/web/e2e/fixtures/github/*.json` (GitHub field names: `id`, `name`, `full_name`, `private`, `html_url`, `clone_url`, `default_branch`, `pushed_at`, `owner.login`).
7. Tests: `github-stub.test.ts` (Vitest, `/** @vitest-environment node */`) — every branch of `routeGithubRequest` (401 without header, 401 wrong scheme, repos with rewritten URLs, repo detail, branches, 404) and an `http` round trip on an ephemeral port (`port: 0`) asserting `requests[]` recording. `gitserver.ts` is exercised by the E2E run (it spawns Docker) — exclude it from coverage by name with a config comment.
8. Manual verification script (not committed as a test; run it and paste the output in the task log): build image; run on 3907; `git clone http://127.0.0.1:3907/sample.git /tmp/ah-sample && cd /tmp/ah-sample && git checkout -b agent/e2e && echo x > NOTES.md && git add . && git commit -qm "e2e" && git push origin agent/e2e` → push accepted; `git ls-remote http://127.0.0.1:3907/sample.git` lists `main`, `feature/docs`, `agent/e2e`.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression comments, it() comments).
- `server.mjs` has zero dependencies and no shell string interpolation (`spawn` with an args array).
- Deterministic seed (fixed dates/author) so specs can assert the seed SHA if needed.

Verification:
- `docker build -t agent-hangar/gitserver:test infra/test/gitserver` — succeeds
- The manual clone/push script above works
- `pnpm --filter web test -- --coverage e2e/support` — stub router 100 %
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-2c-e2e.md (task index row and task heading line)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/6 tasks`)
4. Append a completion log entry at the end of the file: `- 2C.1 ✅ <YYYY-MM-DD> — <one-line summary>`
5. Commit: `test(e2e): add local git server image and GitHub API stub`
````

---

## Task 2C.2 — Harness: env, Playwright config (`webServer`, modes), fixtures, DB reset, fake-provider script

**Status:** ✅ Done · **Priority:** P0 · **Size:** L · **Depends on:** 2C.1

**Description.** Make the suite bootable in both modes: resolve the test instance env, configure Playwright (`webServer` array for web + worker when `E2E_MANAGED_SERVER=1`, global setup/teardown that brings up compose/migrations/gitserver/stub in real mode), write the `test.extend` fixtures (`resetDb`, `seedSettings`, `api`, `health`, `gitServer`, `mode`) and the fake-provider script file.

**Acceptance criteria**
- [x] `apps/web/e2e/support/env.ts` exports `resolveE2eEnv(processEnv)` → `{ mode, instance, portBase, webPort, baseURL, databaseUrl, redisUrl, gitServerPort, gitServerHost, githubStubPort, repoUrl, allowedRepoHosts, fakeScriptPath, masterKeyPath, workspaceImage }` using core `resolveInstance`; unit-tested
- [x] `apps/web/playwright.config.ts`: `testDir: 'e2e'`, chromium only, `baseURL`, `timeout 120_000` (real) / `30_000` (mock), `expect.timeout 10_000`, retries 1 in CI, trace `on-first-retry`, video `retain-on-failure`, `globalSetup`/`globalTeardown`, `webServer` when `E2E_MANAGED_SERVER=1` — with two departures the implementation forced: mock serves a production build (`next start`), because the mock API cannot boot under the dev server; and the worker is not a `webServer` entry, because it owns no port and an entry pointed at the web server's health route is treated as already running and never starts. The worker starts with the rest of the stack and the global setup waits for its heartbeat
- [x] `apps/web/e2e/fixtures.ts` exports `test`, `expect` (`test.extend`) with: `mode`, `env`, `api` (typed request helper with Zod parse of `apiError` on failure), `resetDb` (auto, per test: API-side job cleanup → `truncateAll` → reap `ah-ws-test-*` containers in real mode; no-op in mock), `seedSettings` (PUT canaries via the API; no-op in mock), `health` (poll helper over `/api/health`), `gitServer` (handle from global setup via env)
- [x] `apps/web/e2e/fake-provider/script.json` with the scripted steps for the five prompts + `default`, validated by a unit test against the `FakeAgentModelProvider` script type
- [x] `pnpm --filter web test:e2e` → `playwright test`; `E2E_MODE=mock E2E_MANAGED_SERVER=1 pnpm --filter web test:e2e --list` lists the spec files (none yet — harness boots and tears down with an empty/placeholder spec `smoke.spec.ts` that loads `/chats/new`)
- [x] Harness pure modules 100 % covered by Vitest; the end-to-end sources type-check — through
  `apps/web/tsconfig.json`, whose `include` already covers `e2e/**`, so no `e2e/tsconfig.json` was
  added: a second project over the same files would compile them twice and check nothing more

**Files to create** (`tsconfig.json` was not needed — see the criterion above)
`apps/web/e2e/{fixtures.ts,global-setup.ts,global-teardown.ts}`, `apps/web/e2e/support/{env,env.test,api,api.test,db,docker,constants,mode}.ts`, `apps/web/e2e/fake-provider/{script.json,script.test.ts}`, `apps/web/e2e/smoke.spec.ts`, `apps/web/playwright.config.ts` (rewrite `webServer` section), `apps/web/package.json` (`test:e2e`), `apps/web/vitest.config.ts` (coverage include for pure helpers).

**Agent prompt**

````
You are a senior test-infrastructure engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · Next.js 16.3 (`next dev`) · worker via `tsx watch` · Playwright 1.62 (`test.extend`, `webServer[]`, `globalSetup`) · Postgres 18 + Prisma 7.9 · Redis 8 · Docker.
Branch feat/w2c-e2e (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-C — Task 2C.2 of 6 (MIDDLE)

PRECONDITIONS
- Task 2C.1 done (gitserver image + launcher, GitHub stub).
- `packages/core` exports `resolveInstance`, `loadConfig`, testing `connectTestDb`/`truncateAll`, canaries, `FakeAgentModelProvider` script types (read their current signatures).

REQUIRED READING (only these):
- docs/spec/06-testing.md § "4. Playwright E2E" (stack paragraph + "Each spec resets the DB"), § "7. Test doubles"
- docs/spec/05-local-dev.md § "3. Environment model", § "5. docker-compose services"
- docs/spec/03-interfaces.md § "4. HTTP API" (`/api/health`, `/api/settings/:key`, `/api/jobs`, `/api/chats/:id`)
- packages/core/src/config/instance.ts, packages/core/src/testing/{fake-agent-model-provider,canaries}.ts, packages/core/src/persistence/testing/db.ts, packages/core/src/api/contracts.ts (`apiError`, `healthResponse`, `settingsStatus`)
- apps/web/playwright.config.ts (W0 skeleton), apps/web/package.json scripts, infra/docker-compose.yml, infra/scripts/env.sh (`--print` output keys)
- apps/web/src/mocks/** (entry point/env flag for MSW in mock mode — `NEXT_PUBLIC_API_MOCK=1`)
- Playwright docs: `webServer` as an array, `globalSetup`, `test.extend` with `auto` fixtures, `test.skip(condition, description)` inside a test body

TASK
Build the harness so the suite boots in `mock` mode now and in `real` mode for W3-A, with per-test isolation and typed helpers.

DELIVERABLES

1. `apps/web/e2e/support/constants.ts` — named timeouts: `TURN_TIMEOUT_MS = 90_000`, `CANCEL_TIMEOUT_MS = 5_000`, `HEALTH_POLL_MS = 500`, `WORKSPACE_GONE_TIMEOUT_MS = 60_000`, `JOB_RUN_TIMEOUT_MS = 90_000`, `PORT_OFFSETS = { web: 0, postgres: 1, redis: 2, gitserver: 7, githubStub: 8 }`, `DEFAULT_PORT_BASE = 3900`, `TEST_INSTANCE = 'test'`, `SAMPLE_REPO = 'e2e/sample'`, `PROMPTS = { createNotes: 'list files and create NOTES.md', printDate: 'print date', showNotes: 'show NOTES.md', sleepLong: 'sleep for sixty seconds', writeToken: 'write the token to a file' }`.
2. `apps/web/e2e/support/mode.ts` — `type E2eMode = 'mock' | 'real'`; `export function readMode(env): E2eMode` (`E2E_MODE`, default `real`; anything else throws); `export function skipUnlessReal(test, mode, reason)` wrapper → `test.skip(mode === 'mock', \`needs real stack: ${reason}\`)`.
3. `apps/web/e2e/support/env.ts` — `resolveE2eEnv(processEnv = process.env)`: `mode = readMode`; `instance = TEST_INSTANCE` (override `E2E_INSTANCE`), `portBase = Number(E2E_PORT_BASE ?? DEFAULT_PORT_BASE)`; run core `resolveInstance({ env: { AH_INSTANCE: instance, AH_PORT_BASE: String(portBase) } })` for web/postgres/redis ports, db name, compose project, prefix; `databaseUrl = postgresql://ah:ah@127.0.0.1:${postgresPort}/${postgresDb}`, `redisUrl = redis://127.0.0.1:${redisPort}`; `gitServerHost = E2E_GITSERVER_HOST ?? 'host.docker.internal'`; `gitServerPort = portBase + 7`; `githubStubPort = portBase + 8`; `repoUrl = http://${gitServerHost}:${gitServerPort}/sample.git`; `allowedRepoHosts = ['github.com', gitServerHost]`; `fakeScriptPath = <abs path of e2e/fake-provider/script.json>`; `masterKeyPath = <abs e2e/.tmp/master.key>`; `workspaceImage = WORKSPACE_IMAGE ?? 'agent-hangar/workspace:dev'`; `baseURL = http://127.0.0.1:${webPort}`. Also `export function serverEnv(e: E2eEnv): Record<string,string>` — the env block for the web/worker processes: `AH_INSTANCE, AH_PORT_BASE, WEB_PORT, POSTGRES_PORT, REDIS_PORT, POSTGRES_DB, DATABASE_URL, REDIS_URL, COMPOSE_PROJECT_NAME, WORKSPACE_NAME_PREFIX, WORKSPACE_IMAGE, MASTER_KEY_PATH, AGENT_MODEL_PROVIDER: 'fake', FAKE_PROVIDER_SCRIPT_PATH, ALLOWED_REPO_HOSTS, GITHUB_API_BASE_URL: http://127.0.0.1:${githubStubPort}, LOG_LEVEL: 'info', NEXT_PUBLIC_API_MOCK: mode === 'mock' ? '1' : '0', WORKSPACE_IDLE_TTL_MIN: '30'`. `env.test.ts` covers defaults, overrides, both modes, invalid mode throws.
4. `apps/web/playwright.config.ts` (rewrite; keep W0's chromium/baseURL/trace conventions):
   ```ts
   const e2e = resolveE2eEnv();
   export default defineConfig({
     testDir: 'e2e', testMatch: /.*\.spec\.ts/, fullyParallel: false, workers: 1,   // one stack, one worker
     timeout: e2e.mode === 'real' ? 120_000 : 30_000, expect: { timeout: 10_000 },
     retries: process.env.CI ? 1 : 0, reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
     use: { baseURL: e2e.baseURL, trace: 'on-first-retry', video: 'retain-on-failure', screenshot: 'only-on-failure' },
     projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
     globalSetup: './e2e/global-setup.ts', globalTeardown: './e2e/global-teardown.ts',
     webServer: process.env.E2E_MANAGED_SERVER === '1' ? managedServers(e2e) : undefined,
   });
   ```
   `managedServers(e2e)`: mock → `[{ command: 'pnpm exec next dev --port <webPort>', cwd: apps/web, url: baseURL + '/chats/new', env: serverEnv(e2e), reuseExistingServer: !CI, timeout: 120_000, stdout: 'pipe', stderr: 'pipe' }]`; real → `[{ web as above but url: baseURL + '/api/health' }, { command: 'pnpm --filter worker dev', cwd: repo root, url: baseURL + '/api/health?require=worker', env: serverEnv(e2e), timeout: 180_000, reuseExistingServer: !CI }]` (the worker's readiness is observed through the web's health endpoint — `?require=worker` returns 503 until the worker heartbeat exists; this is W2-A's contract — contractChangeRequest if missing when you rebase). Playwright starts `webServer` entries in order and awaits each URL.
   IMPORTANT ordering fact: Playwright launches `webServer` BEFORE `globalSetup`; therefore everything the web/worker need at boot (compose up, migrations, master key) must be done BEFORE Playwright starts. Solve it with a tiny pre-step script: `apps/web/e2e/support/prepare-stack.ts` (run by the `test:e2e` script: `tsx e2e/support/prepare-stack.ts && playwright test`) that in real mode: writes the master key file (`crypto.randomBytes(32).toString('hex')`, mode 0600, mkdir -p `e2e/.tmp`), `docker compose -f infra/docker-compose.yml -p agent-hangar-test up -d --wait` with `POSTGRES_PORT/REDIS_PORT/POSTGRES_DB` env, runs `pnpm --filter @agent-hangar/core db:migrate` with `DATABASE_URL`, asserts the workspace image exists (`docker image inspect`, else prints `pnpm infra:image` and exits 1), builds/starts the gitserver (2C.1 launcher) and prints its URL; in mock mode it is a no-op. `globalSetup` then only starts the GitHub stub (real mode) and writes `e2e/.tmp/state.json` `{ githubStubPort, gitServer }`; `globalTeardown` stops the stub and (unless `E2E_KEEP_STACK=1`) the gitserver. `apps/web/e2e/.tmp/` is git-ignored (add `e2e/.tmp/` to `apps/web/.gitignore` if one exists — if only the root `.gitignore` exists, it already ignores `test-results/`; add a one-line `apps/web/e2e/.tmp/` entry to the ROOT .gitignore and list it in the PR as the only root edit). Scripts: `apps/web/package.json` `"test:e2e": "tsx e2e/support/prepare-stack.ts && playwright test"`, and verify the root `test:e2e` (W0) forwards to it.
5. `apps/web/e2e/support/api.ts` — `createApi(request: APIRequestContext, baseURL)` → `{ get<T>(path, schema?), post<T>(path, body, schema?), put, del, raw }`: parses JSON; on non-2xx parses `apiError` and throws `E2eApiError { status, code, message }`. `api.test.ts` with a fake `APIRequestContext`.
6. `apps/web/e2e/support/db.ts` — `resetDatabase(env)`: `connectTestDb()` (core testing) with `DATABASE_URL=env.databaseUrl` → `truncateAll(client)` → disconnect. `apps/web/e2e/support/docker.ts` — `reapWorkspaces(instance)`: `docker ps -q --filter label=ah.instance=<instance>` → `docker rm -f` each (ignore empty); `listWorkspaceContainers(instance)`.
7. `apps/web/e2e/fixtures.ts`:
   ```ts
   type Fixtures = { mode: E2eMode; env: E2eEnv; api: E2eApi; health: HealthHelper; seedSettings: () => Promise<void>; gitServer: { repoUrl: string }; resetDb: void };
   export const test = base.extend<Fixtures>({
     env: async ({}, use) => use(resolveE2eEnv()),
     mode: async ({ env }, use) => use(env.mode),
     api: async ({ request, env }, use) => use(createApi(request, env.baseURL)),
     health: async ({ api }, use) => use(createHealthHelper(api)),   // waitFor(predicate, timeoutMs) polling GET /api/health every HEALTH_POLL_MS
     gitServer: async ({ env }, use) => use({ repoUrl: env.repoUrl }),
     seedSettings: async ({ api, mode }, use) => use(async () => { if (mode === 'mock') return; await api.put('/api/settings/GITHUB_PAT', { value: GITHUB_CANARY }); await api.put('/api/settings/OPENAI_API_KEY', { value: OPENAI_CANARY }); }),
     resetDb: [async ({ api, env, mode }, use) => {
       if (mode === 'real') { await deleteAllJobsViaApi(api); await resetDatabase(env); await reapWorkspaces(env.instance); }
       await use();
     }, { auto: true }],
   });
   export { expect } from '@playwright/test';
   ```
   `deleteAllJobsViaApi` = `GET /api/jobs` then `DELETE /api/jobs/:id` each (removes BullMQ schedulers before the rows vanish; document why).
8. `apps/web/e2e/fake-provider/script.json` — keyed by the exact `PROMPTS` strings; each step `{ events: ModelEvent[] }` (shape from W0's `FakeAgentModelProvider`; `usage` numbers fixed `{ inputTokens: 10, outputTokens: 5 }`, `responseId` `fake-<n>`, `callId` `call-<n>`, unique per step):
   - `list files and create NOTES.md`: step 1 `tool_call list_dir {"path":"."}` + `response.done`; step 2 `tool_call write_file {"path":"NOTES.md","content":"# Notes\n\nFiles listed by the agent.\n"}` + `response.done`; step 3 `text.delta` ×2 ("Created " / "NOTES.md with the file list.") + `text.done` + `response.done`.
   - `print date`: step 1 `tool_call run_shell {"command":"date"}`; step 2 text "The current date was printed above."
   - `show NOTES.md`: step 1 `tool_call read_file {"path":"NOTES.md"}`; step 2 text "Here is NOTES.md."
   - `sleep for sixty seconds`: step 1 `tool_call run_shell {"command":"sleep 60"}`; step 2 text "Done sleeping." (never reached when cancelled).
   - `write the token to a file`: step 1 `tool_call write_file {"path":"token.txt","content":"<GITHUB_CANARY literal>"}`; step 2 text "Wrote the token." — this step's args contain the canary on purpose: the spec asserts the persisted/rendered args show `[REDACTED]` (worker exact-value redaction after `reveal`).
   - `default`: text "Acknowledged." + `response.done`.
   `script.test.ts`: parses the JSON, asserts every key in `PROMPTS` exists, each step's events satisfy the `ModelEvent` union (write a small Zod schema locally mirroring core's `ModelEvent` — or import one if core exports it), callIds unique, and the canary appears ONLY under `write the token to a file`.
9. `apps/web/e2e/smoke.spec.ts` — one test: open `/chats/new`, expect the page `h1`/headline visible (spec 10 §4.1 "What should we build?") — runs in both modes; it is the harness boot check.
10. `apps/web/e2e/tsconfig.json` — extends `../tsconfig.json`, `include: ['./**/*.ts']`, `types: ['node']`; make sure `pnpm typecheck` covers it (add to `apps/web/tsconfig.json` `references` or `include` if the web tsconfig excludes `e2e/` — that file is not yours: if an edit is needed, prefer making `e2e/tsconfig.json` a standalone project referenced from the root solution `tsconfig.json` `references` — root solution file edit is allowed ONLY for adding this reference; list it in the PR). `apps/web/vitest.config.ts`: `coverage.include` += `'e2e/support/{env,mode,api,github-stub,constants}.ts'`, `'e2e/fake-provider/**'` (pure modules); add a comment that `gitserver.ts`, `docker.ts`, `db.ts`, `prepare-stack.ts`, `global-*.ts` spawn processes and are exercised by the E2E run.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it()/test() comments).
- Harness never reads `.env.local`: every value comes from `resolveE2eEnv` (the `test` instance is fully derived so it cannot collide with a developer's default stack).
- `execFile` with arrays; no shell strings.

Verification:
- `pnpm --filter web test -- --coverage` — harness pure modules 100 %
- `E2E_MODE=mock E2E_MANAGED_SERVER=1 pnpm --filter web test:e2e` — boots `next dev` with MSW, `smoke.spec.ts` passes, server stops
- Real-mode boot check (requires Docker + workspace image built): `E2E_MODE=real E2E_MANAGED_SERVER=1 pnpm --filter web test:e2e e2e/smoke.spec.ts` — `prepare-stack` brings up `agent-hangar-test`, migrations apply, gitserver healthy, web reaches `/api/health`; the worker readiness may FAIL if W2-A/W2-B are not merged yet — that is expected; record the exact failure line in the task log and do not work around it
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-2c-e2e.md; append `- 2C.2 ✅ <date> — <summary>`; commit `test(e2e): add Playwright harness, fixtures and fake-provider script`.
````

---

## Task 2C.3 — Page objects + selector contract validated against the MSW UI

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 2C.2

**Description.** Write page objects for the sidebar, composer, chat header/transcript, scheduled page/dialog/run drawer, and settings page. Verify every selector against the running MSW-mocked UI, preferring accessible roles/names; produce the exact list of `data-testid`s the specs need, and record a contractChangeRequest for any that W1-G/W1-H do not expose.

**Acceptance criteria**
- [x] `apps/web/e2e/pages/{sidebar,composer,chat,scheduled,settings}.ts` export classes with `readonly` locators and action methods, each locator resolving in mock mode (proved by `pages.smoke.spec.ts` that visits each page and asserts visibility/enabled state of every locator that exists in the default MSW state)
- [x] `apps/web/e2e/support/selectors.ts` exports the `TEST_IDS` constant table (below) and is the only place test ids are spelled; page objects use `getByRole`/`getByLabel` when the UI exposes a stable name, `getByTestId(TEST_IDS.x)` otherwise
- [x] `apps/web/e2e/SELECTORS.md` is NOT created — instead the PR description lists (a) ids found in the UI, (b) ids missing with the component file where W1-G/W1-H should add them (contractChangeRequest), (c) role/name selectors used instead
- [x] `pnpm --filter web test:e2e e2e/pages.smoke.spec.ts` green in mock mode

**Files to create**
`apps/web/e2e/pages/{sidebar,composer,chat,scheduled,settings,index}.ts`, `apps/web/e2e/support/selectors.ts`, `apps/web/e2e/pages.smoke.spec.ts`.

**Agent prompt**

````
You are a senior test engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: Next.js 16.3 App Router + React 19.2 · Tailwind v4 + shadcn (Base UI) · MSW 2 mocks (`NEXT_PUBLIC_API_MOCK=1`) · Playwright 1.62 (`getByRole`, `getByLabel`, `getByTestId`).
Branch feat/w2c-e2e (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-C — Task 2C.3 of 6 (MIDDLE)

PRECONDITIONS
- Task 2C.2 done (harness boots in mock mode).
- `E2E_MODE=mock E2E_MANAGED_SERVER=1` works; or run `NEXT_PUBLIC_API_MOCK=1 pnpm --filter web dev --port 3900` yourself and point Playwright at it.

REQUIRED READING (only these):
- docs/spec/10-ui-design.md § "3. App shell", § "4. Screens" (4.1–4.4), § "8. Accessibility" (roles, aria-labels, `aria-live`, `role="log"`)
- docs/spec/06-testing.md § "4. Playwright E2E" (what each spec must click/see)
- apps/web/src/features/shell/**, apps/web/src/features/chats/**, apps/web/src/shared/transcript/**, apps/web/src/features/scheduled/**, apps/web/src/features/settings/**, apps/web/app/(app)/** — READ ONLY (grep for `data-testid`, `aria-label`, `role=`)
- apps/web/src/mocks/** (default mocked state: which chats/jobs/settings exist, how the scripted SSE stream behaves)

TASK
Create page objects that the six specs will use, validate every selector against the mocked UI, and produce the selector contract (found / missing / role-based) for the PR and for W1-G/W1-H.

DELIVERABLES

1. `apps/web/e2e/support/selectors.ts` — `export const TEST_IDS = { … } as const` with exactly these keys (values are the ids to look for; keep the names even when you end up using a role selector — the table is the contract):
   Shell: `sidebar`, `sidebarNewChat`, `sidebarNavScheduled`, `sidebarNavSettings`, `sidebarSearch`, `chatList`, `chatListItem` (`data-chat-id` attribute), `archivedGroupToggle`, `archivedList`, `envPill`, `themeToggle`.
   Composer: `composer`, `repoPicker`, `repoPickerOption`, `branchPicker`, `branchPickerOption`, `composerTextarea`, `composerSend`, `secretsMissingNotice`, `secretsMissingLink`.
   Chat header/transcript: `chatTitle`, `repoChip`, `statusPill` (`data-status` ∈ queued|preparing|running|done|failed|cancelled), `stopTurn`, `chatMenu`, `chatMenuArchive`, `chatMenuRestore`, `chatMenuDelete`, `transcript`, `messageUser`, `messageAssistant`, `systemNotice`, `toolCallRow` (`data-tool-name`, `data-status`), `toolCallOutput`, `streamCursor`, `errorCard`, `archivedBanner`, `archivedBannerRestore`, `reconnectingBar`.
   Scheduled: `jobsTable`, `jobRow` (`data-job-id`), `newJob`, `jobDialog`, `jobName`, `jobCron`, `jobCronPreview`, `jobCronError`, `jobTimezone`, `jobPrompt`, `jobEnabled`, `jobSave`, `jobRowMenu`, `jobRunNow`, `jobEdit`, `jobDelete`, `jobDeleteConfirm`, `runsTable`, `runRow` (`data-run-id`, `data-status`), `runDrawer`, `runOutput`, `runDrawerTranscript`.
   Settings: `secretFieldGITHUB_PAT`, `secretInputGITHUB_PAT`, `secretSaveGITHUB_PAT`, `secretMaskGITHUB_PAT`, `secretReplaceGITHUB_PAT`, `secretRemoveGITHUB_PAT`, same five for `OPENAI_API_KEY`, `secretRemoveConfirm`, `settingsModel`, `envSummary`.
   Map each key to the kebab-case id string (`sidebar-new-chat`, `secret-input-GITHUB_PAT`, …).
2. Page objects (`apps/web/e2e/pages/*.ts`; constructor `(page: Page)`; locators as `readonly` fields; methods return `Promise<void>` and end with an `expect` that proves the action took effect):
   - `SidebarPage`: `goto()` (`/chats/new`), `newChat()`, `openScheduled()`, `openSettings()`, `chatItem(title)` (locator), `openArchived()`, `archivedItem(title)`, `envPillText()`.
   - `ComposerPage`: `chooseRepo(fullName)` (open picker → type → click option → expect picker shows the name), `chooseBranch(name)`, `type(prompt)`, `send()` (click + expect navigation to `/chats/` or, on the chat page, expect a new `messageUser`), `expectBlockedBySecrets()` (notice visible, link to `/settings`), `expectSendDisabled()`.
   - `ChatPage`: `goto(chatId)`, `title`, `statusPill`, `waitForStatus(status, timeoutMs)`, `stop()`, `archive()` (menu → Archive → confirm if an AlertDialog appears → expect `archivedBanner`), `restore()` (banner or menu → expect `systemNotice` containing "restored"), `deleteChat()`, `userMessages`, `assistantMessages`, `toolRows(name?)`, `expandToolRow(i)`, `systemNotices`, `waitForText(text, timeoutMs)` (in transcript), `expectPreparingNotice()` ("Cloning" / "Preparing workspace" — read the real copy from W1-G's `SystemNotice`/prepare rendering and assert on that), `errorCard`.
   - `ScheduledPage`: `goto()`, `newJob({ name, cron, timezone?, repo, branch, prompt, enabled? })` (fill dialog; `chooseRepo` reuses the composer's picker component — import the ComposerPage helpers or duplicate the 3 lines, no cross-import of app code), `row(name)`, `runNow(name)`, `toggleEnabled(name)`, `deleteJob(name)`, `openJob(name)` (→ `/scheduled/:id`), `runRows`, `waitForRunStatus(status, timeoutMs)`, `openRun(i)` (→ drawer), `runDrawerToolRows`, `runOutputText()`, `cronPreviewText()`, `cronErrorText()`.
   - `SettingsPage`: `goto()`, `save(key, value)` (input → Save → expect toast or mask), `maskText(key)`, `replace(key, value)`, `remove(key)` (→ AlertDialog confirm → expect input visible again), `expectNotSet(key)`, `modelText()`.
   Prefer `page.getByRole('button', { name: /archive/i })`, `getByLabel('GitHub Personal Access Token')`, `getByRole('textbox', { name: … })`, `getByRole('table')`, `getByRole('row', { name })`, `getByRole('log')`, `getByRole('status')` when the UI exposes those names (spec 10 §8 says icon-only buttons carry `aria-label` and inputs have visible labels). Fall back to `getByTestId(TEST_IDS.x)`.
3. Validate against the mocked UI: run the app in mock mode, and for each page object locator check it resolves (Playwright Inspector or `await locator.count()` in a scratch script). Build the three lists: FOUND (id present), MISSING (id not present AND no stable role/name — list component file path where it should live, e.g. `apps/web/src/features/chats/Composer.tsx`), ROLE-BASED (no id needed). For MISSING ids, still reference `TEST_IDS.x` in the page object and add a one-line comment `// pending: W1-G to add data-testid (see PR contractChangeRequests)`.
4. `apps/web/e2e/pages.smoke.spec.ts` — one test per page in MOCK mode only (`test.skip(mode === 'real', 'selector validation runs against MSW')`): Sidebar (nav items, chat list with the MSW-seeded chats, archived group toggles), New chat (suggestion cards, composer present, repo picker opens and lists MSW repos, branch picker, textarea, send disabled until repo+prompt), Chat page for an MSW-seeded chat (title, status pill, transcript with user/assistant/tool rows from the mocked stream, tool row expands), Scheduled (table rows from MSW, New job dialog opens, cron preview reacts to `* * * * *`, invalid cron shows error, run drawer opens from a run row), Settings (both fields, save shows mask, Replace/Remove visible for a set key, model text, env summary). Every locator the six specs will use must be touched here at least once; MISSING ids are asserted with `test.fixme`-free `expect.soft` + an attached annotation `{ type: 'missing-testid', description: TEST_IDS.x }` so the report shows exactly what W1-G/W1-H must add — do not let a missing id fail the smoke in a way that hides the others.
5. Record the FOUND/MISSING/ROLE-BASED lists in the task completion log entry (one line each, comma-separated ids) — Task 2C.6 copies them into the PR description and `contractChangeRequests`.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, test() comments).
- Never `page.waitForTimeout`; never CSS class selectors (Tailwind classes are not a contract); never XPath.
- Page objects contain no assertions about the backend — only UI state.

Verification:
- `E2E_MODE=mock E2E_MANAGED_SERVER=1 pnpm --filter web test:e2e e2e/pages.smoke.spec.ts` — green (soft failures only for MISSING ids, each with its annotation)
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-2c-e2e.md; append `- 2C.3 ✅ <date> — <summary> · FOUND: … · MISSING: … · ROLE-BASED: …`; commit `test(e2e): add page objects and selector contract`.
````

---

## Task 2C.4 — Chat specs: `chat-create-run`, `chat-archive-restore`, `cancel-turn`

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 2C.3

**Description.** Author the three chat-centric specs of spec 06 §4 with step-by-step assertions, including API-side checks (`/api/chats/:id` turn status, `/api/health` live-workspace counters), written to run fully in `real` mode and up to the first real-stack assertion in `mock` mode.

**Acceptance criteria**
- [x] `apps/web/e2e/chat-create-run.spec.ts`: seed settings → New chat → choose `e2e/sample` + `main` → send `PROMPTS.createNotes` → transcript shows the preparing/cloning notice, tool rows `list_dir` then `write_file`, final assistant text "Created NOTES.md…"; status pill Preparing → Running → Done; `GET /api/chats/:id` turn `SUCCEEDED` with two tool calls; `/api/health` `liveWorkspaces.chat === 1`
- [x] `apps/web/e2e/chat-archive-restore.spec.ts`: continue from a created+run chat → Archive → chat appears under Archived, banner visible → `/api/health` `liveWorkspaces.chat === 0` within `WORKSPACE_GONE_TIMEOUT_MS` → Restore → system notice visible, history intact (user message, assistant message, tool rows still there) → send `PROMPTS.showNotes` → preparing/cloning notice again → `read_file` tool row → assistant "Here is NOTES.md." → turn SUCCEEDED
- [x] `apps/web/e2e/cancel-turn.spec.ts`: seed → chat with `PROMPTS.sleepLong` → wait for the `run_shell` row running → click Stop (confirm) → status Cancelled and `GET /api/chats/:id` turn `CANCELLED` within `CANCEL_TIMEOUT_MS`; `/api/health` `liveWorkspaces.chat === 1` (workspace still READY); composer unlocked
- [x] In mock mode all three run through the UI steps up to the first real-stack assertion and then skip with a reason; no `waitForTimeout`; each spec has a top comment mapping steps → spec 06 §4 row

**Files to create**
`apps/web/e2e/{chat-create-run,chat-archive-restore,cancel-turn}.spec.ts`, `apps/web/e2e/support/chat-flows.ts` (shared `createChatAndRun(page, api, prompt)` helper returning `{ chatId, turnId }`).

**Agent prompt**

````
You are a senior test engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: Playwright 1.62 · Next.js 16.3 UI (W1-G) · API (W2-A) · worker + Docker workspaces (W2-B) · fake model provider scripted by apps/web/e2e/fake-provider/script.json · local gitserver.
Branch feat/w2c-e2e (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-C — Task 2C.4 of 6 (MIDDLE)

PRECONDITIONS
- Tasks 2C.2–2C.3 done (fixtures, page objects, selector contract).
- Real mode may not be runnable yet (W2-A/W2-B in progress) — author for real, validate in mock.

REQUIRED READING (only these):
- docs/spec/06-testing.md § "4. Playwright E2E" rows `chat-create-run`, `chat-archive-restore`, `cancel-turn`
- docs/spec/04-flows.md (a) whole diagram + "Edge cases" (Cancel), (b) ARCHIVE/RESTORE
- docs/spec/10-ui-design.md § "4.2 Chat" (status pill states, Stop button, archived banner, system notices, tool rows)
- docs/spec/03-interfaces.md § "4. HTTP API" (`GET /api/chats/:id`, `GET /api/health`)
- apps/web/e2e/{fixtures.ts,pages/*.ts,support/{constants,mode,selectors}.ts}, apps/web/e2e/fake-provider/script.json
- packages/core/src/api/contracts.ts (`chatDetail` — turn `status`, tool call fields; `healthResponse.liveWorkspaces`)

TASK
Write the three chat specs with explicit, step-by-step assertions, real-stack guards, and shared helpers.

DELIVERABLES

1. `apps/web/e2e/support/chat-flows.ts`:
   - `export async function createChatAndRun(ctx: { page; api; env; mode; seedSettings }, prompt: string): Promise<{ chatId: string; turnId: string }>` — `seedSettings()`; `SidebarPage.goto()`; `ComposerPage.chooseRepo(SAMPLE_REPO)`; `chooseBranch('main')`; `type(prompt)`; `send()`; wait for URL `/chats/<id>` (extract id); in real mode `api.get(\`/api/chats/${id}\`, chatDetail)` → `turnId = turns.at(-1).id`; in mock mode `turnId = 'mock'`. Returns ids.
   - `export async function waitForTurnStatus(api, chatId, turnId, status, timeoutMs)` — `expect.poll(() => api.get(chatDetail).turns.find(id).status, { timeout }).toBe(status)`.
   - `export async function expectLiveChatWorkspaces(health, n, timeoutMs)` — `health.waitFor(h => h.liveWorkspaces.chat === n, timeoutMs)`.
2. `apps/web/e2e/chat-create-run.spec.ts` (header comment: maps to spec 06 §4 row 1):
   ```
   test('new chat runs the scripted task and streams the transcript', async ({ page, api, env, mode, seedSettings, health }) => {
     // Step 1–4: open app, choose repo/branch, send prompt (UI only — runs in both modes)
     const { chatId, turnId } = await createChatAndRun(…, PROMPTS.createNotes);
     const chat = new ChatPage(page);
     await expect(chat.userMessages.last()).toContainText(PROMPTS.createNotes);
     // mock mode validates the MSW scripted stream renders tool rows and a final message, then stops
     if (mode === 'mock') { await expect(chat.toolRows().first()).toBeVisible(); test.skip(true, 'needs real stack: worker, Docker, gitserver'); }
     // Step 5: status pill transitions (each waited in order; Preparing may be brief — accept Preparing OR Running for the first wait)
     await chat.waitForStatus(/preparing|running/, TURN_TIMEOUT_MS);
     await chat.expectPreparingNotice();                 // "Cloning…" / prepare.done rendering
     await expect(chat.toolRows('list_dir')).toHaveCount(1, { timeout: TURN_TIMEOUT_MS });
     await expect(chat.toolRows('write_file')).toHaveCount(1, { timeout: TURN_TIMEOUT_MS });
     await chat.waitForText('NOTES.md with the file list', TURN_TIMEOUT_MS);
     await chat.waitForStatus('done', TURN_TIMEOUT_MS);
     // Step 6: DB state through the API
     await waitForTurnStatus(api, chatId, turnId, 'SUCCEEDED', 10_000);
     const detail = await api.get(`/api/chats/${chatId}`, chatDetail);
     expect(detail.turns.at(-1)?.toolCalls ?? detail.toolCalls).toHaveLength(2);      // adapt to the contract's shape
     await expectLiveChatWorkspaces(health, 1, 10_000);   // workspace kept READY for the next message
     await chat.expandToolRow(1); await expect(chat.toolRows('write_file').first()).toContainText('NOTES.md');
   });
   ```
   Also a second test in the same file: "send button is disabled until repo and prompt are set" (pure UI, both modes).
3. `apps/web/e2e/chat-archive-restore.spec.ts` (row 2): one long test: `createChatAndRun(PROMPTS.createNotes)`; in real mode wait SUCCEEDED; `chat.archive()` → `expect(page).toHaveURL(/\/chats\//)` still, `archivedBanner` visible, composer hidden/disabled; `SidebarPage.openArchived()` → `archivedItem(title)` visible and `chatItem(title)` absent from the active list; mock → `test.skip` here; real → `expectLiveChatWorkspaces(health, 0, WORKSPACE_GONE_TIMEOUT_MS)`; `chat.restore()` → `systemNotice` containing /restored/i visible; history intact: user message, assistant message, both tool rows still present (count the rows before archive and compare); `ComposerPage.type(PROMPTS.showNotes); send()`; `chat.expectPreparingNotice()` (a NEW preparing notice — count notices before/after) ; `toolRows('read_file')` count 1; `waitForText('Here is NOTES.md')`; `waitForStatus('done')`; API: last turn `SUCCEEDED`, `liveWorkspaces.chat === 1`; the chat is back in the active list (`chatItem(title)` visible).
4. `apps/web/e2e/cancel-turn.spec.ts` (row 6): `createChatAndRun(PROMPTS.sleepLong)`; mock → after the first tool row is visible, click Stop, expect the MSW mock to show Cancelled if it supports it (read the mock; if not, just assert the Stop button exists) then `test.skip`; real → `expect(chat.toolRows('run_shell').first()).toHaveAttribute('data-status', /running/i, { timeout: TURN_TIMEOUT_MS })` (or the role/name equivalent your page object chose); `const t0 = Date.now(); await chat.stop();` (handles the confirm dialog from spec 10 §3 "Esc cancel turn (with confirm)"); `await chat.waitForStatus('cancelled', CANCEL_TIMEOUT_MS)`; `await waitForTurnStatus(api, chatId, turnId, 'CANCELLED', CANCEL_TIMEOUT_MS)`; `expect(Date.now() - t0).toBeLessThan(CANCEL_TIMEOUT_MS + 1000)`; `expectLiveChatWorkspaces(health, 1, 5_000)` (workspace still READY — flow (a) cancel keeps it); composer enabled again (`expectSendDisabled` false after typing); the `run_shell` row shows a non-running final state.
5. Every spec: file header comment, `test.describe.configure({ mode: 'serial' })` where tests depend on each other (avoid where possible — prefer one test per flow), explicit timeouts from `constants.ts`, no `waitForTimeout`, every `test()` preceded by a block comment naming the spec 06 row and the assertions.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, test() comments).
- Only page objects + `api`/`health` fixtures touch the app; no direct DB reads in specs (the DB is asserted through `GET /api/chats/:id`).
- Copy you assert on (notices, final messages) comes from `script.json` and from W1-G's actual component strings — read them; do not guess.

Verification:
- `E2E_MODE=mock E2E_MANAGED_SERVER=1 pnpm --filter web test:e2e e2e/chat-create-run.spec.ts e2e/chat-archive-restore.spec.ts e2e/cancel-turn.spec.ts` — each test reaches its real-stack guard and reports "skipped: needs real stack …" (or passes for pure-UI tests); zero failures
- `pnpm typecheck && pnpm lint` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-2c-e2e.md; append `- 2C.4 ✅ <date> — <summary>`; commit `test(e2e): add chat create, archive/restore and cancel specs`.
````

---

## Task 2C.5 — Scheduled + settings specs, CI `e2e` job body, mock-mode validation run

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 2C.3

**Description.** Author `scheduled-job-run`, `settings-save-mask`, `settings-missing`; write the CI `e2e` job body (mock mode now, one-line switch to real for W3-A); run the entire suite in mock mode and produce the matrix of which assertions need the real stack.

**Acceptance criteria**
- [x] `apps/web/e2e/scheduled-job-run.spec.ts`: New job (`* * * * *`, `PROMPTS.printDate`, `e2e/sample`/`main`) → row appears with cron + next run → Run now → run row `Succeeded` within `JOB_RUN_TIMEOUT_MS`, output visible in the drawer, `run_shell` tool row present → `/api/health` `liveWorkspaces.job === 0` → cleanup via Delete
- [x] `apps/web/e2e/settings-save-mask.spec.ts`: paste canaries → Save → masks `••••••••<last4>` → reload keeps masks → `GET /api/settings` body passes `assertNoCanary` and has `last4` → Replace works → Remove works (AlertDialog) → (real) a chat with `PROMPTS.writeToken` shows `[REDACTED]` in the `write_file` tool row args and `GET /api/chats/:id` tool-call args pass `assertNoCanary`
- [x] `apps/web/e2e/settings-missing.spec.ts`: no secrets → `/chats/new` shows the secrets-missing notice with a link to `/settings`, Send absent/disabled; (real) `POST /api/chats` → 409 `SECRETS_MISSING`; `/api/health` `liveWorkspaces.chat === 0`; after saving both keys the composer appears
- [x] `.github/workflows/ci.yml` `e2e` job body: services postgres/redis, pnpm setup, `playwright install --with-deps chromium`, env (`AH_INSTANCE=ci`, `E2E_MODE=mock`, `E2E_MANAGED_SERVER=1`, `E2E_GITSERVER_HOST=172.17.0.1`, `AGENT_MODEL_PROVIDER=fake`), `pnpm test:e2e`, upload `apps/web/playwright-report` + `test-results` on failure; a comment marks the `E2E_MODE` line as the W3-A switch
- [x] Full mock-mode run green; `docs/tasks/wave-2c-e2e.md` completion log lists the real-stack assertion matrix (spec → guarded assertions)

**Files to create/modify**
`apps/web/e2e/{scheduled-job-run,settings-save-mask,settings-missing}.spec.ts`, `.github/workflows/ci.yml` (`e2e` job body only).

**Agent prompt**

````
You are a senior test engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: Playwright 1.62 · Next.js 16.3 UI (W1-H scheduled + settings) · API (W2-A) · worker (W2-B) · GitHub Actions (ubuntu-latest, Docker available).
Branch feat/w2c-e2e (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-C — Task 2C.5 of 6 (MIDDLE)

PRECONDITIONS
- Tasks 2C.2–2C.3 done; 2C.4 done or in progress (independent files).

REQUIRED READING (only these):
- docs/spec/06-testing.md § "4. Playwright E2E" rows `scheduled-job-run`, `settings-save-mask`, `settings-missing`; § "6. CI pipeline" item 5
- docs/spec/04-flows.md (c) steps 1–6 + "Guarantees", (d) SAVE + "Controls" (UI, Tests rows)
- docs/spec/10-ui-design.md § "4.3 Scheduled", § "4.4 Settings", § "4.1" (secrets-missing notice copy)
- docs/spec/03-interfaces.md § "4. HTTP API" (`/api/settings`, `/api/jobs`, `/api/jobs/:id/runs`, `/api/runs/:id`, `/api/chats` 409)
- apps/web/e2e/{fixtures.ts,pages/*.ts,support/*.ts}, apps/web/e2e/fake-provider/script.json, apps/web/e2e/support/chat-flows.ts (if 2C.4 landed; else write the two lines you need locally)
- .github/workflows/ci.yml (W0's `e2e` placeholder job and the `integration` job for the services/env pattern)
- packages/core/src/testing/canaries.ts (`assertNoCanary`), packages/core/src/api/contracts.ts (`settingsStatus`, `jobSummary`, `runSummary`, `runDetail`, `chatDetail`)

TASK
Write the remaining three specs, the CI e2e job body, and run the whole suite in mock mode to produce the real-stack matrix.

DELIVERABLES

1. `apps/web/e2e/scheduled-job-run.spec.ts` (row 3): `seedSettings()`; `ScheduledPage.goto()`; empty state visible (real mode after reset; in mock the MSW seed has rows — branch on `mode` for the empty-state assertion); `newJob({ name: 'E2E print date', cron: '* * * * *', repo: SAMPLE_REPO, branch: 'main', prompt: PROMPTS.printDate })` → dialog closes, `row('E2E print date')` visible with the cron text and a next-run cell; `cronPreviewText()` was non-empty before save and an invalid cron (`'61 * * * *'`) showed `cronErrorText()` (do this inside the dialog before filling the valid one); mock → `test.skip` after `runNow` click is visible; real → `runNow('E2E print date')` → `openJob(name)` → `waitForRunStatus(/succeeded/i, JOB_RUN_TIMEOUT_MS)` (accept that the cron tick may also have produced a run — assert AT LEAST one Succeeded row and that none is Failed with "previous run still running" unless two runs overlapped, in which case one Failed overlap row is acceptable and asserted as such); `openRun(0)` → `runDrawerToolRows` has a `run_shell` row, `runOutputText()` contains "printed above"; API: `GET /api/jobs/:id/runs` first run `SUCCEEDED` with `output`; `GET /api/runs/:id` tool calls length 1; `health.waitFor(h => h.liveWorkspaces.job === 0, WORKSPACE_GONE_TIMEOUT_MS)`; cleanup inside the test: `toggleEnabled` off then `deleteJob` (confirm) → row gone (the auto `resetDb` fixture also deletes jobs through the API on the next test — document both).
2. `apps/web/e2e/settings-save-mask.spec.ts` (row 4): `SettingsPage.goto()`; `expectNotSet('GITHUB_PAT')` (real mode; mock may be seeded — branch); `save('GITHUB_PAT', GITHUB_CANARY)` → `maskText` matches `/^•+.{4}$/` and ends with the canary's last 4; `save('OPENAI_API_KEY', OPENAI_CANARY)` → mask; `page.reload()` → both masks persist, inputs are `type=password` and empty when shown; API: `const s = await api.get('/api/settings', settingsStatus)`; `assertNoCanary(JSON.stringify(s))`; `s.githubPat.last4 === GITHUB_CANARY.slice(-4)`; `replace('GITHUB_PAT', GITHUB_CANARY.slice(0,-4) + 'ZZZZ')` → mask ends `ZZZZ` (keep the `ghp_` shape so redaction still matches); `remove('OPENAI_API_KEY')` → `expectNotSet('OPENAI_API_KEY')` and API `openaiKey.set === false`; re-save OPENAI (needed below); mock → `test.skip` here; real → `createChatAndRun(PROMPTS.writeToken)` → wait SUCCEEDED → expand the `write_file` row → row text contains `[REDACTED]` and `assertNoCanary(rowText)` passes; `const d = await api.get(chatDetail)` → `assertNoCanary(JSON.stringify(d))`; also `assertNoCanary` on `page.content()`.
3. `apps/web/e2e/settings-missing.spec.ts` (row 5): NO `seedSettings`; mock mode: if the MSW default has secrets set, use the mock's documented way to simulate "missing" (read `apps/web/src/mocks/settings.ts`; if there is none, `test.skip(mode === 'mock', 'MSW default seeds secrets')` AFTER asserting the page loads) ; real: `SidebarPage.goto()` → `ComposerPage.expectBlockedBySecrets()` (notice text per spec 10 §4.1: "Add your GitHub token and OpenAI key in Settings to start."; link/button navigates to `/settings`); `await expect(api.post('/api/chats', { repoUrl: env.repoUrl, baseBranch: 'main', prompt: 'x' })).rejects.toMatchObject({ status: 409, code: 'SECRETS_MISSING' })`; `health.waitFor(h => h.liveWorkspaces.chat === 0, 2_000)`; then `seedSettings()` → `page.reload()` → composer visible and `secretsMissingNotice` gone.
4. `.github/workflows/ci.yml` — replace the BODY of the `e2e` job only (keep its name, `needs`, and the job list untouched):
   ```yaml
   e2e:
     runs-on: ubuntu-latest
     timeout-minutes: 30
     services:
       postgres: { image: postgres:18-alpine, env: { POSTGRES_USER: ah, POSTGRES_PASSWORD: ah, POSTGRES_DB: agent_hangar_test }, ports: ['3901:5432'], options: >- --health-cmd "pg_isready -U ah" --health-interval 2s --health-retries 30 }
       redis: { image: redis:8-alpine, ports: ['3902:6379'], options: >- --health-cmd "redis-cli ping" --health-interval 2s --health-retries 30 }
     env:
       CI: '1'
       AH_INSTANCE: ci               # informational for tooling; the harness passes AH_INSTANCE=$E2E_INSTANCE to web/worker
       E2E_INSTANCE: test            # harness instance name (DB/compose/prefix); ports from E2E_PORT_BASE
       E2E_PORT_BASE: '3900'
       E2E_MODE: mock                # W3-A flips this to `real` once W2-A/W2-B are merged and the suite is green locally
       E2E_MANAGED_SERVER: '1'
       E2E_GITSERVER_HOST: 172.17.0.1
       E2E_SKIP_COMPOSE: '1'         # services above replace `docker compose up` in prepare-stack (implement this flag in prepare-stack.ts: skip compose, still migrate/gitserver in real mode)
       AGENT_MODEL_PROVIDER: fake
       DOCKER_AVAILABLE: '1'
     steps:
       - uses: actions/checkout@v7
       - uses: pnpm/setup@v2 with { version: 11, runtime: node@24, cache: true }
       - run: pnpm install --frozen-lockfile
       - run: pnpm exec playwright install --with-deps chromium
         working-directory: apps/web
       - run: pnpm db:generate
       - run: docker build -t agent-hangar/workspace:dev infra/workspace      # needed in real mode; cheap to keep so the flip is one line
       - run: pnpm test:e2e
       - if: failure()
         uses: actions/upload-artifact@v4
         with: { name: playwright-report, path: | apps/web/playwright-report apps/web/test-results, retention-days: 7 }
   ```
   (Write proper multi-line YAML, not the inline form above.) Keep the W0 `integration` job's `pnpm/setup@v2` usage as the reference for exact syntax. No `continue-on-error`.
5. Implement the `E2E_SKIP_COMPOSE` flag in `prepare-stack.ts` (owned) and document it in its header.
6. Mock-mode validation run: `E2E_MODE=mock E2E_MANAGED_SERVER=1 pnpm --filter web test:e2e` over ALL spec files (smoke, pages.smoke, six specs). Zero failures. From the report, write the matrix into this task's completion-log line and into a header comment block at the top of `apps/web/e2e/fixtures.ts` ("Real-stack matrix"): for each spec, the list of assertions behind `test.skip(mode === 'mock', …)` — this is what W3-A will turn green.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, test() comments).
- The CI job must pass TODAY in mock mode and need only the `E2E_MODE` flip for W3-A — no other latent edits.
- Never print secrets in CI logs: the canaries are test constants, but still never `echo` them.

Verification:
- `E2E_MODE=mock E2E_MANAGED_SERVER=1 pnpm --filter web test:e2e` — all green (skips reported with reasons)
- `pnpm typecheck && pnpm lint` — exit 0
- `gh workflow view ci.yml` after push (in 2C.6) parses; locally `node -e "require('node:fs').readFileSync('.github/workflows/ci.yml','utf8')"` is not a YAML check — instead run `pnpm exec prettier --check .github/workflows/ci.yml`

Completion Protocol: update status/AC/progress in docs/tasks/wave-2c-e2e.md; append `- 2C.5 ✅ <date> — <summary> · real-stack matrix: chat-create-run[…]; chat-archive-restore[…]; cancel-turn[…]; scheduled-job-run[…]; settings-save-mask[…]; settings-missing[…]`; commit `test(e2e): add scheduled and settings specs and CI e2e job`.
````

---

## Task 2C.6 — Close-out: gates, code review, dashboard, PR

**Status:** ✅ Done · **Priority:** P0 · **Size:** S · **Depends on:** 2C.1–2C.5

**Description.** Run the lane gates (lint, format, typecheck, harness unit coverage, full mock-mode E2E run, real-mode boot attempt documented), `/bymax-quality:code-review` to zero findings, update the plan dashboard and tasks index, open the PR with the selector contract and the contract change requests, return the orchestrator payload.

**Acceptance criteria**
- [x] `pnpm lint && pnpm format:check && pnpm typecheck` exit 0; `pnpm --filter web test -- --coverage` 100 % on the harness pure modules; `E2E_MODE=mock E2E_MANAGED_SERVER=1 pnpm --filter web test:e2e` green; `docker build infra/test/gitserver` succeeds; real-mode boot attempted and its outcome recorded
- [x] `/bymax-quality:code-review` zero open findings
- [x] `docs/plan.md` §12 row W2-C → 🟨 with branch/PR; `docs/tasks/README.md` row updated
- [x] PR opened; payload `{ pr, branch, headSha, gates, coverage, contractChangeRequests }` returned with the selector requests (W1-G/W1-H), the fake-provider script loading (W1-C/W2-B), `ALLOWED_REPO_HOSTS`/`GITHUB_API_BASE_URL`/`/api/health?require=worker` (W2-A), runtime http clone acceptance (W1-D), and any other

**Files to modify**
`docs/plan.md` (§12 row only), `docs/tasks/README.md` (lane row only), `docs/tasks/wave-2c-e2e.md` (header, log).

**Agent prompt**

````
You are a senior engineer closing out lane W2-C of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 · Node 24 · Next.js 16.3 · Playwright 1.62 · Docker · GitHub Actions.
Branch feat/w2c-e2e (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W2-C — Task 2C.6 of 6 (LAST)

PRECONDITIONS
- Tasks 2C.1–2C.5 done and committed on this branch.

REQUIRED READING (only these):
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard", § "8. Wave 3" (W3-A — hand-off expectations)
- docs/tasks/README.md
- CLAUDE.md § Gates
- The completion-log lines of 2C.3 (selector lists) and 2C.5 (real-stack matrix) in this file

TASK
Run all gates and a full code review, fix everything, update the dashboards, open the PR with the hand-off information W3-A needs, and return the structured payload.

DELIVERABLES

1. Gates, all green: `pnpm lint`; `pnpm format:check`; `pnpm typecheck` (incl. `apps/web/e2e`); `pnpm --filter web test -- --coverage` (100 % on the harness pure modules listed in `coverage.include`); `docker build -t agent-hangar/gitserver:test infra/test/gitserver`; `E2E_MODE=mock E2E_MANAGED_SERVER=1 pnpm --filter web test:e2e` (all spec files, zero failures); real-mode boot attempt: `E2E_MODE=real E2E_MANAGED_SERVER=1 pnpm --filter web test:e2e e2e/smoke.spec.ts` — if W2-A/W2-B are merged on your rebased main, it should pass; if not, capture the exact readiness failure (e.g. `/api/health?require=worker` never 200) and put it in the PR under "Real-mode status" — do NOT paper over it.
2. Run `/bymax-quality:code-review` (full) on `main..HEAD`; resolve EVERY finding (CRITICAL/HIGH/MEDIUM/LOW) by changing code, never by suppression; re-run gates; repeat to zero.
3. Update `docs/plan.md` §12 row `W2-C` → `🟨 PR open` with `feat/w2c-e2e / #<n>`; `docs/tasks/README.md` W2-C row; this file's header (`Status` → 🟨 PR open, `Progress` 6/6). Commit `docs(tasks): close out lane W2-C`.
4. Open the PR: `gh pr create --base main --title "test(e2e): Playwright harness, local git server and the six critical-flow specs (W2-C)" --body-file <generated>`. Body sections: Summary · How to run (mock: one command; real: prerequisites — Docker, `pnpm infra:image`, then one command; `E2E_KEEP_STACK=1`, `E2E_PORT_BASE`, `E2E_GITSERVER_HOST`) · Infrastructure decisions (the five from the lane Context) · Selector contract (FOUND / MISSING with component paths / ROLE-BASED — from 2C.3's log) · Real-stack matrix (from 2C.5's log) · Real-mode status (result of the boot attempt) · CI (`e2e` job in mock mode; the one-line flip for W3-A) · Gate results · contractChangeRequests (see 5).
5. Return to the orchestrator: `{ pr, branch, headSha, gates: { lint, format, typecheck, unitHarness, e2eMock, gitserverBuild, e2eRealBoot }, coverage: { harness: {...} }, contractChangeRequests: [ … ] }` listing at least: (a) W1-G/W1-H — add the MISSING `data-testid`s (exact ids + component files); (b) W1-C/W2-B — `createModelProvider('fake')` loads `FAKE_PROVIDER_SCRIPT_PATH` JSON (`Record<prompt, ScriptedStep[]>` + `default`); (c) W2-A — `ALLOWED_REPO_HOSTS`, `GITHUB_API_BASE_URL`, `GET /api/health?require=worker` → 503 until the worker heartbeat exists, `liveWorkspaces.{chat,job}` in `healthResponse`, `POST /api/chats` → 409 `SECRETS_MISSING` (confirm present on main or request); (d) W1-D/W2-B — runtime/worker must accept `http://<host>:<port>/sample.git` repo URLs (no hard-coded github.com check) and the worker must pass `ALLOWED_REPO_HOSTS` through untouched; (e) W1-G — `useTurnEvents` closes on terminal events (only if observed otherwise in mock mode); (f) W3-A — flip `E2E_MODE` in CI to `real` and run the matrix; (g) root `.gitignore` / root `tsconfig.json` one-line edits if you made them.

Constraints:
- English; Conventional Commits; no AI attribution anywhere.
- Do not wait for CI; do not merge; do not edit paths outside the lane beyond the two docs rows.

Verification:
- `gh pr view --json number,headRefOid,url` — PR exists; `git status --porcelain` empty; `git log --format=%B main..HEAD | grep -ci "co-authored-by\|generated with"` → 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-2c-e2e.md (lane header Status → 🟨 PR open); append `- 2C.6 ✅ <date> — PR #<n> opened`; the docs commit above precedes the PR.
````

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)

- 2C.1 ✅ 2026-08-20 — git server image (`agent-hangar/gitserver:test`) with a deterministic seed
  (`main` at `ff55e2f`, plus `feature/docs`) and the GitHub REST stub; verified by cloning and
  pushing a branch from a throwaway container against the running image.
- 2C.2 ✅ 2026-08-20 — harness: `resolveE2eEnv`/`serverEnv`, `prepare-stack`, Playwright config with
  managed servers per mode, fixtures, the fake-provider script and `smoke.spec.ts`. Mock mode runs
  against a production build: the mock API cannot boot under `next dev`, where React strict mode
  invokes its boot effect twice and the second `worker.start()` is rejected.
- 2C.3 ✅ 2026-08-20 — page objects and the selector contract, every locator validated against the
  running mock interface by `pages.smoke.spec.ts` (10 tests).
  · FOUND: `sidebar-slot`, `sidebar-rail`, `header-slot`, `chat-list-skeleton`, `new-chat-scroll`,
  `composer-skeleton`, `model-skeleton`, `chat-skeleton`, `transcript`, `stream-cursor`,
  `jobs-skeleton`, `runs-skeleton`, `secret-field-<KEY>`, `secret-mask-<KEY>`, `mock-booting`,
  `mock-failed`, plus the attributes `data-item-kind` and `data-tool-status`.
  · MISSING (no id and no stable role/name): `status-pill` (Chat header pill — located today
  through the polite live region inside it), `chat-list-item` `data-chat-id`, `job-row`
  `data-job-id`, `run-row` `data-run-id`, `tool-call-row` `data-tool-name`.
  · ROLE-BASED (no id needed): navigation and its three links, chat search, both chat lists,
  archived disclosure, environment pill, theme toggle, both pickers and their comboboxes and
  options, prompt box, Send, Stop, chat menu and its items, archived banner and its Restore,
  jobs and runs tables, job dialog fields, timezone combobox, row menus, confirm dialogs, run
  drawer and its tabs, credential Save/Replace/Remove, model line, environment summary.
- 2C.4 ✅ 2026-08-20 — `chat-create-run`, `chat-archive-restore` and `cancel-turn`, with the shared
  chat flow helpers. Turn and workspace state is asserted through `GET /api/chats/:id`, because
  `healthResponse` carries no workspace counters.
- 2C.5 ✅ 2026-08-20 — `scheduled-job-run`, `settings-save-mask`, `settings-missing`, and the CI
  `e2e` job body (mock mode; one line switches it to real). Postgres and Redis are published on
  the ports the instance derives (3901, 3902), which the destructive helpers require.
  · Real-stack matrix — chat-create-run[turn SUCCEEDED; two tool calls persisted; workspace READY];
  chat-archive-restore[workspace released; history intact; follow-up turn clones and succeeds];
  cancel-turn[turn CANCELLED inside the budget; workspace survives]; scheduled-job-run[run
  SUCCEEDED with output and one `run_shell` call]; settings-save-mask[masks survive a reload;
  `GET /api/settings` carries no plaintext; tool-call arguments stored redacted];
  settings-missing[`POST /api/chats` refused 409 SECRETS_MISSING].
- 2C.6 ✅ 2026-08-20 — gates green; review resolved two findings (the git server published on
  every interface, and a credential-shaped literal that was not a canary) plus three smaller ones;
  PR #32 opened.

- 2C.7 ✅ 2026-08-20 — rebased onto the merged HTTP API and re-attempted the real stack, which
  found five things the mock suite could not. Fixed here: the API client sent no `Origin`, so every
  write was refused 403 by the same-origin guard; the master key directory was created group- and
  world-readable, so the secrets module refused it and `PUT /api/settings/:key` answered 500;
  `seedSettings` used `raw` and swallowed both refusals, leaving the credentials unset and blaming
  whatever assertion noticed first; the send-disabled test never seeded credentials, so in real
  mode the screen showed the credentials notice instead of the composer; and the worker was never
  started at all, because a Playwright `webServer` entry pointed at the web server's own health
  route is considered already running — the worker now starts with the rest of the stack, and the
  global setup refuses to begin until it reports through `GET /api/health`.
  · Real-mode results with those fixes: `settings-save-mask` (credential lifecycle, reload
  persistence, no plaintext in `GET /api/settings`) and `settings-missing` (composer withheld,
  notice, recovery) both pass against the real API, database and git server. Remaining blockers, in
  the order a run meets them: `GITHUB_API_BASE_URL` is `https`-only so the loopback stub cannot be
  configured; `POST /api/chats` answers 400 rather than 409 because the request schema rejects a
  repository outside github.com before it checks credentials; and the worker still writes no
  heartbeat, since `apps/worker/src` is the skeleton.
- 2C.8 ✅ 2026-08-20 — resolved the automated reviewer's findings on the pull request. Two were real
  defects: the fixture README told the reader to publish the git server on every interface, and the
  git-server shim answered a spawn failure twice (`error` then `close`), where the second write
  throws `ERR_HTTP_HEADERS_SENT` and takes the process down. Three were stale descriptions of mock
  mode still calling it the dev server, one barrel was missing its header, and one acceptance
  criterion was ticked for an `e2e/tsconfig.json` that was deliberately never created — the
  criterion now states what is actually true. The substantive one: three specs guarded earlier than
  they needed to, so the only mode CI runs never exercised archive, restore, Stop or Run now even
  though the mock API implements all four. Each guard moved below those steps, and each was proved
  to run by breaking the control it drives. `chat-create-run` now also observes a non-terminal
  status pill before Done, so a turn that jumped straight to Done would fail.
- 2C.9 ✅ 2026-08-20 — the per-test reset could not recover from the state it exists to clear: a
  spec that died part way through a turn left it live, and `DELETE /api/chats/:id` refuses a chat
  in that state with `409 TURN_IN_PROGRESS`, so the reset threw and every later test in the run
  failed for a reason that looked unrelated. It now cancels any live turn and waits for it to
  settle before deleting, with the wait — not the cancel — carrying the guarantee.
- 2C.10 ✅ 2026-08-20 — rebased onto the merged worker and re-attempted the real stack. It stops
  in the same place and for the same reason as before, with one fact the earlier attempt could not
  show: `GITHUB_API_BASE_URL` being `https`-only stops the **worker** as well as the web server —
  it loads the same schema and dies at boot with `the worker could not start: Invalid
  configuration: - GITHUB_API_BASE_URL: Invalid URL`. So that one validator blocks both processes,
  not just the API, and the readiness gate cannot yet be confirmed against a live heartbeat.
  · Verified in passing, against a real orphan rather than a synthetic one: a run that aborts at
  the managed web server never reaches the global teardown, so its worker is left behind. The next
  run's pre-step found the recorded id, confirmed it was still the worker, stopped its whole group
  and recorded the replacement — the old process and its child were gone afterwards.
