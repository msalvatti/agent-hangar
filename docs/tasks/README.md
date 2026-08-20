# Agent Hangar — Lane task files

One file per lane. A lane is the unit of work one isolated subagent executes end-to-end (branch → tasks top-to-bottom → gates → PR). Lanes in the same wave run **in parallel**; the orchestrator ([docs/plan.md §11](../plan.md)) merges PRs and spawns the next lanes whose dependencies are merged.

Every task inside a lane file carries a self-contained English agent prompt: an agent dropped into a fresh session with only that prompt, `CLAUDE.md`, and the referenced spec sections can execute it without guessing.

**Where the build stands (2026-08-20).** Every lane below is merged except three. W3-A, wiring and stabilisation, is running: three of its six tasks are done — the coverage widening, the real-model smoke, and the seam wiring — and nothing blocks the rest. The two mutation lanes are deferred by decision — in the plan, scheduled later, not blocked. The Status column below carries the same value as the lane table in [docs/plan.md §12](../plan.md), which is the authority the moment the two disagree; it also holds the counts, the fixes merged alongside the lanes and the findings routed to W3-A, so none of those is copied here to go stale. Where a lane file's own header disagrees with both, the merged state settles it.

| Wave | Lane | File | Owned area | Depends on | Status |
|---|---|---|---|---|---|
| 0 | W0 | [wave-0-foundation.md](wave-0-foundation.md) | everything (monorepo, contracts, doubles, Prisma, infra base, app shells, CI) | — | 🟩 |
| 1 | W1-A | [wave-1a-secrets-redaction.md](wave-1a-secrets-redaction.md) | `packages/core/src/{secrets,redaction,logging}` | W0 | 🟩 |
| 1 | W1-B 🐳 | [wave-1b-docker-runner.md](wave-1b-docker-runner.md) | `packages/core/src/runner/docker`, `infra/workspace` | W0 | 🟩 |
| 1 | W1-C | [wave-1c-openai-provider.md](wave-1c-openai-provider.md) | `packages/core/src/model/openai`, fixtures | W0 | 🟩 |
| 1 | W1-D | [wave-1d-agent-runtime.md](wave-1d-agent-runtime.md) | `packages/agent-runtime` | W0 | 🟩 |
| 1 | W1-E | [wave-1e-persistence.md](wave-1e-persistence.md) | `packages/core/src/persistence/repositories` | W0 | 🟩 |
| 1 | W1-F | [wave-1f-scheduling-workspace.md](wave-1f-scheduling-workspace.md) | `packages/core/src/{scheduling,workspace,restore,queues}` | W0 | 🟩 |
| 1 | W1-G | [wave-1g-web-chats.md](wave-1g-web-chats.md) | `apps/web/src/features/{shell,chats}`, `src/shared/transcript`, chat pages, mocks | W0 | 🟩 |
| 1 | W1-H | [wave-1h-web-scheduled-settings.md](wave-1h-web-scheduled-settings.md) | `apps/web/src/features/{scheduled,settings}`, pages | W0 (rebase after W1-G) | 🟩 |
| 1 | W1-I | [wave-1i-infra-conductor.md](wave-1i-infra-conductor.md) | `infra/scripts`, `.conductor`, compose, root scripts | W0 (merge first in batch) | 🟩 |
| 2 | W2-A | [wave-2a-web-api-sse.md](wave-2a-web-api-sse.md) | `apps/web/app/api`, `apps/web/src/server` | W1-A, W1-E, W1-F | 🟩 |
| 2 | W2-B 🐳 | [wave-2b-worker.md](wave-2b-worker.md) | `apps/worker/src` | W1-A…W1-F | 🟩 |
| 2 | W2-C | [wave-2c-e2e.md](wave-2c-e2e.md) | `apps/web/e2e`, `infra/test/gitserver` | W1-G, W1-H | 🟩 |
| 3 | W3-A 🐳 | [wave-3a-integration.md](wave-3a-integration.md) | any (single agent) | W2-A, W2-B, W2-C | 🔄 3/6 |
| 3 | W3-B | [wave-3b-docs.md](wave-3b-docs.md) | `README.md`, `docs/**` | W2-A, W2-B | 🟩 |
| 4 | W4-A | [wave-4a-stryker-core.md](wave-4a-stryker-core.md) | `packages/core` tests + stryker config | W3-A — but the deferral, not this dependency, is why it is idle | 🟡 |
| 4 | W4-B | [wave-4b-stryker-runtime.md](wave-4b-stryker-runtime.md) | `packages/agent-runtime` tests + stryker config | W3-A — but the deferral, not this dependency, is why it is idle | 🟡 |

Legend: 📋 ToDo · 🟦 running (branch) · 🟨 PR open · 🟩 merged · 🟥 blocked / held · 🟡 deferred by decision (in the plan, scheduled later — not blocked; see [plan §9](../plan.md)). These six symbols are the whole vocabulary: the same set is used by [plan §12](../plan.md) and by every lane file's own header, and no lane may carry a different one in two places.

Scheduling reminders (from [docs/plan.md §3](../plan.md)): ≤ 5 concurrent subagents; ≤ 1 🐳 lane at a time; each subagent in its own worktree with `AH_INSTANCE=<lane>`; no dependency additions inside lanes; contracts frozen after W0 (additive change PRs only).
