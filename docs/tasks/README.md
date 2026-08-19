# Agent Hangar — Lane task files

One file per lane. A lane is the unit of work one isolated subagent executes end-to-end (branch → tasks top-to-bottom → gates → PR). Lanes in the same wave run **in parallel**; the orchestrator ([docs/plan.md §11](../plan.md)) merges PRs and spawns the next lanes whose dependencies are merged.

Every task inside a lane file carries a self-contained English agent prompt: an agent dropped into a fresh session with only that prompt, `CLAUDE.md`, and the referenced spec sections can execute it without guessing.

| Wave | Lane | File | Owned area | Depends on | Status |
|---|---|---|---|---|---|
| 0 | W0 | [wave-0-foundation.md](wave-0-foundation.md) | everything (monorepo, contracts, doubles, Prisma, infra base, app shells, CI) | — | 🟨 |
| 1 | W1-A | [wave-1a-secrets-redaction.md](wave-1a-secrets-redaction.md) | `packages/core/src/{secrets,redaction,logging}` | W0 | 📋 |
| 1 | W1-B 🐳 | [wave-1b-docker-runner.md](wave-1b-docker-runner.md) | `packages/core/src/runner/docker`, `infra/workspace` | W0 | 📋 |
| 1 | W1-C | [wave-1c-openai-provider.md](wave-1c-openai-provider.md) | `packages/core/src/model/openai`, fixtures | W0 | 🟦 |
| 1 | W1-D | [wave-1d-agent-runtime.md](wave-1d-agent-runtime.md) | `packages/agent-runtime` | W0 | 📋 |
| 1 | W1-E | [wave-1e-persistence.md](wave-1e-persistence.md) | `packages/core/src/persistence/repositories` | W0 | 📋 |
| 1 | W1-F | [wave-1f-scheduling-workspace.md](wave-1f-scheduling-workspace.md) | `packages/core/src/{scheduling,workspace,restore,queues}` | W0 | 📋 |
| 1 | W1-G | [wave-1g-web-chats.md](wave-1g-web-chats.md) | `apps/web/src/features/{shell,chats}`, `src/shared/transcript`, chat pages, mocks | W0 | 📋 |
| 1 | W1-H | [wave-1h-web-scheduled-settings.md](wave-1h-web-scheduled-settings.md) | `apps/web/src/features/{scheduled,settings}`, pages | W0 (rebase after W1-G) | 📋 |
| 1 | W1-I | [wave-1i-infra-conductor.md](wave-1i-infra-conductor.md) | `infra/scripts`, `.conductor`, compose, root scripts | W0 (merge first in batch) | 📋 |
| 2 | W2-A | [wave-2a-web-api-sse.md](wave-2a-web-api-sse.md) | `apps/web/app/api`, `apps/web/src/server` | W1-A, W1-E, W1-F | 📋 |
| 2 | W2-B 🐳 | [wave-2b-worker.md](wave-2b-worker.md) | `apps/worker/src` | W1-A…W1-F | 📋 |
| 2 | W2-C | [wave-2c-e2e.md](wave-2c-e2e.md) | `apps/web/e2e`, `infra/test/gitserver` | W1-G, W1-H | 📋 |
| 3 | W3-A 🐳 | [wave-3a-integration.md](wave-3a-integration.md) | any (single agent) | W2-A, W2-B, W2-C | 📋 |
| 3 | W3-B | [wave-3b-docs.md](wave-3b-docs.md) | `README.md`, `docs/**` | W2-A, W2-B | 📋 |
| 4 | W4-A | [wave-4a-stryker-core.md](wave-4a-stryker-core.md) | `packages/core` tests + stryker config | W3-A | 📋 may slip |
| 4 | W4-B | [wave-4b-stryker-runtime.md](wave-4b-stryker-runtime.md) | `packages/agent-runtime` tests + stryker config | W3-A | 📋 may slip |

Legend: 📋 ToDo · 🟦 running · 🟨 PR open · 🟩 merged · 🟥 blocked.

Scheduling reminders (from [docs/plan.md §3](../plan.md)): ≤ 5 concurrent subagents; ≤ 1 🐳 lane at a time; each subagent in its own worktree with `AH_INSTANCE=<lane>`; no dependency additions inside lanes; contracts frozen after W0 (additive change PRs only).
