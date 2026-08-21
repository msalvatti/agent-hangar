<p align="center">
  <img src="https://img.shields.io/badge/agent-hangar-000000?style=for-the-badge&logo=docker&logoColor=2496ED" alt="Agent Hangar" />
</p>

<h1 align="center">Agent Hangar</h1>

<p align="center">
  <strong>AI agents that do real work on your repositories, each inside its own disposable Docker workspace.</strong><br />
  <sub>Next.js 16 · React 19 · TypeScript 6 · Node 24 · Prisma 7 · PostgreSQL 18 · Redis 8 · BullMQ 6 · Docker · OpenAI Responses API</sub>
</p>

<p align="center">
  <a href="https://github.com/bymaxone/agent-hangar/actions/workflows/ci.yml"><img src="https://github.com/bymaxone/agent-hangar/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript strict" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 24" /></a>
  <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=next.js&logoColor=white" alt="Next.js 16" /></a>
  <a href="https://www.prisma.io/"><img src="https://img.shields.io/badge/Prisma-7-2D3748?style=flat-square&logo=prisma&logoColor=white" alt="Prisma 7" /></a>
  <a href="https://redis.io/"><img src="https://img.shields.io/badge/Redis-8-DC382D?style=flat-square&logo=redis&logoColor=white" alt="Redis 8" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind 4" /></a>
  <img src="https://img.shields.io/badge/coverage-100%25%20required-success?style=flat-square" alt="100% coverage required" />
</p>

<p align="center">
  <a href="#-quick-start">🚀 Quick start</a> ·
  <a href="#-how-it-works">🧩 How it works</a> ·
  <a href="#-configuration">🔧 Configuration</a> ·
  <a href="#-security">🔒 Security</a> ·
  <a href="#-testing">🧪 Testing</a> ·
  <a href="#-known-gaps">🚧 Known gaps</a> ·
  <a href="docs/spec/README.md">📖 Specification</a>
</p>

![A finished chat turn in Agent Hangar: the prompt, the branch the agent prepared, its reasoning, a run_shell and a read_file call expanded to show their arguments, output and exit codes, the answer, and the notice that the work was pushed](.github/assets/readme/chat-transcript.png)

---

## ✨ What this is

Agent Hangar is a **local-first** web application where AI agents answer questions and perform coding tasks against your GitHub repositories. Every chat and every scheduled run gets **its own Docker container** — the agent clones the repo there, runs shell commands, reads and writes files, commits and pushes, and the container is destroyed when it is no longer needed.

Three pillars:

- **Chats.** Pick a repository and branch, send a prompt, watch the agent work live. Archive a chat and restore it later into a brand-new container with its full history.
- **Scheduled jobs.** A cron expression, a timezone, a prompt. Each trigger gets a _fresh_ workspace, records the run and its output, and leaves nothing behind.
- **Settings.** Your GitHub PAT and OpenAI key, encrypted at rest and never printed anywhere.

It runs entirely on your machine. The only external calls are to the OpenAI API and to GitHub.

A turn's work is kept off your default branch: the workspace clones the repository, checks out a dedicated `agent/<id>` branch, and commits and pushes there. Everything the agent does is persisted as it happens, so a reloaded transcript is read back from the database — every tool call with its arguments, its output and its exit code, the push notice and the cancellation notice. [Known gaps](#-known-gaps) is where the boundaries are written down, including the two things a reload does not restore.

---

## 🚀 Quick start

### Requirements

| Tool                                      | Version              | Check                                                    |
| ----------------------------------------- | -------------------- | -------------------------------------------------------- |
| **macOS**                                 | 13+                  | —                                                        |
| **Docker Desktop** (or OrbStack / Colima) | Engine API reachable | `docker info`                                            |
| **Node.js**                               | 24 LTS               | `node -v` — `.nvmrc` pins it, so `nvm use` is enough     |
| **Free ports**                            | 3000–3002            | `lsof -nP -iTCP:3000 -sTCP:LISTEN` — or move the block   |
| **pnpm**                                  | 11                   | `corepack enable && corepack prepare pnpm@11 --activate` |
| **Git**                                   | 2.40+                | `git --version`                                          |

Nothing else is installed globally. PostgreSQL and Redis run in Docker.

### Four commands

```bash
git clone https://github.com/bymaxone/agent-hangar.git && cd agent-hangar
corepack enable
pnpm setup     # installs, configures, boots infrastructure, migrates, builds the image, runs the doctor
pnpm dev       # web + worker with hot reload → http://127.0.0.1:3000
```

Then in the browser: **Settings** → paste your GitHub PAT and OpenAI API key → **New chat** → choose a repository → send a prompt.

![The New chat screen: four starting points, a repository and branch picker, and a prompt box that stays disabled until a repository is chosen; the sidebar footer reports Docker healthy](.github/assets/readme/new-chat.png)

Nothing above needs a flag, an argument or an edited file. What to expect while it runs:

- `corepack enable` prints nothing. The pinned pnpm — `pnpm@11.22.0`, from the manifest's `packageManager` field — is downloaded by Corepack on first use, with a one-line notice.
- `pnpm setup` takes a few minutes on a cold machine, nearly all of it the dependency install (about 1 100 packages) and, when this instance's workspace image is not on the host yet, the image build. It ends with the doctor's table and `Setup complete for instance "default"`. A second run takes seconds.
- `pnpm dev` prints one banner line, is serving in about a second, and stays in the foreground until Ctrl-C. Both servers bind `127.0.0.1` only, and every URL the scripts print names that address.

Docker must be running before `pnpm setup`: the script checks the socket at step 3 and stops with the exact `DOCKER_HOST` hint if it cannot reach the daemon.

**The instance's three ports have to be free, nothing checks them in advance, and which one is taken decides what breaks.**

- **3001 and 3002** — PostgreSQL and Redis — are published by compose. `pnpm setup` gets as far as step 5 and fails on the bind: `Bind for 127.0.0.1:3001 failed: port is already allocated`, leaving a half-created compose project behind. `pnpm infra:down` clears it.
- **3000** — the web server — is bound by `next dev`, which compose never publishes and the doctor never checks. `pnpm setup` finishes and the doctor reports every row green. `pnpm dev` is what fails, with `Error: listen EADDRINUSE: address already in use 127.0.0.1:3000`; Next does not fall back to another port, and the worker is stopped with it. Nothing is left behind.

The fix is the same either way — put the instance on a free block, ideally before the first run:

```bash
AH_INSTANCE=mine AH_PORT_BASE=3900 pnpm setup
AH_INSTANCE=mine AH_PORT_BASE=3900 pnpm dev    # → http://127.0.0.1:3900
```

`lsof -nP -iTCP:3000 -sTCP:LISTEN` names whoever holds a port. Several checkouts run side by side this way — see [Working with Conductor](#-working-with-conductor).

### Three names pnpm answers for itself

`pnpm <name>` normally runs the package script of that name, but pnpm ships commands of its own, and where the two collide the script does not always win. On the pinned pnpm 11.22.0:

| You type             | What actually runs                                                                                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm setup`         | **This project's script.** pnpm has a `setup` command of its own, but a package script of that name takes precedence; pnpm's own is reached only from a directory whose `package.json` declares no `setup`.                                                                   |
| `pnpm setup --force` | **This project's script, without the flag.** pnpm parses its own options first and drops `--force` silently — no warning, and setup then leaves an existing `.env.local` in place while looking as if it rewrote it. Pass flags through `pnpm run`: `pnpm run setup --force`. |
| `pnpm setup --help`  | The script, with `--help` removed and the word `setup` appended as an argument, so it exits 2 printing its own usage line. Harmless, and not the pnpm help you asked for.                                                                                                     |
| `pnpm doctor`        | **pnpm's doctor**, which reports on your pnpm installation and exits 0 whatever state this project is in. No package script can override that name. Use `pnpm infra:doctor`, or `pnpm run doctor`.                                                                            |

Every other name in [Scripts](#-scripts) — `dev`, `build`, `start`, `test`, and each `infra:*`, `db:*` and `ws:*` — reaches this project's script unchanged.

### What `pnpm setup` actually does

Eight steps, seven of them numbered in its output. It is idempotent — a second run reports `already exists`, `master key present` and `workspace image current with this checkout`, changes nothing and exits 0. Nothing below overwrites an existing file unless you pass a flag.

| #   | Step                             | Detail                                                                                                                                                                                     |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `pnpm install --frozen-lockfile` | never mutates the lockfile (`--skip-install` skips it)                                                                                                                                     |
| 2   | Write `.env.local`               | derives every port, database name, compose project and container prefix from `AH_INSTANCE` + `AH_PORT_BASE`; an existing file is preserved unless `--force`                                |
| 3   | Resolve the Docker socket        | `DOCKER_HOST`, else `~/.docker/run/docker.sock`, else `/var/run/docker.sock`; fails fast if the daemon does not answer                                                                     |
| 4   | Create the master key            | `~/.agent-hangar/master.key`, 32 random bytes as hex, `chmod 600`, only if missing; refuses to continue if the mode is looser than `0600`                                                  |
| 5   | Boot infrastructure              | `docker compose up -d --wait` — PostgreSQL 18 and Redis 8, with healthchecks                                                                                                               |
| 6   | Generate and migrate             | `prisma generate` then `prisma migrate deploy`                                                                                                                                             |
| 7   | Build the workspace image        | `pnpm infra:image` when the image is missing **or was built from other sources**, or always with `--rebuild-image`; never a bare `docker build`, because the build context is staged first |
| —   | Doctor                           | runs the diagnostics below and exits with their status (`--skip-doctor` skips it)                                                                                                          |

**Flags only reach the script through `pnpm run`**: `pnpm run setup --force`, `pnpm run setup --rebuild-image`, `pnpm run setup --skip-doctor`. Written as `pnpm setup --force` the flag is swallowed before the script sees it, and setup runs as if you had passed nothing — see the table above. Two of the scripts print the swallowed spelling in their own advice: when `.env.local` exists but is incomplete, and when your shell and that file name different instances, both say `run "pnpm setup --force"`. Following that literally fails the same way a second time. Use `pnpm run setup --force`.

An incomplete `.env.local` is refused rather than half-used: setup stops with exit 4 and lists every variable the file does not define, because a file that names an instance but not its ports would put compose on one instance and the migrations on another.

### When something is off, run the doctor

```bash
pnpm infra:doctor
```

> Run it as `pnpm infra:doctor` or `pnpm run doctor`, never bare `pnpm doctor`: pnpm's own `doctor` wins that name and reports on your pnpm installation instead, exiting 0 whatever state this project's environment is in. `infra:doctor` is the short form pnpm does not claim — see [Three names pnpm answers for itself](#three-names-pnpm-answers-for-itself).

It prints one row per check — Node, pnpm, the Docker socket it found, PostgreSQL, Redis, migrations, the workspace image, the master key and its mode, which credentials are configured, and whether your OpenAI key can reach the configured model. **Every ✗ comes with the exact command that fixes it**, and the exit code is non-zero only when a required row failed. `pnpm infra:doctor --json` prints the same rows as JSON.

Doctor, `ws:list`, `ws:reap`, `db:prune`, `archive`, `rotate-key`, `dev` and `start` all resolve the instance from **this checkout's `.env.local`** — the file `pnpm setup` wrote — not from the shell; `setup` is the one exception, because it is the command that establishes that file in the first place. If your shell explicitly sets `AH_INSTANCE` / `AH_PORT_BASE` (or Conductor's `CONDUCTOR_WORKSPACE_NAME` / `CONDUCTOR_PORT`) and it disagrees with what this checkout's file already records, the command refuses rather than guessing which one you meant: it prints both candidates and exits non-zero. To legitimately act on a different instance from this shell, point `AH_ENV_FILE` at that instance's own `.env.local` — exporting a different `AH_INSTANCE` here is read as a mistake, not an override.

```text
Agent Hangar doctor · instance=default · ports 3000/3001/3002 · db agent_hangar_default
Check            St  Detail                                   Fix
Node             ✓ v24.18.0
pnpm             ✓ 11.22.0
Docker socket    ✓ unix:///Users/you/.docker/run/docker.sock
Postgres         ✓ 127.0.0.1:3001 · agent_hangar_default answered SELECT 1
Redis            ✓ 127.0.0.1:3002 · answered PING with PONG
Migrations       ✓ up to date
Workspace image  ✓ agent-hangar/workspace:default
Master key       ✓ /Users/you/.agent-hangar/master.key (mode 600)
Secrets          ⚠ GitHub PAT: unset · OpenAI key: unset   Open http://127.0.0.1:3000/settings and save the missing key
OpenAI model     – no OpenAI key
All required checks passed
```

Every checkout is an **instance**: `AH_INSTANCE` and `AH_PORT_BASE` derive the ports, the database, the compose project, the container prefix and the workspace image tag, so several clones run side by side. See [Working with Conductor](#-working-with-conductor).

---

## 🧩 How it works

```mermaid
flowchart LR
  subgraph Browser
    UI[Next.js UI<br/>Chats · Scheduled · Settings]
  end

  subgraph Host["macOS host (pnpm workspaces)"]
    WEB[apps/web<br/>Next.js 16 App Router<br/>Route handlers · SSE]
    WORKER[apps/worker<br/>BullMQ consumers<br/>Scheduler · Workspace GC]
    CORE[[packages/core<br/>WorkspaceRunner · AgentModelProvider<br/>Secrets · Redaction · Persistence]]
  end

  subgraph Docker["Docker Desktop"]
    PG[(Postgres 18)]
    REDIS[(Redis 8)]
    subgraph WS["Workspace containers (one per chat / job run)"]
      RT[packages/agent-runtime<br/>agent loop · tools]
    end
  end

  subgraph External["External APIs (the only ones)"]
    OPENAI[OpenAI API<br/>Responses API]
    GH[GitHub API / git over HTTPS]
  end

  UI -- REST + SSE --> WEB
  WEB -- Prisma --> PG
  WEB -- enqueue / subscribe --> REDIS
  WORKER -- Prisma --> PG
  WORKER -- consume / publish --> REDIS
  WORKER -- "dockerode: create · exec · destroy" --> WS
  WEB -.-> CORE
  WORKER -.-> CORE
  RT -- tool calls + streaming --> OPENAI
  RT -- "clone / push (PAT via env)" --> GH
```

| Component                    | Responsibility                                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`apps/web`**               | UI and HTTP API. Writes user intent to PostgreSQL, enqueues work in BullMQ, streams results to the browser over SSE by subscribing to Redis. **Never talks to Docker.**                                                                                                                            |
| **`apps/worker`**            | The only process that touches Docker. Consumes the `chat-turns`, `scheduled-jobs` and `workspace-gc` queues, owns workspace lifecycle, persists every event and tool call, publishes progress to Redis, registers BullMQ Job Schedulers from the database, and reaps idle and orphaned workspaces. |
| **`packages/core`**          | Pure domain, no framework imports: the `WorkspaceRunner` and `AgentModelProvider` interfaces and their real implementations, AES-256-GCM secrets, redaction, cron validation, restore-context building, the agent protocol, and the Prisma repositories.                                           |
| **`packages/agent-runtime`** | Bundled _into_ the workspace image. Reads a turn request from stdin as NDJSON, runs the OpenAI tool loop, executes tools inside the container, emits events on stdout. Knows nothing about PostgreSQL or Redis.                                                                                    |
| **`infra/`**                 | `docker-compose.yml` (PostgreSQL, Redis), the workspace `Dockerfile` and its askpass helper, and the shell scripts behind every `pnpm` command.                                                                                                                                                    |

### A turn, end to end

1. You send a prompt. `apps/web` validates it, persists the message, claims a turn and enqueues it on `chat-turns`.
2. `apps/worker` picks it up, ensures a workspace exists (creating a container if there is no live one), decrypts your credentials **in memory only**, and injects them as container environment.
3. Inside the container, `agent-runtime` clones or fetches the checkout, checks out the work branch (`agent/<chat id prefix>`) and starts the OpenAI loop, executing tools as the model requests them.
4. Every event is redacted, persisted, and appended to a Redis stream (`events:turn:<id>`, capped at ~5000 entries, one hour TTL).
5. The browser is subscribed over SSE and renders the output as it arrives — with replay via `Last-Event-ID` if the connection drops.

The agent has four tools: `run_shell`, `read_file`, `write_file` and `list_dir`. A chat turn is bounded at 40 steps, 20 minutes of wall clock, 5 minutes per tool call and 32 KiB of captured output per call; a scheduled run gets 30 minutes instead of 20. Every path argument is resolved against `/workspace`, symlinks included, and anything that escapes is refused.

### Isolated workspaces

Isolation is the whole point: an agent that can run arbitrary shell commands should not share a filesystem with another agent, nor with your machine. Each workspace container runs as a non-root user (`agent`, uid 1001) with **all capabilities dropped**, `no-new-privileges`, a tmpfs `/tmp`, 2 CPUs, 2 GiB of memory, a 512-process limit and **no Docker socket mounted**. Containers are labelled with the instance, so garbage collection in one checkout can never touch another's.

A workspace lives as long as its chat is active. The collector runs every five minutes: workspaces idle for longer than `WORKSPACE_IDLE_TTL_MIN` (30 minutes by default) are destroyed, containers with no matching database row are destroyed, and rows whose container has vanished are marked accordingly. Archiving a chat snapshots the git state, records the work branch and last pushed commit, and destroys the container; the next message rebuilds a fresh container and replays a bounded history window (60 messages or 48 000 characters, whichever comes first) so the agent picks up where it left off.

### Scheduled jobs

![The run drawer of a scheduled job: when the run started, its transcript beside a raw-output tab, and the run_shell call it made expanded to show its arguments, its output and its exit code](.github/assets/readme/scheduled-run.png)

A job is a cron expression, an IANA timezone and a prompt, stored in PostgreSQL and mirrored into a BullMQ Job Scheduler. Each trigger provisions a **fresh** workspace, runs one turn, records the run with its output and tool calls, and tears the container down in a `finally` block. The worker reconciles schedulers against the database at startup, so a job added or removed while it was down is picked up on boot. `POST /api/jobs/:id/run` triggers the same processor manually.

### Encrypted settings

![The Settings page: each stored credential shown only as its last four characters with Replace and Remove beside it, the configured model, and a read-only summary of the instance's Postgres, Redis, Docker and workspace image](.github/assets/readme/settings.png)

The GitHub PAT and the OpenAI key are entered on the Settings page and sealed with AES-256-GCM under a master key that lives outside the repository. PostgreSQL stores the ciphertext, the IV, the auth tag, the key version and the last four characters — never the key, never the plaintext. The worker decrypts them only while starting a container. See [Security](#-security).

Further reading: [system overview](docs/spec/01-overview.md) · [data model](docs/spec/02-data-model.md) · [interface contracts](docs/spec/03-interfaces.md) · [sequence flows](docs/spec/04-flows.md) · [UI design](docs/spec/10-ui-design.md).

---

## 🔧 Configuration

Everything is environment-driven and validated with Zod at boot. `.env.example` documents the keys; `pnpm setup` writes a working `.env.local`.

**The two values you normally touch are the first two** — the block under them is the instance's identity and is derived from those two alone, which is what lets several checkouts run side by side. `infra/scripts/env.sh` computes the identity block and ignores a same-named variable exported in your shell, so nothing can name one instance while addressing another's database.

| Variable                  | Default                                                        | Purpose                                                                                                                 |
| ------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `AH_INSTANCE`             | `default`                                                      | Instance name, slugified to `[a-z0-9-]` (max 30). Suffixes every derived resource.                                      |
| `AH_PORT_BASE`            | `3000`                                                         | Base of a 10-port block.                                                                                                |
| `WEB_PORT`                | `AH_PORT_BASE + 0`                                             | Next.js                                                                                                                 |
| `POSTGRES_PORT`           | `AH_PORT_BASE + 1`                                             | host port → container 5432                                                                                              |
| `REDIS_PORT`              | `AH_PORT_BASE + 2`                                             | host port → container 6379                                                                                              |
| `POSTGRES_DB`             | `agent_hangar_<instance>`                                      | database name                                                                                                           |
| `DATABASE_URL`            | `postgresql://ah:ah@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}` | Prisma                                                                                                                  |
| `REDIS_URL`               | `redis://127.0.0.1:${REDIS_PORT}`                              | BullMQ + Streams                                                                                                        |
| `COMPOSE_PROJECT_NAME`    | `agent-hangar-<instance>`                                      | isolates compose containers, volumes and networks                                                                       |
| `MASTER_KEY_PATH`         | `~/.agent-hangar/master.key`                                   | secrets master key; shared across instances on purpose                                                                  |
| `WORKSPACE_IMAGE`         | `agent-hangar/workspace:<instance>`                            | image used by the runner; the tag carries the instance, so a rebuild in one checkout cannot retarget another's          |
| `WORKSPACE_NAME_PREFIX`   | `ah-ws-<instance>-`                                            | container names and labels — collection only touches its own instance                                                   |
| `WORKSPACE_IDLE_TTL_MIN`  | `30`                                                           | idle workspace reaping, in minutes                                                                                      |
| `WORKER_TURN_CONCURRENCY` | `2`                                                            | parallel chat turns (max 32)                                                                                            |
| `OPENAI_MODEL`            | `gpt-5.6-sol`                                                  | model id sent to OpenAI                                                                                                 |
| `OPENAI_BASE_URL`         | unset                                                          | optional override                                                                                                       |
| `AGENT_MODEL_PROVIDER`    | `openai`                                                       | `openai` or `fake` (demos and tests without a key)                                                                      |
| `ALLOWED_REPO_HOSTS`      | `github.com`                                                   | comma-separated origin allow-list for repository URLs (`[http://\|https://]host[:port]`); the whole of the forge policy |
| `GITHUB_API_BASE_URL`     | `https://api.github.com`                                       | REST base URL used by the repository picker                                                                             |
| `DOCKER_HOST`             | unset                                                          | optional; the runner falls back to `~/.docker/run/docker.sock`, then `/var/run/docker.sock`                             |
| `LOG_LEVEL`               | `info`                                                         | pino level: `fatal`…`trace`, or `silent`                                                                                |
| `NEXT_PUBLIC_API_MOCK`    | `0`                                                            | serve the UI against mock handlers instead of the API (development only)                                                |

> **Your API credentials are not in this table, and that is deliberate.** The GitHub PAT and the OpenAI key are entered in the Settings page and stored encrypted in PostgreSQL — never as environment variables of the web or worker process. See [Security](#-security).

`127.0.0.1` appears instead of `localhost` throughout because macOS resolves `localhost` to `::1` first, while the compose port forward is IPv4-only.

---

## 📜 Scripts

Scripts come in two styles. Setup, run and lifecycle scripts (`setup`, `dev`, `start`, `infra:*`, `db:migrate`/`db:studio`, `ws:*`, `archive`, `rotate-key`) are thin wrappers over `infra/scripts/*.sh`, so they resolve the instance the same way whether you run them by hand or Conductor runs them for you. Quality and test scripts (`lint`, `format`, `typecheck`, `test`, `test:e2e`, `test:mutation`) reach ESLint, Prettier, the TypeScript compiler, Vitest and Playwright with no instance to resolve — `lint` and `format` invoke the tool directly, while `typecheck`, `test` and `test:e2e` go through a small shell wrapper that sequences it. Scripts marked 🐳 need the Docker daemon running; the ones that also need this instance's compose stack up say so explicitly.

| Script                                               | Does                                                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm setup` 🐳                                      | First-run bootstrap (idempotent) — see [Quick start](#-quick-start)                                                                            |
| `pnpm dev` 🐳                                        | Web (`next dev -H 127.0.0.1`) + worker (`tsx watch`), concurrently, against this instance's stack                                              |
| `pnpm build`                                         | Build every workspace — no Docker daemon, no compose stack                                                                                     |
| `pnpm start` 🐳                                      | Run the built output of both apps against this instance's stack — `pnpm build` first, or the worker exits on `Cannot find module dist/main.js` |
| `pnpm infra:doctor`                                  | Diagnose every dependency and print the fix for each failure (`--json` available); bare `pnpm doctor` reaches pnpm's own command instead       |
| `pnpm infra:up` · `infra:down` · `infra:reset` 🐳    | Compose lifecycle (`reset` drops volumes)                                                                                                      |
| `pnpm infra:image` 🐳                                | Stage the agent-runtime bundle, rebuild this instance's workspace image, stamp it with a digest of the tree, and verify the tag carries it     |
| `pnpm db:generate`                                   | Prisma client — needed once in a fresh worktree before typecheck or tests; no Docker                                                           |
| `pnpm db:migrate` · `db:studio` · `db:prune` 🐳      | Apply migrations · open Prisma Studio · trim old rows                                                                                          |
| `pnpm ws:list` · `ws:reap` 🐳                        | List / destroy the workspace containers of this instance                                                                                       |
| `pnpm archive` 🐳                                    | Tear this instance's compose stack and workspaces down (Conductor's archive hook)                                                              |
| `pnpm run rotate-key` 🐳                             | Re-encrypt every stored secret under a new master key (`--yes` to commit to it)                                                                |
| `pnpm lint` · `lint:fix` · `format` · `format:check` | ESLint and Prettier — no Docker                                                                                                                |
| `pnpm typecheck`                                     | Builds every project reference and fixes up the emitted declaration specifiers — no Docker                                                     |
| `pnpm test`                                          | Unit suites of every workspace — no Docker; see [Testing](#-testing)                                                                           |
| `pnpm test:integration` 🐳                           | `@db`/`@redis`/`@docker` suites against this instance's compose stack; see [Testing](#-testing)                                                |
| `pnpm test:e2e`                                      | Brings a `test` instance up, then runs Playwright over eight spec files; see [Testing](#-testing)                                              |
| `pnpm test:mutation`                                 | Reserved for Stryker; no package implements it yet, so it exits 0 doing nothing. See [Testing](#-testing)                                      |
| `pnpm smoke:openai` 🐳                               | One real turn against the real model, using the keys saved in Settings; see [Testing](#-testing)                                               |
| `prepare`                                            | Lifecycle hook `pnpm install` runs automatically (`husky`) — sets up the Git hooks; never run by hand                                          |

---

## 🔀 Working with Conductor

Several checkouts of this repository can run **at the same time** without colliding on ports, databases, Redis keyspaces or container names. [`.conductor/settings.toml`](.conductor/settings.toml) points Conductor at the same three scripts you would run by hand:

```toml
[scripts]
setup = "./infra/scripts/setup.sh"
run = "./infra/scripts/run.sh"
archive = "./infra/scripts/archive.sh"
run_mode = "concurrent"
```

`infra/scripts/env.sh` resolves the instance in this order: an explicit `AH_INSTANCE` / `AH_PORT_BASE`, then Conductor's `CONDUCTOR_WORKSPACE_NAME` / `CONDUCTOR_PORT`, then `default` / `3000`. Everything else is derived:

| Resource             | Isolation key                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------- |
| PostgreSQL database  | `agent_hangar_<instance>`, in that instance's own compose project and volume                  |
| Redis                | separate container and volume per compose project                                             |
| Ports                | `AH_PORT_BASE` + 0 / + 1 / + 2                                                                |
| Workspace containers | name prefix `ah-ws-<instance>-` and label `ah.instance`; collection filters by label          |
| Workspace image      | tag `agent-hangar/workspace:<instance>`, stamped with a digest of the tree it was built from  |
| `.env.local`         | per worktree, gitignored, regenerated by `setup`                                              |
| Master key           | shared (`~/.agent-hangar/master.key`) — same user, and each database holds its own ciphertext |

The same mechanism works without Conductor:

```bash
AH_INSTANCE=feat-x AH_PORT_BASE=3100 pnpm setup
AH_INSTANCE=feat-x AH_PORT_BASE=3100 pnpm dev    # → http://127.0.0.1:3100
```

Two instances side by side report different ports and different databases, which is exactly what the doctor's header line shows:

```text
Agent Hangar doctor · instance=default · ports 3000/3001/3002 · db agent_hangar_default
Agent Hangar doctor · instance=feat-x  · ports 3100/3101/3102 · db agent_hangar_feat_x
```

(`env.sh` turns every hyphen in `AH_INSTANCE` into an underscore for `POSTGRES_DB`, since Postgres
database names cannot contain one — `feat-x` becomes `agent_hangar_feat_x`, not `agent_hangar_feat-x`.)

---

## 🔒 Security

### How your credentials are handled

```mermaid
flowchart LR
  U[You paste the PAT] --> UI[Settings page]
  UI -->|"PUT /api/settings/:key"| WEB[apps/web]
  WEB --> S[SecretsService]
  S -->|reads 0600 key file| K[~/.agent-hangar/master.key]
  S -->|AES-256-GCM| PG[(Postgres: ciphertext + iv + authTag + keyVersion + last4)]
  W[apps/worker] -->|reveal, in memory only| S
  W -->|container env at start| C[Workspace container]
  C -->|"every event redacted"| L[Logs · database · UI]
```

| Boundary                 | Control                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Repository**           | `.gitignore` covers `.env*`, `master.key` and `*.pem`; CI runs gitleaks on the working tree, on the commits of every pull request, and over the full history on `main`                                                                                                                                        |
| **UI**                   | inputs are `type=password`, never pre-filled; `GET /api/settings` returns only `{ set, last4, updatedAt }` per key                                                                                                                                                                                            |
| **Database**             | ciphertext, IV, auth tag, key version and the last four characters — the key itself is never stored, and each envelope is bound to its own row by GCM additional data, so a swapped row fails to authenticate                                                                                                 |
| **Master key**           | outside the repository; the loader creates it with `O_EXCL`, opens it with `O_NOFOLLOW`, and refuses a symlink, a non-regular file or any group/other permission bit                                                                                                                                          |
| **Worker memory**        | plaintext exists only inside the call that provisions a container; it is never stored on an object and never logged                                                                                                                                                                                           |
| **Container**            | injected as environment at container start, never baked into an image layer                                                                                                                                                                                                                                   |
| **Shell tool**           | child processes get a **scrubbed** environment — `GITHUB_TOKEN` and `OPENAI_API_KEY` are removed, and git authenticates through a root-owned `GIT_ASKPASS` helper that answers only the one origin this workspace was created for, over `https`, reading it from a root-owned file the workspace cannot write |
| **Logs and persistence** | redaction runs inside the container on every event, again in the worker by exact value and by shape, again on every database write, and once more in the logger — by field name, by value and over the serialised line                                                                                        |

### What is protected, and what is not

**Protected:** credentials at rest; agent output that happens to echo a secret; the host filesystem, which no workspace can reach; other workspaces, which never share a filesystem or a kernel namespace.

**Not protected, by design or by acknowledged gap, because this is a single-user application on your own machine:**

- **A task can read the forge token.** The shell tool removes `GITHUB_TOKEN` from the child environment and mediates git authentication through the askpass helper, which stops the token appearing in a remote URL or in git's output. It does not stop a command that deliberately reads the token file the helper uses — the path is in `AH_GIT_TOKEN_FILE`. Closing this needs a different process model inside the container (a setuid helper or a credential daemon) plus an egress policy, so the honest statement is: **give the agent a token scoped to what you are willing to lose.**
- `docker inspect` on your own machine shows the environment of a running workspace. Replacing this with secret-manager injection is the first thing that changes in a cloud deployment — see [the deployment discussion](#-deployment-discussion).
- There is no authentication. Both servers bind to `127.0.0.1`, and mutating routes enforce same-origin, but anyone with an account on your machine can reach the app. The same-origin check compares `Origin` against `Host`, which a DNS-rebinding attack defeats; a host allow-list is the fix and is a deployment decision rather than a code one.
- Traffic is plain HTTP over loopback, and the browser devtools show the `PUT /api/settings/:key` body once, when you save a credential.
- A password inside a connection URL is redacted **by shape** — `scheme://user:password@host` — which covers the compose password without anything having to register it. The rule deliberately stops at whitespace and at a bare `"`, so a password containing either is left readable rather than letting one match run across a log line and delete the fields between. Registering the configured value at boot is the complete answer and is not done.

The agent runs with real credentials and can push to your repositories. Treat the prompts you give it with the same care you would give a shell.

### Rotating the master key

```bash
pnpm run rotate-key          # prints the plan and exits without touching anything
pnpm run rotate-key --yes    # generates a new key, re-encrypts every secret, swaps the files
```

The rotation writes its phase to a state file before each step and keeps a timestamped backup of the old key, so `--resume` can finish an interrupted run — including one that left rows split between two keys, which AES-GCM makes unambiguous to sort out. It refuses to start while the app is listening on this instance's web port, or while another instance sharing the same key file exists, and `pnpm dev` refuses to start while a live rotation holds the lock.

---

## 🧪 Testing

| Layer           | Command                 | Needs                                                                  | Budget  | What it covers                                                                                                                                |
| --------------- | ----------------------- | ---------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**        | `pnpm test`             | nothing but `pnpm db:generate` once                                    | ≈ 2 min | every module, with 100 % coverage thresholds enforced per package                                                                             |
| **Integration** | `pnpm test:integration` | a running stack, a test instance, and two opt-in variables (see below) | < 5 min | repositories against real PostgreSQL, queues against real Redis, the runner against a real Docker daemon                                      |
| **End to end**  | `pnpm test:e2e`         | Chromium; `real` mode also needs the full stack                        | < 5 min | eight spec files over the interface: pages, chat creation and run, cancellation, archive and restore, a scheduled run, and the settings paths |
| **Mutation**    | `pnpm test:mutation`    | —                                                                      | —       | planned, not implemented: no package defines the script, so the command exits 0 doing nothing                                                 |
| **Smoke**       | `pnpm smoke:openai`     | the stack up, and both credentials saved in Settings                   | ≈ 20 s  | one real turn against the real model and a real repository — the only check that exercises the live provider                                  |

### Running the real-model smoke

Every automated check runs against a scripted model provider — deterministic, free, and needing no
credentials, which is what continuous integration requires. The cost is that **nothing automated
exercises the real provider**, and that path has failed silently before: the provider was once not
wired into the binary the container runs, so every real turn failed at composition while every test
stayed green.

```bash
pnpm smoke:openai
```

It drives the running instance through the same HTTP API a browser uses, so the credentials come
from what you saved in **Settings** and are decrypted by the product's own path — never from an
environment variable, a file or an argument. With a key missing it says so and stops. One turn runs
against a real repository, reading and writing a file, and the script prints what it observed:
the model, the steps, each tool call with its exit code, the duration and the token counts. It
destroys the workspace it created, including when it fails.

### Running the end-to-end suite

`pnpm test:e2e` has two modes, chosen by `E2E_MODE`, and it addresses its own `test` instance rather than the stack you develop against.

- **`mock`** (the default in continuous integration) runs a production build of the web app against the in-browser mock API. Every selector, page object and interface step is exercised with no database, Redis, worker or Docker behind it; the assertions that need the real stack skip and name their reason. Continuous integration runs this mode, and it is green.
- **`real`** runs the dev server and the worker against a live stack, with a local git server standing in for the forge and the `fake` model provider standing in for OpenAI, so no credential and no network call are involved.

A real run starts workspace containers, so it needs an image of its own instance — `agent-hangar/workspace:test`, or `agent-hangar/workspace:test-<port base>` when `E2E_PORT_BASE` has moved — built from the checkout under test: `WORKSPACE_IMAGE=agent-hangar/workspace:test pnpm infra:image`. The pre-step refuses to start if that image is missing, or if it was built from other sources, naming the command; a suite measured against a runtime that is in no tree reports a result for a combination that was never released together.

**A real-stack run passes all ten of its checks, three times consecutively with retries disabled.** The suite collects twenty tests and skips ten of them by design in this mode — they pin the selector contract the mock mode exercises — so ten is the whole of what a real stack is asked to prove: the smoke render, a chat created and run, the composer's send guard, a turn cancelled, an archive released and restored, a scheduled job run on demand, both credential refusals, and a credential redacted inside tool-call arguments.

That sentence used to say "measured twice", and twice was not enough to earn it. Run nineteen times against the commit before the repairs below, the suite failed twice. One failure was a scheduled-job delete the spec could not see finish: the confirmation is modal, so the page behind it carries `aria-hidden` and no role locator reaches into it, and the row the step asserted was gone counted zero whatever the delete did — a check that could not fail, hiding a request still in flight when the test ended and two defects underneath it, one of which resurrected a repeatable schedule for a job that no longer existed. The other was a single cancellation that took longer than the five seconds the product promises; it was seen once in those nineteen runs and has not recurred in the fifteen since, its cause is not established, and it is recorded rather than dressed up here as a fix.

### Running the integration suites

They truncate every table and flush Redis, so they refuse to run against anything that is not obviously a throwaway. The database name must contain `test` as a word, and the destruction has to be opted into explicitly:

```bash
AH_INSTANCE=test AH_PORT_BASE=3410 pnpm setup      # a stack named agent_hangar_test
eval "$(AH_INSTANCE=test AH_PORT_BASE=3410 bash infra/scripts/env.sh --print)"
AH_ALLOW_DESTRUCTIVE_TESTS=1 DOCKER_AVAILABLE=1 pnpm test:integration
```

Without `AH_ALLOW_DESTRUCTIVE_TESTS=1` every `@db` test fails with an explanation rather than erasing your development database. Without `DOCKER_AVAILABLE=1` the `@docker` suite is not collected and says so on stdout. In CI both are set, so the suites **fail loudly** rather than skipping: a green build can never mean "we quietly skipped the hard tests".

### Coverage policy

100 % of lines, branches, functions and statements on every path a package lists in `coverage.include` — enforced by the Vitest thresholds, never lowered. Composition roots that only wire real clients together are excluded and their logic tested through fakes instead (`apps/worker/src/main.ts`, `packages/agent-runtime/src/bin.ts`), and `apps/web/src/shared/ui/**` is generated shadcn code, excluded as vendor code. Every `it()` carries a comment naming the behaviour it proves.

**Mutation testing is planned and not part of the gate.** Stryker is a dependency and its scope and thresholds are settled — secrets, redaction, scheduling, workspace lifecycle, restore, the protocol codec and the runtime tools, breaking below a score of 80 — but no package implements `test:mutation` yet, so the root script is a no-op and no continuous-integration job runs it.

### Quality bar

Strict TypeScript with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`; **zero suppression comments** (`@ts-ignore`, `eslint-disable`, coverage ignores) anywhere in the codebase, enforced by a test rather than by review; documentation on every export; string-literal unions instead of enums; `dockerode` confined to a single folder so the runner can be swapped without touching anything else.

Details in [the testing strategy](docs/spec/06-testing.md).

---

## 🧯 Troubleshooting

| Symptom                                                           | Cause and fix                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm doctor` reports on pnpm, not on Agent Hangar                | pnpm's built-in `doctor` wins that name. Run `pnpm infra:doctor` (or `pnpm run doctor`).                                                                                                                                                                                                                                     |
| `pnpm setup --force` behaves as if you passed nothing             | pnpm parses its own options first and drops the flag. Run `pnpm run setup --force`.                                                                                                                                                                                                                                          |
| `pnpm setup` stops at step 5 on `port is already allocated`       | Something else holds 3001 or 3002, the two ports compose publishes. `pnpm infra:down` clears the half-created project, then start the instance on a free block: `AH_INSTANCE=mine AH_PORT_BASE=3900 pnpm run setup --force`.                                                                                                 |
| `pnpm dev` stops on `EADDRINUSE` after a clean `pnpm setup`       | Something else holds the web port. Compose does not publish it and the doctor does not check it, so only `pnpm dev` finds out. Move the instance to a free block as above.                                                                                                                                                   |
| `pnpm setup` exits 4 listing missing variables                    | `.env.local` exists but does not define every key — a key present only as a comment counts as missing. `pnpm run setup --force` regenerates it.                                                                                                                                                                              |
| `ERR_PNPM_UNSUPPORTED_ENGINE` during the install                  | You are not on Node 24, and the install stops rather than continuing on an untested major. The message names the range and the version you are on. `nvm use` or `fnm use` reads `.nvmrc`.                                                                                                                                    |
| `pnpm start` dies on `Cannot find module .../worker/dist/main.js` | `start` runs the built output. Run `pnpm build` first, or use `pnpm dev`.                                                                                                                                                                                                                                                    |
| The doctor reports the Docker socket was not found                | Docker Desktop does not create `/var/run/docker.sock` unless you opt in. The runner already tries `~/.docker/run/docker.sock`; if you use a different engine, set `DOCKER_HOST` explicitly.                                                                                                                                  |
| `WorkspaceImageMissing` when starting a chat                      | The workspace image was never built, or was pruned: `pnpm infra:image`.                                                                                                                                                                                                                                                      |
| `pnpm dev` refuses: the image "was not built from this checkout"  | The image exists but carries a different digest from the one this tree produces, so its containers would run an agent runtime you do not have — and every turn through them would succeed and report it. `pnpm infra:image` rebuilds it. An image built before the digest label existed carries none and reads the same way. |
| A command refuses because your image tag is not this instance's   | `.env.local` records a `WORKSPACE_IMAGE` other than `agent-hangar/workspace:<instance>` — typically a file written before the tag carried the instance. A tag two checkouts share is a tag either can rebuild. `pnpm run setup --force` regenerates the file, or edit that one line.                                         |
| The model id is rejected (401 or 404 from OpenAI)                 | 401 means the stored key is wrong — replace it in Settings. 404 means your key cannot reach that model; the doctor lists the models it can reach, so set `OPENAI_MODEL` to one of them.                                                                                                                                      |
| The environment pill in the sidebar is red                        | It reflects `GET /api/health`, which learns about Docker from a worker heartbeat written every 30 s and considered stale after 90 s. Click it: the dialog lists every probe with the command that repairs it, and a stopped worker is reported as the worker rather than as Docker — `pnpm dev` starts both halves.          |
| A URL with `localhost` does not connect                           | Both servers bind to `127.0.0.1` only, and macOS resolves `localhost` to `::1` first. Most clients retry over IPv4; one that does not sees a refused connection. Use `127.0.0.1`, which is what every generated connection string does.                                                                                      |
| Containers left behind after a crash                              | `pnpm ws:list` shows this instance's workspaces, `pnpm ws:reap` destroys them. The worker also reconciles orphans every five minutes.                                                                                                                                                                                        |
| Migrations out of date after pulling                              | `pnpm db:migrate`.                                                                                                                                                                                                                                                                                                           |
| `ERR_MODULE_NOT_FOUND` on `dist/index.js` in a fresh worktree     | A `tsx`-based process needs `--conditions=development` to resolve `@agent-hangar/core` from source. `pnpm dev` exports it; a new script has to ask for it too.                                                                                                                                                               |

---

## 🚧 Known gaps

Specific rather than reassuring. Everything below is confirmed against the code, and each item is tracked in [`docs/plan.md`](docs/plan.md), whose identifiers are quoted here.

### Limits of the running system

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | What it costs you                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A task's shell can read the forge token** (R1). Askpass mediation stops the token leaking into URLs and git output; it does not stop code that reads the token file deliberately.                                                                                                                                                                                                                                                                                           | Scope the PAT to what you are willing to lose, and do not point the agent at prompts you have not read.                                                                                    |
| **A cancellation the API accepted can still be recorded as `FAILED`** (R26). The check and the terminal write are two awaits apart, so a Stop that lands in that gap is answered `202` while the worker has already committed to a failure.                                                                                                                                                                                                                                   | The run is over either way; the transcript can disagree with what the Stop button told you.                                                                                                |
| **A terminal run status does not mean the worker has finished** (R27). Both processors persist the outcome inside the `try` and tear the workspace down in the `finally`, so anything that waits on status and then deletes races a teardown it cannot see.                                                                                                                                                                                                                   | Deleting a chat the instant its turn reports done can fail with an error.                                                                                                                  |
| **A deleted scheduled job can leave its scheduler behind** (R21). Deleting is not serialised against editing, so a concurrent edit can recreate the scheduler after the delete removed it.                                                                                                                                                                                                                                                                                    | The orphan fires on its cron until the next worker restart, failing each delivery with an explicit reason rather than corrupting anything. Restart the worker to clear it.                 |
| **Deleting a chat has the same shape** (R22): its live-turn check precedes the delete, so a concurrent message can claim a turn the cascade then removes.                                                                                                                                                                                                                                                                                                                     | Not corrupting — the chat and everything under it are gone either way — but the losing request fails with an error.                                                                        |
| **A transport error ends a turn** (R15). Three worker file headers describe a BullMQ retry that nothing configures: `attempts` is 0 and no default job options are declared.                                                                                                                                                                                                                                                                                                  | A turn lost to a transient Docker or Redis failure does not come back on its own. **Retry** on the failed turn re-runs it against the same prompt, and only for a chat's most recent turn. |
| **One worker process only** (R16). The claim that serialises the turn processor against the idle collector is process-local, because the persistence port offers no conditional update to build a real claim from.                                                                                                                                                                                                                                                            | Running a second worker against the same instance would race. Do not.                                                                                                                      |
| **The same-origin guard compares `Origin` against `Host`** (R9), which DNS rebinding defeats.                                                                                                                                                                                                                                                                                                                                                                                 | Real only if you expose the app beyond loopback, which nothing here does for you.                                                                                                          |
| **Another forge is configurable, but only a GitHub-compatible one is discoverable** (residual of R14). `ALLOWED_REPO_HOSTS` is honoured end to end — API, worker, agent runtime and credential helper — so a repository on another origin is accepted, cloned and, over `https`, authenticated. The repository and branch pickers still read the GitHub REST API at `GITHUB_API_BASE_URL`.                                                                                    | A forge that does not serve that API has no picker listing; point `GITHUB_API_BASE_URL` at a compatible endpoint, or supply the repository URL directly.                                   |
| **The image-presence check is optimistic before the first run** (R10). The runner port exposes `imageExists`, but the boot check and the health card report what the last `create` observed instead of asking.                                                                                                                                                                                                                                                                | The health card can show a green image before anything has ever been created. `pnpm infra:doctor` asks Docker directly.                                                                    |
| **Two things a reloaded transcript does not restore.** A failed `run_shell` call renders its output on stdout after a reload although some of it was written to stderr live, so the border marking those lines is lost (residual of R44 — the tools that cannot stream are restored exactly, `run_shell` interleaves both streams into one stored field and no rule can split it back apart); and the `Prepared agent/<branch> at <sha>` notice is live-only by design (R48). | Tool calls, their arguments, their output, their exit codes, the push notice and the cancellation notice all survive. These two do not.                                                    |
| **A `JobRun` has no message channel** (R46), so a push or preparation notice inside a scheduled run cannot be persisted the way a chat's is. A chat now rebuilds every failed turn's failure row, and only the newest one offers **Retry**, because that is the only turn the API will re-run.                                                                                                                                                                                | A scheduled run's drawer shows its transcript and its raw output, not those notices.                                                                                                       |
| **Completed repeatable jobs are never trimmed** (R2). At one job every five minutes that is 288 records a day in Redis, growing without bound.                                                                                                                                                                                                                                                                                                                                | Redis memory grows on a long-lived instance. `pnpm infra:reset` clears it.                                                                                                                 |
| **`JobRun.workspaceId` is not constrained to workspace identifiers** (R3), in either the in-memory double or the Prisma repository.                                                                                                                                                                                                                                                                                                                                           | An invariant that reads as enforced is not.                                                                                                                                                |
| **Long transcripts and long run lists are not windowed.** `Transcript` and `RunsTable` render every row, and each active run row holds a one-second interval, so a chat with hundreds of tool calls or a job with hundreds of runs pays for all of them at once. Nothing in the product has produced such a list yet, and no windowing library is in the manifest.                                                                                                            | A very long history scrolls slowly.                                                                                                                                                        |
| **Dead refinement in stalled-turn recovery** (R23). The turn processor keys part of its recovery on a delivery attempt count that never moves for a job rescued from a dead worker.                                                                                                                                                                                                                                                                                           | Harmless today — the other arm of the recovery is what catches an abandoned turn — and a trap for whoever edits it next.                                                                   |

### Gaps in the checks

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Residual risk                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The end-to-end suite is not run against a real stack by continuous integration.** Continuous integration runs the mocked mode; the real-stack mode has to be started by hand, so nothing catches a regression in it between one person remembering to run it and the next.                                                                                                                                                                                                  | The ten real-stack checks pass when run, but only when someone runs them.                                                                                |
| **Mutation testing is not part of the gate.** Stryker is installed and its scope and thresholds are settled, but no package implements `test:mutation`, so the root script is a no-op and no continuous-integration job runs it.                                                                                                                                                                                                                                              | Coverage is 100 % on four metrics, which says every line ran, not that a test would notice if it changed.                                                |
| **A control covered by another is caught only in the end-to-end suite** (R43, closed). The assertion exists now — `apps/web/e2e/interactive-controls.spec.ts` asks a real browser, at nine points inside every interactive element, whether something else would take the click, and asserts the pointer cursor and the absence of horizontal page scroll on the same walk. jsdom still cannot express any of it, so the unit suites are still blind to this class of defect. | A layout regression is caught by `pnpm test:e2e`, not by `pnpm test`, so it surfaces one gate later.                                                     |
| **A class-name assertion can pass while the class loses** (R42). A component asking for a width the primitive overrides still satisfies a test that only asserts the class is present.                                                                                                                                                                                                                                                                                        | A test that asserts a class is present proves the class was asked for, not that it won. Treat the shape as a gap wherever it appears, not as one defect. |

### Rough edges in the toolchain

| Item                                                                                                                                                                                                                                                                             | Residual risk                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`pnpm doctor` runs pnpm's own doctor.** `infra:doctor` is the name pnpm does not claim; renaming the underlying `doctor` script itself is not possible without losing `pnpm run doctor` too.                                                                                   | A reader who copies bare `pnpm doctor` gets a report about their pnpm installation and no error — `pnpm infra:doctor` is the form to reach for instead.                                            |
| **`pnpm setup --force` silently drops the flag.** pnpm parses options after a built-in name against that built-in's own list, and `--force` is one of `pnpm setup`'s, so the script never receives it and reports `already exists`. `pnpm run setup --force` reaches the script. | Spell it with the `run`. A guard reads every shell script in `infra/scripts` and every root manifest script, and fails the unit gate if one of them attaches a flag to a bare package-script name. |
| **Two contract values are mirrored in `apps/worker/src`** rather than imported (R8) — the turn-event field and the scheduled-delivery payload. The heartbeat key, its timings and its schema are now imported from `packages/core`.                                              | Byte-identical today; two copies of a constant diverge silently and both sides stay green.                                                                                                         |
| **`infra/workspace/README.md` describes a placeholder** where the Dockerfile already copies the runtime bundle.                                                                                                                                                                  | Stale note, no runtime effect.                                                                                                                                                                     |

---

## 📦 Deployment discussion

Nothing below is implemented. The local topology already has the seams a cloud deployment needs — a stateless web tier, a worker tier that is the only thing touching the runner, PostgreSQL as the source of truth, Redis as queue and event bus, and a `WorkspaceRunner` interface in front of execution. AWS is used for concreteness; the same shape fits GCP or Azure.

| Local                         | Cloud                                                                    | Notes                                                                             |
| ----------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `apps/web` on host            | ECS Fargate service behind an ALB                                        | SSE needs the idle timeout raised (≥ 60 s), heartbeats, and no response buffering |
| `apps/worker` on host         | ECS Fargate service, autoscaled on queue depth                           | Same code, different runner                                                       |
| PostgreSQL in compose         | RDS PostgreSQL 18 Multi-AZ, automated backups, PITR                      | Prisma unchanged; pooling via RDS Proxy                                           |
| Redis in compose              | ElastiCache Redis 8, cluster mode off, TLS                               | BullMQ and Streams unchanged                                                      |
| `DockerWorkspaceRunner`       | `FargateWorkspaceRunner`                                                 | `create` = `RunTask`, `exec` = ECS Exec, `destroy` = `StopTask`, `list` = tags    |
| `~/.agent-hangar/master.key`  | KMS-backed envelope: master key in Secrets Manager, cached in the worker | `SecretsService` gains a key provider; the AES-GCM code is reused                 |
| Workspace image built locally | ECR, built in CI, signed and scanned                                     | Same Dockerfile                                                                   |
| `docker-compose`              | Terraform or CDK                                                         | —                                                                                 |

**Runner options**

| Option                                               | Isolation                                    | Cold start           | Fit                                                                    |
| ---------------------------------------------------- | -------------------------------------------- | -------------------- | ---------------------------------------------------------------------- |
| ECS Fargate task per workspace (recommended first)   | Per-task micro-VM, own ENI, no shared kernel | 30–60 s              | Simplest mapping of the interface; ECS Exec gives the exec primitive   |
| Firecracker micro-VMs (self-managed or as a service) | Strong, with snapshot restore                | < 1 s with snapshots | Better UX and cost at volume; more to operate or a vendor dependency   |
| Kubernetes pods with gVisor or Kata                  | Good with sandboxed runtimes, shared cluster | 5–20 s               | Only if the organisation already runs Kubernetes                       |
| Lambda                                               | Not suitable                                 | —                    | 15-minute limit, no long-lived filesystem, poor fit for exec streaming |

**Scaling.** Every turn and job is a queue message and every worker is a stateless consumer, so capacity is the task quota times per-worker concurrency; autoscale on the waiting count. A warm pool of pre-started workspaces with no repository and no secrets cuts perceived start time to seconds while keeping per-task isolation. The idle-TTL collector that exists locally becomes the cost control. Turn limits bound cost per job, queue concurrency bounds parallelism, and model rate limits surface as retryable errors. State stays small: PostgreSQL carries metadata and redacted logs, and large tool outputs move to object storage behind a pointer once volumes grow.

**Isolation.** One micro-VM per workspace, so no two chats share a kernel, filesystem or network namespace. Private subnets with an egress allow-list (GitHub, OpenAI, package registries) and no inbound. A task role with no permissions beyond what the runtime needs, a read-only root filesystem except `/workspace` and `/tmp`, and the same non-root user, dropped capabilities and `no-new-privileges` the local runner already sets. Per-user quotas on CPU, memory, wall clock and concurrent workspaces, enforced before `create`. Signed images only, rebuilt weekly for base patches.

**Secrets.** Credentials stay in PostgreSQL as AES-256-GCM ciphertext with the data key wrapped by KMS and rotated on schedule. The worker never passes plaintext through the queue: on create it writes a per-workspace secret with the workspace's lifetime as its TTL and lets the task execution role resolve it into the environment at task start — the cloud equivalent of "environment at container start, never in an image" — then deletes it on destroy. A short-lived GitHub App installation token per run is the narrower alternative to a user PAT. The same redactor runs before anything leaves the process, with encrypted log groups and a retention policy. Stated honestly: locally `docker inspect` shows a running workspace's environment to anyone on the machine; in production that access is IAM-restricted and audited.

**Rough monthly cost at small scale** — one team, about ten active users, ~200 chat turns and ~100 scheduled runs a day, average workspace alive 20 minutes, us-east-1 on-demand prices.

| Item                                                      | Sizing                   | ≈ USD / month |
| --------------------------------------------------------- | ------------------------ | ------------: |
| Fargate — web (2 × 0.5 vCPU / 1 GB)                       | always on                |            30 |
| Fargate — worker (2 × 1 vCPU / 2 GB)                      | always on                |            60 |
| Fargate — workspaces (2 vCPU / 4 GB, ~100 task-hours/day) | pay per second           |           270 |
| RDS PostgreSQL (db.t4g.medium Multi-AZ, 50 GB)            |                          |           130 |
| ElastiCache Redis (cache.t4g.small)                       |                          |            25 |
| ALB, NAT gateway, data transfer                           | NAT is the surprise line |            80 |
| Secrets Manager, KMS, CloudWatch, ECR                     |                          |            25 |
| **Infrastructure total**                                  |                          |     **≈ 620** |
| OpenAI API usage (~300 runs/day, ~150 k tokens each)      | usage-driven             | 2 000 – 6 000 |

Infrastructure is a rounding error next to model spend. Model cost is controlled by the step limit, output truncation, history windowing, and choosing a mid-tier model for routine scheduled jobs, which would be one column on the job row.

**Before operating in production:** authentication and tenancy (OIDC, `userId` on every table, per-user secrets and quotas); egress control and output DLP for workspaces; OpenTelemetry traces across web → queue → worker → runtime, with dashboards for queue depth, turn latency, workspace count and model cost per user; Multi-AZ and PITR, Redis replication and a dead-letter review path; signed images, SBOM and dependency scanning; per-user rate limits, prompt-size caps, cost budgets and a worker kill switch; a retention policy for transcripts and an audit log of secret changes; and runbooks for key rotation, image rebuild and a leaked credential.

The full version, with the deployment diagram, is in [docs/spec/08-deployment-discussion.md](docs/spec/08-deployment-discussion.md).

---

## 🧭 Decisions and trade-offs

| Decision                                                              | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                | What was given up                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **A `WorkspaceRunner` interface with one Docker implementation**      | dockerode speaks the Docker Engine API — the same surface a remote runner would wrap — and the interface is the migration seam. It is confined to one folder, enforced by a lint rule.                                                                                                                                                                                                                                                                             | A second implementation to prove the seam locally.                                      |
| **TypeScript pinned to `~6.0.3`**                                     | TypeScript 7's native compiler has no stable programmatic API until 7.1, and the toolchain (typescript-eslint, the Stryker instrumenter, Next's type-check) depends on it. The config avoids options removed in TS 7, so upgrading later is a version bump.                                                                                                                                                                                                        | The newer compiler's speed, for now.                                                    |
| **PostgreSQL over SQLite**                                            | Two processes write concurrently, JSON columns hold redacted tool arguments, and the path to a managed database in a cloud deployment is direct.                                                                                                                                                                                                                                                                                                                   | A file-based database and one less container.                                           |
| **AES-256-GCM with a local key file, not the OS keychain**            | No extra dependency, deterministic tests, and the same envelope pattern maps onto KMS or Secrets Manager later.                                                                                                                                                                                                                                                                                                                                                    | The OS keychain's own protections.                                                      |
| **SSE over WebSocket**                                                | Streaming is one-directional; SSE reconnects and replays by `Last-Event-ID` natively, which maps directly onto Redis Streams, and survives an HTTP proxy.                                                                                                                                                                                                                                                                                                          | Bidirectional messaging that is not needed.                                             |
| **`exec` + NDJSON over an HTTP server per container**                 | No port allocation, no service discovery, no listening surface inside the workspace, and cancellation is a signal.                                                                                                                                                                                                                                                                                                                                                 | A more familiar request/response shape.                                                 |
| **BullMQ over pg-boss**                                               | Job Schedulers cover cron with timezone handling directly, and Redis Streams already back the SSE replay, so Redis earns its place twice.                                                                                                                                                                                                                                                                                                                          | One fewer service to run.                                                               |
| **A container per chat rather than a shared pool**                    | Isolation is the product requirement; a pool would leak state between chats and between users' repositories.                                                                                                                                                                                                                                                                                                                                                       | Startup latency on the first turn of a chat.                                            |
| **shadcn on Base UI (`base-nova` style)**                             | shadcn 4's default primitives with accessible, unstyled Base UI components under the project's own token set; generated into `apps/web/src/shared/ui` and owned by the repository.                                                                                                                                                                                                                                                                                 | Radix, and a smaller component catalogue than the Radix registry.                       |
| **OpenAI Responses API, stateless (`store: false`)**                  | One call per step with the full history window keeps PostgreSQL the single source of truth and needs no provider-side conversation state.                                                                                                                                                                                                                                                                                                                          | Provider-side continuation (`previous_response_id`) and the input tokens it would save. |
| **The model id lives in `OPENAI_MODEL`, never in code**               | `gpt-5.6-sol` is a default, not a dependency: a different model, or a per-job model, is a configuration change.                                                                                                                                                                                                                                                                                                                                                    | Nothing.                                                                                |
| **Security headers from `next.config.ts`, CSP as defence in depth**   | Every response carries a Content-Security-Policy plus `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` and a restrictive `Permissions-Policy`. `script-src` keeps `'unsafe-inline'` (and `'unsafe-eval'` in development for HMR), so the CSP is not a complete XSS mitigation: the primary defences are React's escaping and rendering agent Markdown without `rehype-raw`. A nonce-based CSP is the follow-up if the app ever leaves localhost. | Strict CSP today.                                                                       |
| **Web server bound to `127.0.0.1`**                                   | `next dev`/`next start` bind to `0.0.0.0` by default, which would publish the credential-writing API to the local network; both scripts pass `-H 127.0.0.1`.                                                                                                                                                                                                                                                                                                       | Reaching the UI from another device.                                                    |
| **100 % coverage on four metrics, and no suppression comments**       | Both are enforced by configuration and by tests rather than by review, so the bar cannot be lowered quietly in a diff.                                                                                                                                                                                                                                                                                                                                             | Speed on code that is genuinely hard to reach, which is excluded explicitly instead.    |
| **Mutation testing last and non-blocking**                            | Stryker sharpens tests that already exist; running it before the tests exist would only measure the gaps the coverage gate already fails on.                                                                                                                                                                                                                                                                                                                       | It is not part of the gate — see [Testing](#-testing).                                  |
| **gitleaks through its container image in CI**                        | `gitleaks/gitleaks-action` requires a licence key for organisation repositories; the official image (`ghcr.io/gitleaks/gitleaks`) needs none and scans the PR range (or the full history on `main`). The action can replace it once a key exists.                                                                                                                                                                                                                  | The action's PR annotations.                                                            |
| **`deepmerge-ts` pinned to `^8` via a pnpm override**                 | `@prisma/config` pins a version affected by GHSA-ggr8-5vv4-36mx (stack exhaustion on recursive objects); the override keeps `pnpm audit --prod` clean and the Prisma CLI works unchanged with v8.                                                                                                                                                                                                                                                                  | Nothing measurable.                                                                     |
| **Workspace image uses `CMD ["sleep","infinity"]`, not `ENTRYPOINT`** | The container idles until the worker `exec`s a turn into it, yet `docker run <image> node --version` (used by CI and by the doctor) still works because the command can be overridden.                                                                                                                                                                                                                                                                             | Nothing.                                                                                |

---

## 🚫 Non-goals

Each is out of scope on purpose, and each already has the seam that makes adding it additive rather than a rewrite.

- **Multi-user authentication** — the app runs locally for one developer. _Seam:_ every route handler already receives the incoming `Request` alongside the process-wide `ServerContainer`; a caller identity would thread through a request-scoped context derived from that `Request`, not through the container, which is a single instance cached for the whole process and shared by every concurrent request. `Secret` is keyed by `key` alone, so `(userId, key)` is one migration and one parameter.
- **Cloud deployment** — local-only is the requirement; see the [deployment discussion](#-deployment-discussion) for what would change. _Seam:_ the `WorkspaceRunner` interface, the secrets key provider, and environment-driven configuration.
- **Multiple LLM providers** — one provider keeps the agent loop, the tool schema and the streaming mapping simple and testable. _Seam:_ the `AgentModelProvider` interface, selected by `AGENT_MODEL_PROVIDER`; the `fake` provider already proves it works.
- **Kubernetes** — heavy to run locally and unnecessary for per-workspace isolation. _Seam:_ the same runner interface, with compose today and a chart later if it is ever needed.

Also intentionally absent, with no seam needed: pull-request management, site previews, plugins, voice input, file attachments, real-time collaboration, and credential-verification buttons on Settings — the doctor and the first turn surface an invalid key.

---

## 📖 Documentation

| Document                                                       | Answers                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Specification](docs/spec/README.md)                           | The full technical specification, in ten parts                             |
| [System overview](docs/spec/01-overview.md)                    | Goal, scope, success criteria, component diagram, stack                    |
| [Data model](docs/spec/02-data-model.md)                       | Prisma schema, invariants, what a faithful restore needs                   |
| [Interface contracts](docs/spec/03-interfaces.md)              | `WorkspaceRunner`, `AgentModelProvider`, agent protocol, HTTP API, queues  |
| [Sequence flows](docs/spec/04-flows.md)                        | Turn execution, archive and restore, scheduled runs, the secrets lifecycle |
| [Local development](docs/spec/05-local-dev.md)                 | Compose services, the environment model, Conductor parameterisation        |
| [Testing strategy](docs/spec/06-testing.md)                    | Layers, the real-Docker integration suite, the E2E list, the mutation gate |
| [Deployment discussion](docs/spec/08-deployment-discussion.md) | What changes to run this in the cloud, and what it would cost              |
| [Non-goals](docs/spec/09-non-goals.md)                         | What is deliberately absent, and where each seam already exists            |
| [UI design](docs/spec/10-ui-design.md)                         | Direction, tokens, shell, screens, components, states, motion              |
| [Execution plan](docs/plan.md)                                 | What is built, what is open, and every confirmed finding with its owner    |

---

## 📄 License

MIT — see [LICENSE](LICENSE).
