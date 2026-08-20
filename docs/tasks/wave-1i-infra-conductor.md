# Wave 1 — Lane I — Infra scripts, doctor, Conductor

| | |
|---|---|
| **Lane** | W1-I (parallel with W1-A … W1-H; no Docker-integration tests — scripts are tested with PATH shims) |
| **Status** | 🟩 Merged |
| **Progress** | 6/6 tasks |
| **Branch** | `feat/w1i-infra-conductor` · PR [#18](https://github.com/bymaxone/agent-hangar/pull/18) |
| **Owned paths** | `infra/scripts/{setup,run,archive,doctor,rotate-key,ws,db-prune}.sh`, `infra/scripts/lib/**` (node helpers), `infra/scripts/*.test.ts`, `.conductor/settings.toml`, `infra/docker-compose.yml`, `.env.example`, root `package.json` **scripts block only**, root `vitest.config.ts` (`scripts` project lines only). `infra/scripts/env.sh` is W0 output with no other Wave 1 owner — additive edits allowed (see rules). |
| **Depends on** | W0 merged to `main` (Tasks 1I.3 and 1I.4 additionally need W1-A, W1-C, W1-E merged — this lane runs in the second Wave 1 batch, see plan §13) |
| **Unblocks** | nothing hard; **merges FIRST in its batch** (root `package.json` scripts block) |
| **Source** | [docs/plan.md §6 W1-I](../plan.md) · spec [05](../spec/05-local-dev.md) (all) [01 §8 R2](../spec/01-overview.md) [06 §3](../spec/06-testing.md) |
| **Last updated** | 2026-08-20 |

## Context

W0 (Task 0.6) created the parameterised compose file, `infra/scripts/env.sh` (instance/port derivation mirrored from `packages/core/src/config/instance.ts`), a working `setup.sh`, the workspace image base, `.env.example`, and **stubs** for `run.sh`, `archive.sh`, `doctor.sh` that exit 1 with "not implemented yet (lane W1-I)". This lane finishes the local run story of spec 05: `pnpm setup` (idempotent, ends with a real doctor), `pnpm dev` (one script that both humans and Conductor call), `pnpm doctor` (a table that explains every missing piece with the exact fix), archive (Conductor workspace teardown that leaves no containers behind), master-key rotation, the committed `.conductor/settings.toml`, and the final root `scripts` block.

Everything is keyed by instance (`AH_INSTANCE` / `AH_PORT_BASE`, with `CONDUCTOR_WORKSPACE_NAME` / `CONDUCTOR_PORT` fallbacks) so two checkouts run side by side with distinct ports, databases, compose projects and workspace-container prefixes. Scripts must run on macOS' default bash 3.2.

## Rules of this lane

1. Owned paths only. The root `package.json` **scripts block** is owned here and nowhere else in Wave 1; do not touch `dependencies`, `devDependencies`, `packageManager` or `engines`. No new dependencies (`concurrently`, `tsx`, `vitest` are already installed by W0).
2. Bash 3.2 compatible (`#!/usr/bin/env bash`, `set -euo pipefail`; no associative arrays, no `mapfile`, no `${var,,}`); `shellcheck`-clean by inspection (it is not installed — do not add it), and clean without suppressions: a `# shellcheck disable=` comment is a suppression like any other, so a list of arguments is held in a bash array and expanded as `"${arr[@]}"` rather than relying on word splitting. All script output in English. Never echo secrets; never write the master key inside the repo; never log `DATABASE_URL` passwords beyond the fixed `ah:ah` dev credentials.
3. Node helpers under `infra/scripts/lib/*.ts` are run with `pnpm exec tsx <file>` and import `@agent-hangar/core` **by relative path** to `packages/core/src/**` (the `infra/` folder is not a workspace package, so bare specifiers do not resolve there). They are TypeScript-strict, JSDoc'd, English, no `enum`, no suppression comments, 100 % covered by the root `scripts` Vitest project. `infra/scripts/tsconfig.json` is a `composite` project referencing `packages/core` and is listed in the root `tsconfig.json` `references`, so `pnpm typecheck` really covers these files — a project no root script builds is a project nothing checks.
4. Every script honours the same overrides so tests are hermetic: `MASTER_KEY_PATH`, `AH_ENV_FILE` (path of the `.env.local` to read/write; default `<repo>/.env.local` — add this override to `env.sh` if W0 did not, as an additive change) and `PATH` (tests prepend a directory of shim executables `docker`, `pnpm`, `node`, `openssl`, `concurrently` that record their argv to `$AH_SHIM_LOG` and print canned output).
5. `doctor.sh` exits non-zero if any **required** row is ✗ (node, pnpm, docker, postgres, redis, migrations, image, master key). Secrets and the OpenAI check are **optional** rows (⚠ when missing) and never fail the exit code.
6. Tests live in `infra/scripts/*.test.ts` and run in the root `vitest.config.ts` `scripts` project (created by W0 Task 0.6); shell behaviour is proven by spawning the scripts with `node:child_process` (`spawnSync`/`execFileSync`) and asserting stdout, exit code and the shim log. Root `scripts` project `coverage.include: ['infra/scripts/lib/**']`, thresholds 100×4.
7. JSDoc on every TS export + file header; test header + block comment on every `it()`; English; Conventional Commits; no AI-attribution trailers; canaries only from `@agent-hangar/core/testing`.
8. Branch `feat/w1i-infra-conductor`; one PR at the end (Task 1I.6). This PR is merged **first** in its batch — keep it small and rebase-friendly (do not reformat files you do not own).

## Reference docs

- [docs/plan.md](../plan.md) § "6. Wave 1" (W1-I), § "3. Parallelism rules", § "11. Orchestrator protocol" (merge order), § "13. Estimated complexity" (batch 2)
- [spec 05 — Local dev](../spec/05-local-dev.md) (all sections; §4 setup steps and doctor table, §5 compose, §6 Conductor)
- [spec 01 — Overview](../spec/01-overview.md) § "8. Risks" R2 (Docker socket), R7 (`listModels` in doctor)
- [spec 02 — Data model](../spec/02-data-model.md) § "5. Retention" (`db:prune`)
- [spec 06 — Testing](../spec/06-testing.md) § "3. Integration tests" (`AH_INSTANCE=test`)
- W0 files: `infra/scripts/env.sh`, `infra/scripts/setup.sh`, `infra/scripts/{run,archive,doctor}.sh` (stubs), `infra/docker-compose.yml`, `.env.example`, root `package.json` scripts, root `vitest.config.ts` (`scripts` project), `infra/scripts/env.test.ts`
- Core files used by helpers: `packages/core/src/config/{schema,instance}.ts`, `packages/core/src/secrets/**` (W1-A: `SecretsService` impl + master key file), `packages/core/src/persistence/{client.ts,repositories/index.ts}` (W1-E: `createRepositories`), `packages/core/src/model/registry.ts` (W1-C: `createModelProvider`)

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 1I.1 | `run.sh`, `setup.sh` completion, compose finishing, `.env.example` final, root scripts block | ✅ | P0 | M | — |
| 1I.2 | `archive.sh`, `ws.sh` (`ws:list` / `ws:reap`), `db-prune.sh` | ✅ | P0 | S | 1I.1 |
| 1I.3 | `doctor.sh` + node helpers (secrets status, OpenAI model check) with snapshot tests | ✅ | P0 | L | 1I.1, W1-A + W1-C + W1-E merged |
| 1I.4 | `rotate-key.sh` + `lib/rotate-key.ts` (re-encrypt under new key material at the stored `keyVersion`, atomic key swap, backup) | ✅ | P1 | M | 1I.3 |
| 1I.5 | `.conductor/settings.toml`, two-instance manual checklist, README "Working with Conductor" draft (appendix) | ✅ | P0 | S | 1I.1, 1I.2 |
| 1I.6 | Close-out: gates, code review, dashboard, PR | ✅ | P0 | S | 1I.1–1I.5 |

---

## Task 1I.1 — `run.sh`, `setup.sh` completion, compose finishing, `.env.example` final, root scripts block

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** Replace the `run.sh` stub with the single entry point used by `pnpm dev` and by Conductor's Run button; make `setup.sh` truly idempotent (safe re-run, `--force` env rewrite, doctor at the end); finish `infra/docker-compose.yml` (project `name` from env, tuned healthchecks); finalise `.env.example`; and write the final root `package.json` scripts block that every later lane relies on.

**Acceptance criteria**
- [x] `infra/scripts/run.sh`: `eval "$(infra/scripts/env.sh --print-effective)"`, creates `.env.local` if absent, prints `Agent Hangar · instance=<i> · http://localhost:<WEB_PORT>` before launching, then `exec pnpm exec concurrently -n web,worker -c blue,magenta --kill-others-on-fail "pnpm --filter web dev --port <WEB_PORT>" "pnpm --filter worker dev"` with the derived env exported; `--production` swaps both children for their `start` scripts and drops the `--conditions=development` export (the build output must be loaded, not the sources), so `pnpm start` gets the same instance ports, database and Redis as `pnpm dev`; `--print-only` prints the command without running it (used by tests); an unknown flag → usage + exit 2
- [x] `infra/scripts/setup.sh`: re-running on a configured machine performs no destructive action (env not overwritten, key not regenerated, compose `up -d --wait` idempotent, migrations no-op, image rebuild only when `--rebuild-image` or image missing); `--force` rewrites `.env.local`; detects and prints the Docker socket in use; calls `doctor.sh` at the end and propagates its exit code; `--skip-doctor` for CI
- [x] `infra/docker-compose.yml`: `name: ${COMPOSE_PROJECT_NAME:-agent-hangar-default}`, healthchecks `interval: 2s`, `timeout: 3s`, `retries: 30`, `start_period: 5s`, `restart: unless-stopped`, ports bound to `127.0.0.1`, volumes `pgdata`/`redisdata`
- [x] `.env.example` lists every variable of spec 05 §3 in that order, with the default, one-line comment, and the header stating that PAT/OpenAI key are entered in Settings, never in env
- [x] Root `package.json` scripts block is exactly the final list in the prompt (alphabetised inside groups), `dev` → `bash infra/scripts/run.sh`
- [x] Tests in `infra/scripts/run.test.ts` and `setup.test.ts` with PATH shims: env precedence (`AH_*` beats `CONDUCTOR_*` beats defaults), slugify, port math in the printed URL and `--port`, setup idempotence (second run records no `openssl`, no `env.sh --force`, compose `up` called with `--wait`, image build skipped when shim reports image present), `--force` rewrites env, socket detection order

**Files to create/modify**
`infra/scripts/run.sh`, `infra/scripts/setup.sh`, `infra/scripts/env.sh` (additive: `AH_ENV_FILE`), `infra/docker-compose.yml`, `.env.example`, `package.json` (scripts block), `infra/scripts/{run.test,setup.test}.ts`, `infra/scripts/testing/shims.ts` (test helper creating the shim dir — TS, covered).

**Agent prompt**

````
You are a senior platform engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: macOS + Docker Desktop (OrbStack/Colima compatible) · bash 3.2 · Node 24 · pnpm 11 · `concurrently` + `tsx` (root devDependencies) · Postgres 18 / Redis 8 in compose · Vitest 4 root `scripts` project for script tests.
Branch feat/w1i-infra-conductor (worktree, branched off latest main). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-I (Infra scripts, doctor, Conductor) — Task 1I.1 of 6 (FIRST)

PRECONDITIONS
- W0 merged to main; `infra/scripts/env.sh` works (`bash infra/scripts/env.sh --print`), `setup.sh` performs the W0 steps, `run.sh`/`archive.sh`/`doctor.sh` are stubs that exit 1, root `vitest.config.ts` has a `scripts` project running `infra/scripts/*.test.ts`.

REQUIRED READING (only these):
- docs/spec/05-local-dev.md § "3. Environment model", § "4. First-run experience", § "5. docker-compose services", § "6. Conductor integration"
- docs/spec/01-overview.md § "8. Risks" R2
- infra/scripts/env.sh, infra/scripts/setup.sh, infra/docker-compose.yml, .env.example, package.json (root), infra/scripts/env.test.ts, vitest.config.ts (root) — the W0 files you finish
- packages/core/src/config/instance.ts (the derivation `env.sh` must keep mirroring)

TASK
Finish the run/setup story: one `run.sh` used by `pnpm dev` and Conductor, an idempotent `setup.sh` that ends with doctor, the final compose file, `.env.example`, and the final root scripts block — all proven by Vitest tests that spawn the scripts with PATH shims (no real Docker in tests).

DELIVERABLES

1. `infra/scripts/testing/shims.ts` — test helper (TypeScript, under the root `scripts` Vitest project): `createShimDir(opts: { log: string; docker?: DockerShimBehaviour; image?: 'present' | 'missing'; psNames?: string[] })` writes executable shell shims for `docker`, `pnpm`, `openssl`, `node`, `concurrently` into a temp dir. Every shim appends `"<name> <args…>"` as one line to `$AH_SHIM_LOG` (the `log` path) and returns canned results: `docker image inspect <img>` → exit 0 when `image==='present'` else exit 1; `docker ps … --format …` → prints `psNames` one per line; `docker rm -f …` → exit 0; `docker compose … up -d --wait` → exit 0; `docker info` → exit 0; `pnpm …` → exit 0 (prints nothing); `openssl rand -hex 32` → prints 64 zeros; `node -v` → `v24.0.0`; `concurrently …` → exit 0. Also export `readShimLog(log): string[]` and `spawnScript(script, { env, args, shimDir, cwd })` returning `{ status, stdout, stderr }` with `PATH=<shimDir>:/usr/bin:/bin` (so `bash`, `grep`, `sed`, `mkdir`, `chmod`, `stat` stay real while every tool under test is shimmed). The helper must work on macOS and Linux (use `stat -f %Lp || stat -c %a` only inside the scripts, not here).
2. `infra/scripts/env.sh` (additive only): honour `AH_ENV_FILE` (default `<repo-root>/.env.local`; repo root resolved from the script's own path) for both reading and writing, keep `--print` / `--force` semantics. If W0 already has such an override, reuse its name and skip this item.
3. `infra/scripts/run.sh`:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../.." && pwd)"
   [ -f "${AH_ENV_FILE:-$root/.env.local}" ] || bash "$here/env.sh"
   eval "$(bash "$here/env.sh" --print)"
   echo "Agent Hangar · instance=$AH_INSTANCE · http://localhost:$WEB_PORT"
   if [ $production -eq 0 ]; then export NODE_OPTIONS="${NODE_OPTIONS:-} --conditions=development"; fi
   cmd=(pnpm exec concurrently -n web,worker -c blue,magenta --kill-others-on-fail)
   if [ $production -eq 1 ]; then
     cmd+=("pnpm --filter web start --port $WEB_PORT" "pnpm --filter worker start")
   else
     cmd+=("pnpm --filter web dev --port $WEB_PORT" "pnpm --filter worker dev")
   fi
   if [ $print_only -eq 1 ]; then printf '%q ' "${cmd[@]}"; echo; exit 0; fi
   cd "$root" && exec "${cmd[@]}"
   ```
   Export every variable from `env.sh --print` so `next dev` and `tsx watch` inherit `DATABASE_URL`, `REDIS_URL`, `WEB_PORT`, etc. `apps/web` must bind to `WEB_PORT` (the `--port` flag) — do not rely on Next's default 3000.
4. `infra/scripts/setup.sh` — keep W0's steps and make it idempotent end to end:
   - flags: `--force` (rewrite env file), `--rebuild-image`, `--skip-doctor`, `--skip-install` (CI speed); unknown flag → usage + exit 2.
   - Docker socket detection (W0 logic) prints `Docker socket: <path or DOCKER_HOST>`; if `docker info` fails → print the R2 fix (`Start Docker Desktop, or set DOCKER_HOST=unix://$HOME/.docker/run/docker.sock`) and exit 1.
   - master key: create dir 0700 / file 0600 only when missing; if present verify mode is exactly 600 (`stat -f %Lp` on Darwin, `stat -c %a` otherwise) and refuse otherwise with `chmod 600 <path>` as the fix. Honour `MASTER_KEY_PATH`.
   - compose: `docker compose -f infra/docker-compose.yml --env-file "$AH_ENV_FILE" up -d --wait`.
   - migrations: `pnpm --filter @agent-hangar/core db:generate` then `db:migrate` with the env exported from `env.sh --print` (not from `.env.local` parsing).
   - image: `docker image inspect "$WORKSPACE_IMAGE" >/dev/null 2>&1 || docker build -t "$WORKSPACE_IMAGE" infra/workspace`; `--rebuild-image` forces the build.
   - last step: `bash infra/scripts/doctor.sh` unless `--skip-doctor`; exit with its status. Until Task 1I.3 lands, the stub exits 1 — so during this task run setup with `--skip-doctor` and write the test accordingly (the test shims `doctor.sh` by invoking setup with `--skip-doctor` and a separate test asserts that without the flag `doctor.sh` is invoked, using `AH_SHIM_LOG` from a temporary replacement doctor via `AH_DOCTOR_SCRIPT` override — add that override: `AH_DOCTOR_SCRIPT` default `<here>/doctor.sh`).
   - Print a summary block at the end: instance, ports, db, compose project, image, key path.
5. `infra/docker-compose.yml` — final form per spec 05 §5 with: `name: ${COMPOSE_PROJECT_NAME:-agent-hangar-default}`; both services `restart: unless-stopped`; healthchecks `{ interval: 2s, timeout: 3s, retries: 30, start_period: 5s }`; postgres `pg_isready -U ah -d ${POSTGRES_DB}`; redis `redis-cli ping`; ports `127.0.0.1:${POSTGRES_PORT}:5432` / `127.0.0.1:${REDIS_PORT}:6379`; named volumes. No `profiles` (tests use `AH_INSTANCE=test`, which is its own compose project).
6. `.env.example` — final: header comment (3 lines: generated by `pnpm setup`; secrets live in Settings, not here; Conductor vars map to `AH_*`), then every variable of spec 05 §3 in table order with its default and a one-line comment, plus `NEXT_PUBLIC_API_MOCK=0` (UI mock mode, see W1-G). Values must equal the defaults `env.sh` derives for instance `default`.
7. Root `package.json` scripts block (final — other lanes rely on these names; alphabetise within each group, keep this exact set):
   ```json
   "dev": "bash infra/scripts/run.sh",
   "build": "pnpm -r --if-present build",
   "start": "bash infra/scripts/run.sh --production",
   "lint": "eslint .",
   "lint:fix": "eslint . --fix",
   "format": "prettier --write .",
   "format:check": "prettier --check .",
   "typecheck": "tsc -b",
   "test": "pnpm -r --if-present test && vitest run --project scripts",
   "test:integration": "pnpm -r --if-present test:integration",
   "test:e2e": "pnpm --filter web test:e2e",
   "test:mutation": "pnpm -r --if-present test:mutation",
   "setup": "bash infra/scripts/setup.sh",
   "doctor": "bash infra/scripts/doctor.sh",
   "infra:up": "bash -c 'eval \"$(bash infra/scripts/env.sh --print)\" && docker compose -f infra/docker-compose.yml up -d --wait'",
   "infra:down": "bash -c 'eval \"$(bash infra/scripts/env.sh --print)\" && docker compose -f infra/docker-compose.yml down'",
   "infra:reset": "bash -c 'eval \"$(bash infra/scripts/env.sh --print)\" && docker compose -f infra/docker-compose.yml down -v'",
   "infra:image": "bash infra/scripts/image.sh",
   "db:generate": "pnpm --filter @agent-hangar/core db:generate",
   "db:migrate": "bash -c 'eval \"$(bash infra/scripts/env.sh --print)\" && pnpm --filter @agent-hangar/core db:migrate'",
   "db:studio": "bash -c 'eval \"$(bash infra/scripts/env.sh --print)\" && pnpm --filter @agent-hangar/core exec prisma studio'",
   "db:prune": "bash infra/scripts/db-prune.sh",
   "ws:list": "bash infra/scripts/ws.sh list",
   "ws:reap": "bash infra/scripts/ws.sh reap",
   "archive": "bash infra/scripts/archive.sh",
   "rotate-key": "bash infra/scripts/rotate-key.sh",
   "prepare": "husky"
   ```
   If W0 wired `test` differently (e.g. the `scripts` project already runs inside `pnpm test`), keep W0's working form — the requirement is that `pnpm test` runs the script tests. Using `env.sh --print` instead of `--env-file .env.local` is deliberate: it lets `AH_INSTANCE=test AH_PORT_BASE=3200 pnpm infra:up` start a second stack without touching `.env.local`.
8. Tests (`infra/scripts/run.test.ts`, `infra/scripts/setup.test.ts`, `infra/scripts/testing/shims.test.ts`):
   - run: `--print-only` with defaults prints `http://localhost:3000` and `--port 3000`; with `AH_INSTANCE=Feat_X AH_PORT_BASE=3100` prints `instance=feat-x`, `:3100`; with only `CONDUCTOR_WORKSPACE_NAME=My Branch CONDUCTOR_PORT=4100` prints `instance=my-branch`, `:4100`; `AH_*` wins over `CONDUCTOR_*`; env file created at `AH_ENV_FILE` when missing (temp dir), not rewritten when present (mtime/content equal).
   - setup: first run in a temp HOME/AH_ENV_FILE/MASTER_KEY_PATH with shims → shim log contains in order `pnpm install --frozen-lockfile`, `docker info`, `openssl rand -hex 32`, `docker compose … up -d --wait`, `pnpm --filter @agent-hangar/core db:generate`, `… db:migrate`, `docker image inspect …`, `docker build …` (image missing); second run → no `openssl`, no `docker build` (image present), env file unchanged; `--force` → env file rewritten; `--rebuild-image` → `docker build` present even with image present; key file with mode 644 → exit 1 and stderr contains `chmod 600`; `docker info` failing shim → exit 1 and the R2 fix text; `--skip-doctor` → no doctor invocation; without it → `AH_DOCTOR_SCRIPT` (a shim that logs) is invoked last; unknown flag → exit 2.
   - shims: `createShimDir` produces executables; log records argv; image present/missing toggles.

Constraints:
- Bash 3.2; `set -euo pipefail`; English output; never print secrets.
- Owned paths only; additive changes to `env.sh` only; no dependency changes; do not touch `packages/**` or `apps/**`.
- Tests must not touch the developer's real `~/.agent-hangar`, real `.env.local` or real Docker — always set `HOME`, `MASTER_KEY_PATH`, `AH_ENV_FILE` and `PATH` in the spawned env.

Verification:
- `bash infra/scripts/run.sh --print-only` — prints URL + command; `AH_INSTANCE=feat-x AH_PORT_BASE=3100 bash infra/scripts/run.sh --print-only` — port 3100
- `pnpm setup --skip-doctor` on a machine with Docker — idempotent on second run (no rebuild, no key regen)
- `pnpm dev` — web + worker start on the derived ports (manual smoke)
- `pnpm vitest run --project scripts --coverage` — green, 100 % on `infra/scripts/lib/**` and `infra/scripts/testing/**`
- `pnpm lint && pnpm format:check && pnpm typecheck` — exit 0

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-1i-infra-conductor.md (task index row and task block)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/6 tasks`)
4. Append a completion log entry at the end of the file: `- 1I.1 ✅ <YYYY-MM-DD> — <one-line summary>`
5. Commit: `build(infra): add run script, idempotent setup, final compose and root scripts`
````

---

## Task 1I.2 — `archive.sh`, `ws.sh` (`ws:list` / `ws:reap`), `db-prune.sh`

**Status:** ✅ Done · **Priority:** P0 · **Size:** S · **Depends on:** 1I.1

**Description.** Implement the teardown path Conductor calls when a workspace is archived, plus the two debug aids for workspace containers and the retention script from spec 02 §5. Archive must leave no `ah-ws-<instance>-*` container and no compose resources of the instance behind, and must never touch another instance.

**Acceptance criteria**
- [x] `infra/scripts/archive.sh`: resolves env, runs `docker compose -f infra/docker-compose.yml down -v --remove-orphans` for the instance's project, then `docker rm -f` every container returned by `docker ps -aq --filter "label=ah.instance=<instance>"`; `--keep-env` keeps `.env.local`, default removes it; `--dry-run` prints what would be removed; exit 0 even when nothing exists
- [x] `infra/scripts/ws.sh list` prints `docker ps --filter "label=ah.instance=<instance>" --format 'table {{.Names}}\t{{.Status}}\t{{.Label "ah.kind"}}\t{{.Label "ah.chat"}}{{.Label "ah.jobRun"}}'`; `ws.sh reap` removes them (`docker rm -f`), printing the count; both scoped strictly by the instance label, never by name prefix alone
- [x] `infra/scripts/db-prune.sh [--days N]` (default 30) deletes `Workspace` rows with `status = 'DESTROYED' AND "destroyedAt" < now() - interval 'N days'` via `docker compose … exec -T postgres psql -U ah -d $POSTGRES_DB -c …`, prints the count, `--dry-run` counts only
- [x] Tests with shims: archive calls compose `down -v` with the right project env, calls `docker ps -aq --filter label=ah.instance=<slug>` and `docker rm -f <ids>` exactly once with all ids, never calls `rm -f` when `ps` returns nothing, removes/keeps the env file per flag, `--dry-run` performs no `rm`/`down`; `ws.sh list|reap` argv assertions; `db-prune.sh` SQL contains the interval and the status filter, `--days 7` → `7 days`, unknown subcommand → exit 2

**Files to create/modify**
`infra/scripts/archive.sh`, `infra/scripts/ws.sh`, `infra/scripts/db-prune.sh`, `infra/scripts/{archive.test,ws.test,db-prune.test}.ts`.

**Agent prompt**

````
You are a senior platform engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: bash 3.2 · Docker CLI (compose v2) · Postgres 18 in compose · Vitest 4 root `scripts` project with PATH shims (infra/scripts/testing/shims.ts from Task 1I.1).
Branch feat/w1i-infra-conductor (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-I — Task 1I.2 of 6 (MIDDLE)

PRECONDITIONS
- Task 1I.1 done: `env.sh` honours `AH_ENV_FILE`, shims helper exists, root scripts `archive`, `ws:list`, `ws:reap`, `db:prune` point at the files you now create.

REQUIRED READING (only these):
- docs/spec/05-local-dev.md § "4" (scripts table: ws:list/ws:reap), § "6. Conductor integration" (archive semantics, isolation table)
- docs/spec/02-data-model.md § "5. Retention"
- docs/spec/03-interfaces.md § "1" "DockerWorkspaceRunner behaviour" (labels `ah.instance`, `ah.workspace`, `ah.kind`, `ah.chat|ah.jobRun`)
- infra/scripts/env.sh, infra/scripts/testing/shims.ts

TASK
Implement archive (Conductor teardown), the workspace-container debug aids and the DB prune script, all scoped strictly to the current instance and proven with shim-based tests.

DELIVERABLES

1. `infra/scripts/archive.sh`:
   - `eval "$(bash "$here/env.sh" --print)"`; flags `--keep-env`, `--dry-run`; unknown → usage, exit 2.
   - Step 1: `docker compose -f "$root/infra/docker-compose.yml" down -v --remove-orphans` (env exported so `COMPOSE_PROJECT_NAME`, `POSTGRES_DB`, ports resolve). Tolerate "no such project" (compose exits 0 when nothing exists; if it exits non-zero because Docker is down, print the R2 hint and continue to step 2 — archive must be best-effort).
   - Step 2: the lookup is best-effort (`if ! listing="$(docker ps -aq --filter "label=ah.instance=$AH_INSTANCE")"; then listing=""; warn; fi`, so an unreachable daemon does not abort the run before the env-file step); its lines are read into a bash array and passed as `docker rm -f "${ids[@]}"`, never as an unquoted string — argument boundaries must come from the array, not from word splitting. Print `Removed N workspace container(s) of instance <i>`, or `No workspace containers for instance <i>` when the array is empty.
   - Step 3: unless `--keep-env`, `rm -f "$AH_ENV_FILE"` and say so.
   - `--dry-run`: print the three actions with the resolved values and perform none (no `down`, no `rm`).
   - Always exit 0 at the end unless the flag parsing fails. Never touch `~/.agent-hangar` (master key is shared across instances — spec 05 §6 table).
2. `infra/scripts/ws.sh <list|reap>`:
   - `list`: `docker ps --filter "label=ah.instance=$AH_INSTANCE" --format 'table {{.Names}}\t{{.Status}}\t{{.Label "ah.kind"}}\t{{.Label "ah.chat"}}{{.Label "ah.jobRun"}}'` (the two id labels are mutually exclusive so concatenation shows whichever is set).
   - `reap`: same id lookup as archive step 2 (`-aq`, label filter), `docker rm -f`, print the count; 0 is fine.
   - Anything else → usage, exit 2. Factor the "ids by instance label" lookup into a function used by both subcommands. `archive.sh` repeats the same four-line lookup rather than sourcing `ws.sh` — keep the scripts independently runnable; no shared bash library file.
3. `infra/scripts/db-prune.sh [--days N] [--dry-run]`:
   - env via `env.sh --print`; SQL: `DELETE FROM "Workspace" WHERE status = 'DESTROYED' AND "destroyedAt" < now() - interval '<N> days'` (`--dry-run` → `SELECT count(*) … same WHERE`). Validate `N` is a positive integer (bash regex `^[0-9]+$`), else exit 2.
   - Execute with `docker compose -f infra/docker-compose.yml exec -T postgres psql -U ah -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tAc "<sql>"` and print `Pruned N destroyed workspace rows older than D days` (psql `DELETE` prints `DELETE n` — parse the number with `sed`).
4. Tests (each spawning the script with shims and a temp `AH_ENV_FILE` pre-created by `env.sh`):
   - archive: default flags, `psNames`/ids shim returns `abc123 def456` → log has `docker compose … down -v --remove-orphans` then `docker ps -aq --filter label=ah.instance=feat-x` then `docker rm -f abc123 def456`; env file removed; `--keep-env` keeps it; empty `ps` → no `rm -f` line and the "No workspace containers" message; `--dry-run` → no `down`/`rm` lines, env file kept, stdout lists the three planned actions; instance slug from `CONDUCTOR_WORKSPACE_NAME="Feature ABC"` → `feature-abc` in the filter; exit 0 in all cases; unknown flag → 2.
   - ws: `list` argv contains the filter and the format string; `reap` removes ids / prints `0` when none; no subcommand → exit 2.
   - db-prune: default SQL contains `interval '30 days'` and `status = 'DESTROYED'`; `--days 7` → `'7 days'`; `--days x` → exit 2; `--dry-run` issues `SELECT count(*)`; psql via `docker compose … exec -T postgres psql -U ah -d agent_hangar_<instance>`.

Constraints:
- Bash 3.2; `set -euo pipefail`; English; instance scoping by **label**, never by name prefix alone; never call `docker rm` without the instance filter.
- Owned paths only; no new dependencies.

Verification:
- `AH_INSTANCE=feat-x bash infra/scripts/archive.sh --dry-run` — prints the three planned actions with `agent-hangar-feat-x` and the label filter
- `pnpm ws:list` on a machine with Docker — prints the table header even with zero rows
- `pnpm vitest run --project scripts --coverage` — green
- `pnpm lint && pnpm format:check && pnpm typecheck` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1i-infra-conductor.md; append `- 1I.2 ✅ <date> — <summary>`; commit `build(infra): add archive, workspace container aids and db prune scripts`.
````

---

## Task 1I.3 — `doctor.sh` + node helpers (secrets status, OpenAI model check) with snapshot tests

**Status:** ✅ Done · **Priority:** P0 · **Size:** L · **Depends on:** 1I.1, W1-A + W1-C + W1-E merged

**Description.** Replace the `doctor.sh` stub with the diagnostic table of spec 05 §4: node/pnpm versions, Docker socket path and reachability, Postgres and Redis reachability, migrations applied, workspace image present, master key present with mode 0600, secrets configured (via a tiny node helper that calls core's `SecretsService.status()` — only `set`/`last4` ever printed), and OpenAI model reachable (only when a key is set; via `createModelProvider('openai').listModels()`). Each ✗ prints the exact fix command; the exit code is non-zero when any required row fails.

**Acceptance criteria**
- [x] `doctor.sh` prints a fixed-width table with columns `Check | Status | Detail | Fix` and rows in this order: Node, pnpm, Docker socket, Postgres, Redis, Migrations, Workspace image, Master key, Secrets (optional), OpenAI model (optional); statuses `✓`, `✗`, `⚠` (optional missing), `–` (skipped with reason)
- [x] Each ✗/⚠ row's Fix is one of the exact commands listed in the prompt; required ✗ → exit 1; only optional ⚠ → exit 0
- [x] `--json` prints the same rows as a JSON array (`{ check, status, detail, fix }`) for tooling/tests
- [x] `infra/scripts/lib/secrets-status.ts` prints `GITHUB_PAT=set:<last4>|unset` and `OPENAI_API_KEY=set:<last4>|unset` using core `SecretsService.status()`; never prints plaintext; exits 3 with `db-unreachable` when Postgres is down, 4 with `master-key-missing` when the key file is absent/unreadable
- [x] `infra/scripts/lib/openai-check.ts` prints `ok <model>` when `OPENAI_MODEL` is in `listModels()`, `model-missing <model> (available: a, b, c…)` when not, `auth` on 401, `network` otherwise; exits non-zero except on `ok`; only ever called by doctor when the key is set
- [x] Snapshot tests with shims and `AH_DOCTOR_HELPER_CMD` override: all-green machine (exit 0), Docker down (exit 1 + R2 fix), image missing (fix `pnpm infra:image`), key mode 644 (fix `chmod 600`), migrations pending (fix `pnpm db:migrate`), secrets unset (⚠, exit 0, fix points at Settings URL with the instance's port), OpenAI skipped when key unset (`–`), `--json` parses and has 10 rows; helper TS files 100 % covered with in-memory repositories / fake provider

**Files to create/modify**
`infra/scripts/doctor.sh`, `infra/scripts/lib/{secrets-status,openai-check,cli-args}.ts` (+ `*.test.ts`), `infra/scripts/doctor.test.ts`, `infra/scripts/testing/shims.ts` (extend: `pg/redis` tcp behaviour flags, prisma `migrate status` output).

**Agent prompt**

````
You are a senior platform engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: bash 3.2 · Node 24 + `tsx` for helpers · `@agent-hangar/core` (W1-A `SecretsService` + master key file, W1-C `createModelProvider`, W1-E `createRepositories`, W0 `createPrismaClient`, `loadConfig`) · Docker CLI · Vitest 4 root `scripts` project.
Branch feat/w1i-infra-conductor (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-I — Task 1I.3 of 6 (MIDDLE)

PRECONDITIONS
- Task 1I.1 done. W1-A, W1-C and W1-E are merged to main and rebased into this branch (check: `packages/core/src/secrets/index.ts` exports a `SecretsService` factory and a master-key loader; `packages/core/src/model/registry.ts` exports `createModelProvider`; `packages/core/src/persistence/repositories/index.ts` exports `createRepositories`). If any is missing, STOP and report to the orchestrator — do not stub core behaviour here.

REQUIRED READING (only these):
- docs/spec/05-local-dev.md § "4. First-run experience" (the doctor paragraph), § "3. Environment model"
- docs/spec/01-overview.md § "8. Risks" R2, R7
- packages/core/src/secrets/index.ts (+ the files it exports: how to construct the service from `MASTER_KEY_PATH` and a `SecretRepository`; the `status()` shape), packages/core/src/secrets/types.ts
- packages/core/src/model/registry.ts and packages/core/src/model/openai/index.ts (constructor inputs: api key, base URL; `listModels()`)
- packages/core/src/persistence/client.ts, packages/core/src/persistence/repositories/index.ts
- packages/core/src/config/schema.ts (`loadConfig`)
- packages/core/src/testing/index.ts (in-memory repositories, `FakeAgentModelProvider`, canaries — for helper tests)
- infra/scripts/testing/shims.ts, infra/scripts/setup.sh (socket detection to reuse)

TASK
Implement `pnpm doctor`: a bash table with one row per check and an exact fix per failure, backed by two small TypeScript helpers for the checks that need core (secrets status, OpenAI model), all testable offline through shims and a helper-command override.

DELIVERABLES

1. `infra/scripts/lib/cli-args.ts` — tiny shared parser for the helpers: `parseFlags(argv, { allowed: string[] })` → `Record<string, string | true>`; throws on unknown flags. (Keeps helpers dependency-free; 100 % tested.)
2. `infra/scripts/lib/secrets-status.ts` — executable with `pnpm exec tsx infra/scripts/lib/secrets-status.ts`:
   - Injectable core: `export async function secretsStatus(deps: { loadConfig, createPrismaClient, assertDatabaseReachable, createRepositories, createSecretsService, env }): Promise<{ lines: string[]; exitCode: number }>` so tests inject fakes. The real-deps entry point lives in a separate ≤ 10-line file `infra/scripts/lib/secrets-status.main.ts` (imports the real core factories, calls `secretsStatus`, prints the lines, `process.exit(code)`); `*.main.ts` files are excluded from `coverage.include` by name pattern in the root vitest config (documented there) — never by a coverage-ignore comment, which is a banned suppression.
   - Behaviour: `loadConfig(env)`; create prisma + `assertDatabaseReachable` (failure → print `error db-unreachable` to stderr, exit 3); build `SecretsService` with the master key from `MASTER_KEY_PATH` (missing/unreadable → `error master-key-missing`, exit 4); `status()` → print `GITHUB_PAT=set:<last4>` or `GITHUB_PAT=unset`, same for `OPENAI_API_KEY`; exit 0. Never call `reveal`. Never print anything else.
3. `infra/scripts/lib/openai-check.ts` (+ `.main.ts`): `openaiCheck(deps: { loadConfig, createPrismaClient, assertDatabaseReachable, createRepositories, createSecretsService, createModelProvider, env })`: reveal `OPENAI_API_KEY` (doctor runs on the host with the same trust as the worker — document this; the value is passed to the provider constructor only, never printed), `provider.listModels()`; `OPENAI_MODEL` included → print `ok <model>` exit 0; not included → `model-missing <model> (available: <first 5 ids>, …)` exit 5; provider error with code `auth` → `auth` exit 6; anything else → `network <message redacted via core Redactor>` exit 7. If the key is unset → `no-key` exit 8 (doctor never calls it in that case, but the helper must be safe).
4. `infra/scripts/doctor.sh`:
   - `eval "$(bash "$here/env.sh" --print)"`; flags `--json`; `AH_DOCTOR_HELPER_CMD` override (default `pnpm exec tsx`) used as the prefix to run `infra/scripts/lib/<helper>.main.ts` — tests point it at a shim that prints canned helper output.
   - Rows (name · how · required · fix):
     1. `Node` · `node -v` major ≥ 24 · required · `nvm install 24 && nvm use 24` (detail shows version)
     2. `pnpm` · `pnpm -v` major ≥ 11 · required · `corepack enable && corepack prepare pnpm@11 --activate`
     3. `Docker socket` · W0 socket detection + `docker info >/dev/null` · required · detail `<path>`; fix `Start Docker Desktop (or set DOCKER_HOST=unix://$HOME/.docker/run/docker.sock)`
     4. `Postgres` · TCP connect `127.0.0.1:$POSTGRES_PORT` via bash `/dev/tcp` with a 2 s timeout (`( exec 3<>/dev/tcp/… ) 2>/dev/null` inside `timeout`-free loop — bash 3.2 has `/dev/tcp`; no `nc` dependency) · required · `pnpm infra:up`
     5. `Redis` · same on `$REDIS_PORT` · required · `pnpm infra:up`
     6. `Migrations` · `pnpm --filter @agent-hangar/core exec prisma migrate status` exit 0 (with env exported) · required · `pnpm db:migrate`; skipped (`–`) with detail `postgres down` when row 4 failed
     7. `Workspace image` · `docker image inspect "$WORKSPACE_IMAGE"` · required · `pnpm infra:image`; skipped when row 3 failed
     8. `Master key` · file exists and mode 600 (`stat -f %Lp` on Darwin, `stat -c %a` else) · required · missing → `pnpm setup`; wrong mode → `chmod 600 <path>`
     9. `Secrets` · helper `secrets-status` · optional · detail `GitHub PAT: set (…ab12) · OpenAI key: unset`; fix `Open http://localhost:$WEB_PORT/settings and save the missing key`; helper exit 3/4 → `–` with the helper's reason; skipped when rows 4 or 8 failed
     10. `OpenAI model` · helper `openai-check` only when row 9 reports the OpenAI key set · optional · `ok` → ✓ detail model; `model-missing` → ⚠ fix `Set OPENAI_MODEL in .env.local to one of the listed models`; `auth` → ⚠ fix `Replace the OpenAI key in Settings`; `network` → ⚠ fix `Check network / OPENAI_BASE_URL`; key unset → `–` detail `no OpenAI key`
   - Output: header line `Agent Hangar doctor · instance=<i> · ports <WEB>/<PG>/<REDIS> · db <POSTGRES_DB>`, then the table using `printf '%-16s %-3s %-40s %s\n'`; then a summary `N required checks failed` or `All required checks passed`. `--json` prints only the JSON array (build it with `printf` and proper escaping of `"` — details never contain quotes by construction). Exit 1 iff a required row is ✗.
   - Implementation hygiene: one function per row returning three values via globals `row_status`, `row_detail`, `row_fix` (bash 3.2 has no associative arrays), a `add_row` function appending to a newline-delimited string, and `emit_table`/`emit_json` at the end. Keep each function under 25 lines.
5. Tests:
   - `cli-args.test.ts`, `secrets-status.test.ts`, `openai-check.test.ts` (unit, 100 %): inject `createInMemoryRepositories`, a fake `createSecretsService` built on the in-memory `SecretRepository` with a temp master key (use W1-A's real implementation against a temp key file so `status()` and `reveal()` are real; `OPENAI_CANARY` as the stored value), `FakeAgentModelProvider` for `listModels` (`['fake-model']`) — cover: unset/set status lines, db-unreachable exit 3, key-missing exit 4, ok/model-missing/auth/network/no-key exits, never printing the canary (`assertNoCanary` on all stdout/stderr).
   - `doctor.test.ts` (spawned with shims; `AH_DOCTOR_HELPER_CMD` → a shim script `helper.sh` that prints fixture output selected by an env var `AH_SHIM_HELPER_CASE`): scenarios with exact stdout snapshots (`toMatchInlineSnapshot` after normalising the temp paths): all green → exit 0; docker down → row 3 ✗ with the R2 fix, rows 7 `–`, exit 1; postgres down (reserve a port base whose derived Postgres port nothing is listening on, so the `/dev/tcp` probe finds a closed port) → rows 4,6,9,10 as specified; image missing → `pnpm infra:image`; key mode 644 → `chmod 600`; migrations pending (shim `pnpm … prisma migrate status` exit 1) → `pnpm db:migrate`; secrets unset → ⚠ fix with `http://localhost:<WEB_PORT>/settings`, exit 0; OpenAI key set + helper `ok gpt-5.6-sol` → ✓; `--json` → `JSON.parse` gives 10 objects with the four keys.
   - Redis/Postgres "reachable" in tests: bind the throwaway `node:net` listener on the port the derivation points at, instead of pointing the derivation at a port the test chose. `env.sh` derives `POSTGRES_PORT`/`REDIS_PORT` from `AH_PORT_BASE` and deliberately ignores same-named variables in the environment, so the test asks the OS for a free port, takes `AH_PORT_BASE = port - 1`, binds `base + 2` as well, and retries when that neighbour is already taken. **Do not relax the derivation to honour an explicit `POSTGRES_PORT`/`REDIS_PORT`** — that override existed once, for exactly this test, and it cost instance isolation: `AH_PORT_BASE=3100 POSTGRES_PORT=3001` produced an environment calling itself `feat-x` while its `DATABASE_URL` addressed the **default** instance's database, with every other value still naming `feat-x`, and `resolveInstance` deriving 3101 so the two halves of the system disagreed about which database they were talking to. An instance is a sealed sandbox; the identity block exists to make that state unrepresentable, and a test-only override is still an override. `infra/scripts/env.test.ts` pins the rule.

Constraints:
- Bash 3.2; `set -euo pipefail` (guard every command whose failure is a result, not an error, with `if …; then` or `|| true`); English; never print secrets (only `last4`).
- Owned paths only; `*.main.ts` entry files excluded from coverage by name (state it in the vitest config comment); no suppression comments anywhere.
- No new dependencies; helpers import core by relative path (`../../../packages/core/src/...`).

Verification:
- `pnpm doctor` on a configured machine — all required ✓, exit 0; `pnpm doctor --json | node -e "JSON.parse(require('fs').readFileSync(0,'utf8'))"` — valid
- `pnpm infra:down && pnpm doctor; echo $?` — Postgres/Redis ✗ with `pnpm infra:up`, exit 1
- `pnpm vitest run --project scripts --coverage` — green, 100 % on `infra/scripts/lib/**` (minus `*.main.ts`) and `infra/scripts/testing/**`
- `pnpm lint && pnpm format:check && pnpm typecheck` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1i-infra-conductor.md; append `- 1I.3 ✅ <date> — <summary>`; commit `build(infra): implement doctor with secrets and model checks`.
````

---

## Task 1I.4 — `rotate-key.sh` + `lib/rotate-key.ts`

**Status:** ✅ Done · **Priority:** P1 · **Size:** M · **Depends on:** 1I.3

**Description.** Provide the master-key rotation path the README promises (spec 04 (d) controls table: "README explains backup/rotation (`keyVersion`)"): generate a new key, re-encrypt every `Secret` row under it using core's `SecretsService`, swap the key file atomically and keep a timestamped backup of the old key. The stored `keyVersion` stays where it is — every ordinary reader builds its provider without a version and decrypts at `MASTER_KEY_VERSION`, so advancing it would make every rotated credential unreadable. Failure that can be rolled back leaves the old key active and the rows decryptable; the one failure that cannot (a store that becomes unreachable mid-rollback) is reported separately so the new key file is kept rather than deleted.

**Acceptance criteria**
- [x] `infra/scripts/lib/rotate-key.ts` exports `rotateSecrets(deps)` that: reads the stored `keyVersion` (max over rows, default 1), builds service A (old key) and service B (new key) at that same version, reveals every set secret into memory first (any `SecretIntegrityError` → abort before writing, exit 2), writes each with B, and on a write failure re-writes the already-rotated keys with A (compensation) and exits 3; a compensation write that itself fails exits 4 and names the secrets left under the new key; prints `rotated N secret(s) under keyVersion V`
- [x] `infra/scripts/rotate-key.sh`: `--yes` required (otherwise prints the plan and exits 2); generates `<MASTER_KEY_PATH>.new` (0600, `openssl rand -hex 32`); runs the helper with `AH_NEW_MASTER_KEY_PATH`; on helper success `mv master.key master.key.bak-<YYYYMMDDHHMMSS>` then `mv master.key.new master.key`; on failure removes `.new` and leaves the old key untouched; prints the backup path and the reminder that backups hold a key that can still decrypt the old ciphertext (delete after verifying); refuses to run if `master.key.new` already exists (previous aborted rotation) unless `--resume`
- [x] Tests: helper unit with in-memory `SecretRepository` + W1-A real service against two temp keys (rotates both secrets; `keyVersion` unchanged; a rotated secret is still readable through the ordinary `MasterKeyFile` construction path; `reveal` with the new key returns the original values; old key can no longer decrypt; tamper → abort with no writes; injected write failure on the second secret → first secret restored to the old key, exit 3; a failing compensation → exit 4 naming the stranded secret; no canary in output); shell test with shims (`openssl` shim + helper shim): plan-only without `--yes`, success path renames files and keeps mode 600, failure path keeps old key and removes `.new`, helper exit 4 keeps `.new` and names both files, `.new` present → refuse unless `--resume`, helper override path containing a space still resolves to one command

**Files to create/modify**
`infra/scripts/rotate-key.sh`, `infra/scripts/lib/rotate-key.ts`, `infra/scripts/lib/rotate-key.main.ts`, `infra/scripts/lib/rotate-key.test.ts`, `infra/scripts/rotate-key.test.ts`.

**Agent prompt**

````
You are a senior platform engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: bash 3.2 · Node 24 + tsx · `@agent-hangar/core` secrets (W1-A: AES-256-GCM `SecretsService`, master key file loader, `keyVersion`), persistence (W1-E `createRepositories`) · Vitest 4 root `scripts` project.
Branch feat/w1i-infra-conductor (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-I — Task 1I.4 of 6 (MIDDLE)

PRECONDITIONS
- Task 1I.3 done (helpers pattern `lib/<name>.ts` + `lib/<name>.main.ts`, shims, `AH_DOCTOR_HELPER_CMD`-style override).

REQUIRED READING (only these):
- docs/spec/04-flows.md (d) (controls table: key rotation line), docs/spec/02-data-model.md § "2" (Secret model, `keyVersion`), § "3" invariant 4
- packages/core/src/secrets/** (how a service is constructed with an explicit key + keyVersion; `SecretIntegrityError`; `status()`/`reveal()`/`set()`)
- packages/core/src/persistence/ports.ts (`SecretRepository`)
- infra/scripts/lib/secrets-status.ts (reuse its deps pattern), infra/scripts/testing/shims.ts

TASK
Implement master-key rotation: a TypeScript helper that re-encrypts every stored secret under new key material at the stored `keyVersion` (abort-safe, with compensation), and a bash wrapper that generates the new key, runs the helper, swaps the key file atomically and keeps a timestamped backup.

DELIVERABLES

1. `infra/scripts/lib/rotate-key.ts` — `export async function rotateSecrets(deps: { repos: { secrets: SecretRepository }; createService: (key: Uint8Array | string, keyVersion: number) => SecretsService; oldKey; newKey; log: (line: string) => void }): Promise<{ rotated: number; keyVersion: number; exitCode: 0 | 2 | 3 | 4; strandedKeys: SecretKey[] }>`:
   - `current = max(keyVersion of rows) ?? 1` (use `repos.secrets.get(key)` for both keys); `A = createService(oldKey, current)`, `B = createService(newKey, current)` — the same version on both sides, because an ordinary reader decrypts at `MASTER_KEY_VERSION` and would refuse anything stamped higher.
   - Phase 1 (read-only): for each key with `status().set` → `A.reveal(key)`; any throw (integrity/wrong key) → log `abort: cannot decrypt <key> with the current master key` and return exit 2 with no writes.
   - Phase 2: for each revealed key → `B.set(key, plaintext)`; on throw → for each already-rotated key `A.set(key, plaintext)` (compensation), log `rolled back N secret(s)`, return exit 3. A compensation write that itself throws leaves the store split across the two keys: collect those keys, log `rollback incomplete: … keep both key files`, return exit 4.
   - Success: log `rotated N secret(s) under keyVersion <current>`; return 0. Plaintext values live only in a local `Map` that is cleared (`map.clear()`) in a `finally`.
   - How `createService` is built from core depends on W1-A's API (e.g. `createSecretsService({ repository, masterKey, keyVersion })` or a `MasterKeyFile` loader) — read `packages/core/src/secrets/index.ts` and adapt; the deps signature above is what the tests inject.
2. `infra/scripts/lib/rotate-key.main.ts` — real wiring: `loadConfig`, prisma + `assertDatabaseReachable`, `createRepositories`, read old key from `MASTER_KEY_PATH`, new key from `AH_NEW_MASTER_KEY_PATH`, call `rotateSecrets`, `process.exit(code)`. ≤ 20 lines; excluded from coverage by the `*.main.ts` pattern.
3. `infra/scripts/rotate-key.sh`:
   - `eval "$(env.sh --print)"`; `key="$MASTER_KEY_PATH"`; flags `--yes`, `--resume`; unknown → exit 2.
   - Without `--yes`: print the plan (key path, backup name pattern, "re-encrypts N secrets" where N comes from `secrets-status` helper output count of `set:`), exit 2.
   - If `"$key.new"` exists and not `--resume` → print `A previous rotation was interrupted; inspect <key>.new and re-run with --resume, or delete it` and exit 1.
   - Generate: `umask 077; openssl rand -hex 32 > "$key.new"; chmod 600 "$key.new"` (skip when `--resume`).
   - Run helper: the default prefix `pnpm exec tsx` or, when `AH_DOCTOR_HELPER_CMD` is set, that single executable path — held in a bash array and expanded as `"${cmd[@]}"`, never as an unquoted string — applied to `"$here/lib/rotate-key.main.ts"` with `AH_NEW_MASTER_KEY_PATH="$key.new"` exported; capture exit code without `set -e` aborting (`if ! …; then rc=$?; fi`).
   - Success: `ts="$(date +%Y%m%d%H%M%S)"; mv "$key" "$key.bak-$ts"; mv "$key.new" "$key"; chmod 600 "$key"`; print `Master key rotated. Backup: <key>.bak-<ts> — it can still decrypt the PREVIOUS ciphertext; delete it once you verified the app (pnpm doctor) and keep it out of backups.`
   - Failure (rc = 4, the rollback itself failed): KEEP `"$key.new"` — part of the store is sealed under it and deleting it destroys those credentials — print a message naming both files and exit 4.
   - Failure (any other rc ≠ 0): remove `"$key.new"` (except under `--resume`, where the file is kept so the user can inspect it), print `Rotation aborted (helper exit <rc>); the current master key is unchanged.` and exit `rc`.
4. Tests:
   - `lib/rotate-key.test.ts` (unit, 100 %): in-memory repositories from `@agent-hangar/core/testing`; W1-A real service factory with two random 32-byte keys; store `GITHUB_CANARY`/`OPENAI_CANARY` under key 1 → rotate → `status()` shows same `last4`, `reveal` with B returns the canaries, `reveal` with A now throws `SecretIntegrityError`; `keyVersion` on rows is still 1 and a rotated secret is readable through a `MasterKeyFile` provider built with no version at all; zero secrets → `rotated 0`; tampered ciphertext (flip a byte via the repository) → exit 2 and rows untouched (compare envelopes byte-wise); a `createService` returning a B whose `set` throws on the second call → exit 3, first key re-encrypted with A and revealable, log contains `rolled back 1`; every log line passes `assertNoCanary`.
   - `rotate-key.test.ts` (spawned, shims for `openssl` and the helper via `AH_DOCTOR_HELPER_CMD`): no `--yes` → exit 2 and plan text; success path (helper shim exit 0) → `master.key` content equals the generated value, a `master.key.bak-*` exists with the old content, modes 600; failure path (helper shim exit 3) → old key unchanged, no `.new`, exit 3; helper exit 4 → old key unchanged, `.new` KEPT, message names both files; a helper override path containing a space still resolves to one command; pre-existing `.new` → exit 1 unless `--resume`, in which case `openssl` is not called and the helper runs.

Constraints:
- Bash 3.2; `umask 077` before writing keys; never print key material or plaintext; English.
- Owned paths only; no new dependencies; no suppression comments (the `.main.ts` files are excluded by pattern, not by comment).

Verification:
- `pnpm rotate-key` (no flag) — prints the plan, exit 2; `pnpm rotate-key --yes` on a configured machine → rotated, `pnpm doctor` still shows secrets set, Settings page shows same `last4`
- `pnpm vitest run --project scripts --coverage` — green, 100 %
- `pnpm lint && pnpm format:check && pnpm typecheck` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1i-infra-conductor.md; append `- 1I.4 ✅ <date> — <summary>`; commit `build(infra): add master key rotation script`.
````

---

## Task 1I.5 — `.conductor/settings.toml`, two-instance manual checklist, README "Working with Conductor" draft

**Status:** ✅ Done · **Priority:** P0 · **Size:** S · **Depends on:** 1I.1, 1I.2

**Description.** Commit the Conductor configuration exactly as spec 05 §6, prove it by a test that parses the TOML minimally and checks the referenced scripts exist and are executable, run the two-instance side-by-side checklist manually and record the expected outputs in the appendix of this file, and draft the README section that W3-B will paste (W1-I does not own `README.md`).

**Acceptance criteria**
- [x] `.conductor/settings.toml` content is exactly: `"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"`, `[scripts]` with `setup = "./infra/scripts/setup.sh"`, `run = "./infra/scripts/run.sh"`, `archive = "./infra/scripts/archive.sh"`, `run_mode = "concurrent"` (comments allowed)
- [x] `infra/scripts/conductor.test.ts` parses the file with a ~30-line inline TOML subset parser (`[table]`, `key = "string"`, `"quoted key" = "string"`, `#` comments) and asserts the four values + `$schema`; asserts each referenced script exists relative to the repo root and is executable (`fs.accessSync(path, X_OK)`); asserts `run_mode` is `concurrent`
- [x] Appendix A of this file filled with the manual two-instance checklist (exact commands, expected `doctor` tables, `docker ps` names/ports, archive result) and marked as executed with date and outcome
- [x] Appendix B of this file contains the README "Working with Conductor" section text (English), ready for W3-B to paste verbatim

**Files to create/modify**
`.conductor/settings.toml`, `infra/scripts/conductor.test.ts`, this file (appendices A and B).

**Agent prompt**

````
You are a senior platform engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: Conductor (macOS app; per-workspace git worktrees; exposes CONDUCTOR_WORKSPACE_NAME, CONDUCTOR_PORT, CONDUCTOR_ROOT_PATH; runs setup/run/archive scripts) · bash 3.2 · Vitest 4 root `scripts` project.
Branch feat/w1i-infra-conductor (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-I — Task 1I.5 of 6 (MIDDLE)

PRECONDITIONS
- Tasks 1I.1 and 1I.2 done (`run.sh`, `setup.sh`, `archive.sh` real). Docker Desktop available locally for the manual checklist (Task 1I.3's doctor is preferable but the checklist can be executed with `--skip-doctor` and re-verified later).

REQUIRED READING (only these):
- docs/spec/05-local-dev.md § "6. Conductor integration" (the TOML block and the isolation table), § "7" item 7
- infra/scripts/{env,setup,run,archive}.sh
- docs/tasks/wave-1i-infra-conductor.md (this file) Appendix A/B placeholders

TASK
Commit the Conductor settings file, prove it with a test, execute the two-instance side-by-side checklist manually and record the evidence in Appendix A, and write the README section draft in Appendix B.

DELIVERABLES

1. `.conductor/settings.toml`:
   ```toml
   # Conductor workspace configuration (https://www.conductor.build/docs/reference/scripts)
   # AH_INSTANCE / AH_PORT_BASE are derived inside the scripts from CONDUCTOR_WORKSPACE_NAME / CONDUCTOR_PORT.
   "$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

   [scripts]
   setup = "./infra/scripts/setup.sh"
   run = "./infra/scripts/run.sh"
   archive = "./infra/scripts/archive.sh"
   run_mode = "concurrent"
   ```
   Check the current Conductor docs for the schema URL and whether `run_mode` belongs under `[scripts]` or at top level; follow the docs if they differ from the spec and note it in the PR.
2. `infra/scripts/conductor.test.ts` — inline `parseTomlSubset(text): Record<string, Record<string, string> | string>` handling `[table]` headers, `key = "value"` and `"quoted.key" = "value"` lines, `#` comments and blank lines (throw on anything else so drift is caught); assertions: `$schema` equals the URL, `scripts.setup/run/archive` equal the three paths, `run_mode === 'concurrent'`; each path resolved from the repo root exists and is executable (`fs.accessSync(p, fs.constants.X_OK)`); scripts start with `#!/usr/bin/env bash`.
3. Manual checklist (execute it; paste real output, redacting nothing because nothing secret is printed) into Appendix A of this file. Commands:
   ```bash
   # Terminal 1 — default instance (repo checkout A)
   pnpm setup && pnpm doctor
   pnpm dev                      # → http://localhost:3000

   # Terminal 2 — second instance in a second worktree (git worktree add ../agent-hangar-feat-x)
   cd ../agent-hangar-feat-x
   AH_INSTANCE=feat-x AH_PORT_BASE=3100 pnpm setup && AH_INSTANCE=feat-x AH_PORT_BASE=3100 pnpm doctor
   AH_INSTANCE=feat-x AH_PORT_BASE=3100 pnpm dev   # → http://localhost:3100

   # Evidence
   docker ps --format 'table {{.Names}}\t{{.Ports}}'   # agent-hangar-default-postgres-1 127.0.0.1:3001->5432, agent-hangar-feat-x-postgres-1 127.0.0.1:3101->5432, redis 3002/3102
   docker volume ls | grep agent-hangar                # pgdata/redisdata for both projects
   AH_INSTANCE=feat-x AH_PORT_BASE=3100 pnpm ws:list   # empty table (no chats yet)

   # Teardown of the second instance only
   AH_INSTANCE=feat-x AH_PORT_BASE=3100 bash infra/scripts/archive.sh
   docker ps --format '{{.Names}}' | grep agent-hangar  # only default remains
   ```
   Record: the two doctor headers (`instance=default · ports 3000/3001/3002 · db agent_hangar_default` and `instance=feat-x · ports 3100/3101/3102 · db agent_hangar_feat_x`), the `docker ps` table, and the post-archive `docker ps` list. If `pnpm doctor` is not yet implemented when you run this, use `--skip-doctor` and `env.sh --print` output instead, and mark the appendix "re-verify after 1I.3".
4. Appendix B — README section "Working with Conductor" (English, ~15 lines): what Conductor is in one sentence; open the repo in Conductor → New workspace → setup runs automatically (`setup.sh` derives `AH_INSTANCE` from the workspace name and `AH_PORT_BASE` from `CONDUCTOR_PORT`) → click Run → open the printed URL; what is isolated per workspace (table from spec 05 §6: DB, Redis, ports, workspace containers, `.env.local`; master key shared); how to run two instances without Conductor (`AH_INSTANCE=feat-x AH_PORT_BASE=3100 pnpm setup && … pnpm dev`); Archive = `archive.sh` (compose down -v + reap `ah-ws-<instance>-*`); `pnpm doctor` shows the instance header. W3-B pastes this verbatim into README §7 — write it as final prose, not notes.

Constraints:
- Owned paths only (`.conductor/settings.toml`, the test, this docs file). Do NOT edit README.md.
- English everywhere; no new dependencies (the TOML parser is inline in the test).

Verification:
- `pnpm vitest run --project scripts` — conductor test green
- Appendix A filled with real outputs and dated; Appendix B present
- `pnpm lint && pnpm format:check` — exit 0

Completion Protocol: update status/AC/progress in docs/tasks/wave-1i-infra-conductor.md; append `- 1I.5 ✅ <date> — <summary>`; commit `build(infra): add Conductor settings and two-instance checklist`.
````

---

## Task 1I.6 — Close-out: gates, code review, dashboard, PR

**Status:** ✅ Done · **Priority:** P0 · **Size:** S · **Depends on:** 1I.1–1I.5

**Description.** Run every gate, bring the code review to zero findings, update the plan dashboard and the tasks index, and open the PR. This PR is merged first in its batch, so keep it conflict-free with `main` (rebase before opening).

**Acceptance criteria**
- [x] `pnpm lint && pnpm format:check && pnpm typecheck` — exit 0
- [x] `pnpm vitest run --project scripts --coverage` — green, 100/100/100/100 on `infra/scripts/lib/**` (minus `*.main.ts`) and `infra/scripts/testing/**`; `pnpm test` green (one pre-existing, out-of-scope failure — see PR body's Contract change requests)
- [x] Manual: `pnpm setup` twice (idempotent, verified live against real Docker/Postgres/Redis — Appendix A), `pnpm doctor` exit 0 (live), `pnpm dev` serves the URL it prints (`run.sh --print-only`, live), `AH_INSTANCE=feat-x AH_PORT_BASE=3100 bash infra/scripts/archive.sh --dry-run` lists `agent-hangar-feat-x`
- [x] `/bymax-quality:code-review` → zero open findings (performed by hand: mechanical gate + manual bug hunt + convention checklist; one dead-export finding fixed by wiring `cli-args.ts` into the three `.main.ts` entry points)
- [x] `docs/plan.md` §12 row W1-I → 🟨 with branch/PR; `docs/tasks/README.md` row updated
- [x] PR opened; structured result returned

**Files to create/modify**
`docs/plan.md` (§12 row only), `docs/tasks/README.md` (W1-I row only), this file.

**Agent prompt**

````
You are a senior engineer closing out lane W1-I of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: bash 3.2 · Node 24 · pnpm 11 · Docker Desktop · Vitest 4 · GitHub CLI.
Branch feat/w1i-infra-conductor (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-I — Task 1I.6 of 6 (LAST)

PRECONDITIONS
- Tasks 1I.1–1I.5 done and committed. `git fetch origin && git rebase origin/main` clean (this PR merges first in its batch; resolve any `package.json` scripts conflict in favour of the final block from Task 1I.1).

REQUIRED READING (only these):
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard"
- docs/tasks/README.md
- CLAUDE.md "Gates before any PR"

TASK
Run all gates and the manual smoke, run the code review to zero findings, update the dashboards, and open the PR with a structured summary. Do not wait for CI; do not merge.

DELIVERABLES

1. Gates: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` (includes the `scripts` project), `pnpm vitest run --project scripts --coverage` (100 % on `infra/scripts/lib/**` excluding `*.main.ts`, and `infra/scripts/testing/**`). Manual smoke on this machine: `pnpm setup` twice → second run prints no key generation and no image build; `pnpm doctor` exit 0; `pnpm dev` prints the URL and both processes start (Ctrl+C exits cleanly); `pnpm ws:list` prints the table header; `AH_INSTANCE=feat-x AH_PORT_BASE=3100 bash infra/scripts/archive.sh --dry-run` names `agent-hangar-feat-x`.
2. `/bymax-quality:code-review` on `main..HEAD`; fix every finding (CRITICAL/HIGH/MEDIUM/LOW) — no suppression comments; re-run gates. Unfixed findings need a one-line justification in the PR body.
3. Update `docs/plan.md` §12 row `W1-I` → `🟨` with `feat/w1i-infra-conductor` / PR number (number in a follow-up commit `docs: record W1-I PR in dashboard`); `docs/tasks/README.md` row → 🟨; this file's header Status → 🟨 PR open, Progress → 6/6.
4. Verify history: Conventional Commits, English, no attribution trailers (`git log --format=%B main..HEAD | grep -i -E 'co-authored-by|generated with'` empty).
5. `gh pr create --base main --head feat/w1i-infra-conductor --title "build(infra): finish local run story, doctor, archive and Conductor integration (W1-I)" --body-file <generated>`. Body: Summary · Scripts (table: script → purpose → flags) · Root `package.json` scripts block (state that this PR must merge first in the batch and why) · Doctor rows and fixes · Rotation procedure · Conductor file · Two-instance evidence (link to Appendix A) · README draft for W3-B (link to Appendix B) · Gate results · Coverage · Contract change requests (empty or list; e.g. if `env.sh` needed an override you could not add additively).
6. Return: `{ pr, branch, headSha, gates: { lint, format, typecheck, unit, scripts }, coverage: { lines, branches, functions, statements }, contractChangeRequests: [] }`.

Constraints:
- English; Conventional Commits; no AI attribution; owned paths only plus the two dashboard rows.
- Do not wait for CI; do not merge.

Verification:
- `gh pr view --json number,headRefOid,url` — PR exists, `headRefOid` equals `git rev-parse HEAD`

Completion Protocol: append `- 1I.6 ✅ <date> — PR #<n> opened`; commit `docs: close out W1-I lane` before opening the PR (dashboard follow-up commit after).
````

---

## Appendix A — Two-instance manual checklist (filled by Task 1I.5)

_Status: executed 2026-08-19, against real Docker Desktop, real Postgres 18 / Redis 8, real Prisma
migrations, on the machine this lane ran on — with one deliberate substitution noted below._

**Port substitution.** The reserved `default`/3000 block collides on this shared development
machine with an unrelated, already-running project's container bound to host port 3001
(`community-core-obs-app-1`, nothing to do with Agent Hangar). Bringing the reserved block up live
would have required stopping someone else's running service, which this lane has no authority to
do. `AH_INSTANCE`/`COMPOSE_PROJECT_NAME`/`POSTGRES_DB` (the values spec 05 §6 isolation actually
depends on) are unaffected by the port base, so the live walkthrough below uses
`AH_INSTANCE=default AH_PORT_BASE=3910` and `AH_INSTANCE=feat-x AH_PORT_BASE=3920` — real instance
names, an alternate free port block. The `env.sh --print` output for the literal reserved ports
(3000/3100) is recorded separately in A1/A3 to document what a clean machine would show; the
`pnpm dev` steps (A2/A4) use `run.sh --print-only` rather than actually starting the long-running
web/worker processes, since a foreground dev server has nothing further to prove that the
`run.test.ts` PATH-shim suite (Task 1I.1) does not already cover.

| Step | Command | Expected | Observed (date 2026-08-19) |
|---|---|---|---|
| A1 | `bash infra/scripts/env.sh --print` (default, reserved ports) | `AH_INSTANCE=default`, `WEB_PORT=3000`, `POSTGRES_PORT=3001`, `REDIS_PORT=3002`, `POSTGRES_DB=agent_hangar_default` | Matched exactly (see command output below). `pnpm setup && pnpm doctor` executed live under `AH_PORT_BASE=3910` instead (host 3001 conflict, see note above): doctor header `Agent Hangar doctor · instance=default · ports 3910/3911/3912 · db agent_hangar_default`, all 8 required rows ✓, exit 0. |
| A2 | `pnpm dev` (checkout A) | prints `http://localhost:3000`, web + worker start | `run.sh --print-only` under the live port base printed `Agent Hangar · instance=default · http://localhost:3910` and the `concurrently … web … worker …` command line; not started in the foreground (see note above). |
| A3 | `AH_INSTANCE=feat-x AH_PORT_BASE=3100 pnpm setup && … pnpm doctor` (worktree B, reserved ports) | header `instance=feat-x · ports 3100/3101/3102 · db agent_hangar_feat_x`, all required ✓ | `env.sh --print` for `AH_PORT_BASE=3100` matched exactly. Live run used `AH_PORT_BASE=3920`: doctor header `Agent Hangar doctor · instance=feat-x · ports 3920/3921/3922 · db agent_hangar_feat_x`, all 8 required rows ✓ (including a real `prisma migrate deploy` applying `0001_init`), exit 0. |
| A4 | `AH_INSTANCE=feat-x AH_PORT_BASE=3100 pnpm dev` (worktree B) | prints `http://localhost:3100` | `run.sh --print-only` printed `Agent Hangar · instance=feat-x · http://localhost:3920`. |
| A5 | `docker ps --format 'table {{.Names}}\t{{.Ports}}'` | both instances' postgres/redis containers listed side by side, no collision | `agent-hangar-default-postgres-1 127.0.0.1:3911->5432/tcp`, `agent-hangar-default-redis-1 127.0.0.1:3912->6379/tcp`, `agent-hangar-feat-x-postgres-1 127.0.0.1:3921->5432/tcp`, `agent-hangar-feat-x-redis-1 127.0.0.1:3922->6379/tcp` — all four running simultaneously. `docker volume ls` showed `agent-hangar-default_pgdata`, `agent-hangar-default_redisdata`, `agent-hangar-feat-x_pgdata`, `agent-hangar-feat-x_redisdata`. `ws.sh list` for `feat-x` printed the header row (`NAMES STATUS kind chatjobRun`) with zero data rows — no workspace containers exist yet, as expected. |
| A6 | `AH_INSTANCE=feat-x AH_PORT_BASE=3100 bash infra/scripts/archive.sh` (worktree B) | `agent-hangar-feat-x` compose resources removed, `No workspace containers for instance feat-x`, `.env.local` of worktree B removed | Ran under `AH_PORT_BASE=3920`: compose `down -v` removed both containers, the network and both volumes; printed `No workspace containers for instance feat-x`; removed the feat-x env file. Exit 0. |
| A7 | `docker ps --format '{{.Names}}' \| grep agent-hangar` | only `agent-hangar-default-*` remain | Confirmed: only `agent-hangar-default-postgres-1`/`-redis-1` remained. Then `bash infra/scripts/archive.sh` (default) was run too, to leave the shared host exactly as found: compose resources, network and volumes removed, `.env.local` removed, and a final `docker ps -a \| grep agent-hangar` / `docker volume ls \| grep agent-hangar` showed nothing left. |

Raw `env.sh --print` output captured for A1/A3 (the reserved ports, unmodified derivation):

```
$ bash infra/scripts/env.sh --print
export AH_INSTANCE="default"
export AH_PORT_BASE="3000"
export WEB_PORT="3000"
export POSTGRES_PORT="3001"
export REDIS_PORT="3002"
export POSTGRES_DB="agent_hangar_default"
export COMPOSE_PROJECT_NAME="agent-hangar-default"

$ AH_INSTANCE=feat-x AH_PORT_BASE=3100 bash infra/scripts/env.sh --print
export AH_INSTANCE="feat-x"
export AH_PORT_BASE="3100"
export WEB_PORT="3100"
export POSTGRES_PORT="3101"
export REDIS_PORT="3102"
export POSTGRES_DB="agent_hangar_feat_x"
export COMPOSE_PROJECT_NAME="agent-hangar-feat-x"
```

## Appendix B — README section draft "Working with Conductor" (for W3-B to paste)

_Target: README §7 "Working with Conductor". Final prose, ready to paste verbatim._

> ### Working with Conductor
>
> [Conductor](https://conductor.build) runs each chat, PR review or experiment in its own git
> worktree with its own dev server, so you can work on several things at once without one
> `pnpm dev` stepping on another.
>
> Open this repository in Conductor, click **New workspace**, and give it a name. Conductor
> creates a worktree and runs `setup.sh` automatically: it derives the workspace's instance name
> from the workspace name and its port block from `CONDUCTOR_PORT`, installs dependencies, writes
> `.env.local`, creates the shared master key on first use, starts Postgres and Redis for this
> workspace, applies migrations, and builds the workspace image if it is missing. Click **Run**
> and open the URL it prints.
>
> What is isolated per workspace, and what is shared:
>
> | Resource | Isolation |
> |---|---|
> | Postgres database | one database per instance (`agent_hangar_<instance>`) |
> | Redis | separate container and volume per instance |
> | Ports | a block of three, derived from `CONDUCTOR_PORT` (web, Postgres, Redis) |
> | Workspace containers | labelled `ah.instance=<instance>`; teardown only ever touches its own |
> | `.env.local` | one per worktree, regenerated by setup — nothing to copy between workspaces |
> | Master key | shared (`~/.agent-hangar/master.key`) — secrets are re-entered per database anyway |
>
> You do not need Conductor to run two instances side by side: from two terminals,
>
> ```bash
> pnpm setup && pnpm dev                                    # first checkout, default ports
> AH_INSTANCE=feat-x AH_PORT_BASE=3100 pnpm setup && \
>   AH_INSTANCE=feat-x AH_PORT_BASE=3100 pnpm dev            # second checkout, its own port block
> ```
>
> `pnpm doctor` always prints the instance it is diagnosing in its header line, so it is easy to
> tell which workspace you are looking at. Conductor's **Archive** button runs `archive.sh`: it
> tears down that instance's compose resources (`docker compose down -v`) and reaps any
> `ah-ws-<instance>-*` workspace containers, leaving every other workspace untouched.

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)
- 1I.1 ✅ 2026-08-19 — run.sh single entry point, idempotent setup.sh with --force/--rebuild-image/--skip-doctor/--skip-install, tuned compose healthchecks, final root scripts block, PATH-shimmed tests at 100% coverage.
- 1I.2 ✅ 2026-08-19 — archive.sh (compose down -v + label-scoped reap), ws.sh list/reap, db-prune.sh with --days/--dry-run, all scoped strictly by the ah.instance label.
- 1I.3 ✅ 2026-08-19 — doctor.sh 10-row diagnostic table (table + --json) backed by secrets-status.ts and openai-check.ts node helpers; the reachability tests bind their listeners on the ports env.sh derives from AH_PORT_BASE, which ignores POSTGRES_PORT/REDIS_PORT in the environment so no instance can address another instance's database; 100% coverage on infra/scripts/lib/** and testing/**.
- 1I.4 ✅ 2026-08-19 — rotate-key.sh + lib/rotate-key.ts: two-phase abort-safe rotation (reveal under the old key, write under the new one, compensate on a partial write), atomic key-file swap with a timestamped 0600 backup, --resume for an interrupted rotation.
- 1I.5 ✅ 2026-08-19 — .conductor/settings.toml committed and proven by conductor.test.ts; two-instance checklist executed live against real Docker/Postgres/Redis (default + feat-x simultaneously, verified isolated, torn down cleanly); README "Working with Conductor" drafted in Appendix B.
- 1I.6 ✅ 2026-08-19 — all gates green (lint, format, typecheck, 100/100/100/100 on infra/scripts/lib/** and testing/**, full repo test suite green except one pre-existing out-of-lane failure), hand-run code review and security review at zero findings, dashboards updated, PR opened.
