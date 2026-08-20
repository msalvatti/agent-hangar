# Workspace image

The disposable container an agent works inside: one per chat, one per scheduled run. It is created
by `DockerWorkspaceRunner` (`packages/core/src/runner/docker/`), never by compose, and it is
destroyed together with everything written into it.

## What is in the image

|                   |                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base              | `node:24-bookworm-slim`                                                                                                                                       |
| Tools             | `git`, `ca-certificates`, `ripgrep`, `jq`, `python3`, `build-essential`, `curl`, `corepack` (pnpm, yarn)                                                      |
| User              | `agent`, uid 1001, non-root                                                                                                                                   |
| Working directory | `/workspace`, owned by `agent` — where the repository is cloned                                                                                               |
| Runtime directory | `/opt/agent-runtime`, **root-owned and read-only to `agent`** — holds `askpass.sh` and, later, the agent runtime bundle                                       |
| Git configuration | `credential.helper=""`, `GIT_ASKPASS=/opt/agent-runtime/askpass.sh`, `GIT_TERMINAL_PROMPT=0`, `init.defaultBranch=main`, `/workspace` marked a safe directory |
| Idle command      | `CMD ["sleep", "infinity"]` — the container idles and the worker `exec`s turns into it                                                                        |

`CMD` rather than `ENTRYPOINT` so `docker run agent-hangar/workspace:dev node --version` still works
for diagnostics while the runner's `exec` path is unaffected.

The image contains **no secrets, no `.env` and no source of this repository** other than the runtime
bundle. Credentials arrive as container environment at `create` time.

## Build

```bash
pnpm infra:image   # honours WORKSPACE_IMAGE from .env.local
```

There is no bare `docker build -t agent-hangar/workspace:dev infra/workspace` equivalent: the
runtime bundle below is staged into the build context by `pnpm infra:image` itself, not by
Docker, so a bare `docker build` here fails on a fresh clone that has no `runtime/` directory yet.
`infra/scripts/setup.sh` already goes through `pnpm infra:image` for the same reason.

A warm-cache rebuild takes a few seconds; a cold build is dominated by the `apt-get` layer and stays
well under three minutes.

## Runtime bundle

`/opt/agent-runtime/` will also hold the esbuild bundle of `packages/agent-runtime`. The Dockerfile
carries a placeholder for it:

```dockerfile
# --- AGENT RUNTIME BUNDLE (added by W1-D) ---
```

Two `COPY` lines are added under that marker when the agent-runtime package lands:

```dockerfile
COPY runtime/cli.js /opt/agent-runtime/cli.js
COPY runtime/cli.js.map /opt/agent-runtime/cli.js.map
```

No `--chown`: the bundle is executed by `agent` and must not be writable by it. `/opt/agent-runtime`
is root-owned for the same reason — see [Security properties](#security-properties).

`pnpm infra:image` then builds `@agent-hangar/agent-runtime` first and copies its `dist/cli.js*` into
`infra/workspace/runtime/` before the `docker build`. That folder is a build artefact: it is
`.gitignore`d here and explicitly allowed into the build context by `.dockerignore`.

## askpass and the token file

`GIT_ASKPASS` is set image-wide, so `/opt/agent-runtime/askpass.sh` answers every credential prompt
git makes inside the workspace — including the ones the agent itself triggers.

- A prompt containing `Username` is answered with `x-access-token` (GitHub's fixed username for
  token authentication).
- Any other prompt is answered with the token, read from **`AH_GIT_TOKEN_FILE`** when that variable
  names a readable file, otherwise from **`GITHUB_TOKEN`**. The file exists so the agent runtime can
  keep the PAT out of the environment it hands to the shell tool's children while git, running with
  that same scrubbed environment, can still authenticate.
- Credentials are released **only** for the origin in `AH_GIT_ALLOWED_ORIGIN`, which the worker
  sets from the repository URL the workspace was created for, after measuring it against
  `ALLOWED_REPO_HOSTS`. The prompt is reduced to an origin — scheme, host and port, userinfo
  dropped — and compared for exact equality, so `github.com.evil.test`,
  `https://github.com@evil.test`, `https://evil.test/github.com/x` and the same host on another
  port are all refused, while a forge the operator listed on another host or port is served. The
  container is deliberately not given the allow-list: this helper decides from a host it reads out
  of a prompt, so a set of acceptable origins would mean a crafted prompt naming any one of them is
  answered with the token.
- The approved origin must itself be `https`. `ALLOWED_REPO_HOSTS` may authorise a cleartext origin
  — the local forge a container reaches through the host gateway is why it may — but that
  authorises a clone, not a credential: a workspace created for an `http` origin clones anonymously
  and is answered nothing here.
- An absent or empty `AH_GIT_ALLOWED_ORIGIN` releases nothing. A container nobody prepared has no
  forge to fall back to.
- Every refusal prints nothing on stdout and exits non-zero, so git fails authentication instead of
  reading an empty line as a valid password. An absent or empty token fails the same way.

## Security properties

Some are baked into the image, the rest are applied by the runner at `create` time. They are listed
together because they only make sense as one posture.

| Property                                                                            | Where it comes from  |
| ----------------------------------------------------------------------------------- | -------------------- |
| Runs as uid 1001, never root                                                        | image (`USER agent`) |
| No credential in any layer or in `Config.Env`                                       | image                |
| `/opt/agent-runtime` root-owned — `agent` cannot replace `askpass.sh` or the bundle | image                |
| All Linux capabilities dropped (`--cap-drop ALL`)                                   | runner               |
| `no-new-privileges`                                                                 | runner               |
| CPU, memory and PIDs ceilings                                                       | runner               |
| `/tmp` on a tmpfs                                                                   | runner               |
| No bind mount, no volume, **no Docker socket**                                      | runner               |
| Bridge network (egress only, no inbound)                                            | runner               |
| A real init as PID 1 (`--init`) — signals reach the process, orphans are reaped     | runner               |
| Labelled `ah.instance`, `ah.workspace`, `ah.kind` for scoped discovery and reaping  | runner               |

The container runs code chosen by a language model reading untrusted repository content. Treat every
line above as load-bearing.

## How to verify

```bash
docker run --rm agent-hangar/workspace:dev id -u                       # 1001
docker image inspect agent-hangar/workspace:dev --format '{{json .Config}}' | jq '.User, .WorkingDir, .Cmd, .Labels'
docker image inspect agent-hangar/workspace:dev --format '{{json .Config}}' | grep -Ei 'token|secret|api_key'   # no output
DOCKER_AVAILABLE=1 pnpm --filter @agent-hangar/core test:integration    # the @docker suite
```

The `@docker` suite is the real check: it creates workspaces against the local daemon and asserts the
limits, the hardening flags, the absence of mounts, filesystem isolation between two workspaces, and
that the injected credentials never reach the image.

## Troubleshooting

| Symptom                                         | Cause and fix                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkspaceImageMissing`                         | The image has not been built on this host. Run `pnpm infra:image`. Nothing is ever pulled or built implicitly.                        |
| `cannot inspect image …`                        | The daemon is unreachable. The runner looks for it in this order: `DOCKER_HOST`, `~/.docker/run/docker.sock`, `/var/run/docker.sock`. |
| `DOCKER_TLS_VERIFY is not supported …`          | The runner speaks to a unix socket or plain TCP only; point `DOCKER_HOST` at one of those.                                            |
| `container name already exists for workspace …` | A previous container of that workspace was never removed. `pnpm ws:list` / `pnpm ws:reap`.                                            |
| `workspace did not become ready`                | The container started but never accepted an exec. Check `docker logs ah-ws-<instance>-<workspaceId>`.                                 |
| `askpass: refusing to release credentials …`    | Working as intended: something asked for the token for a host other than the approved one.                                            |
