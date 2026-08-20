# 09 — Explicit Non-Goals

| | |
|---|---|
| **Status** | ✅ Approved — 2026-08-19 |
| **Revision** | 2026-08-20 — authentication seam corrected: `ServerContainer` is a process-wide singleton (`getServerContainer()` caches one instance), not a per-caller seam, so it must not carry identity; the seam is the `Request` each route handler already receives |
| **Owner** | Maximiliano |
| **Last updated** | 2026-08-19 |

Each item is out of scope for v1 on purpose. For each: why, and where the seam already exists so adding it later is additive, not a rewrite.

| Non-goal | Why out of scope | Where the seam already exists |
|---|---|---|
| **Multi-user authentication** | The app runs locally for one developer; auth adds a login flow, session storage, and per-user data partitioning with no local benefit. | Every route handler already receives the incoming `Request` alongside the process-wide `ServerContainer` (see `apps/web/app/api/**`) — a caller identity is threaded through a request-scoped context derived from that `Request`, never through the container, which is a single cached instance shared by every concurrent request and must stay limited to shared dependencies. `Secret` keyed by `key` today becomes `(userId, key)` with one migration. OIDC via `next-auth`/`proxy.ts` drops in at the edge. |
| **Cloud deployment** | Requirement is local-only macOS; cloud infra costs money and time that buys no local functionality. | `WorkspaceRunner` interface (second impl = `FargateWorkspaceRunner`), `SecretsService` key provider, env-driven config, Docker images already built in CI. See [08](08-deployment-discussion.md). |
| **Multiple LLM providers** | One provider keeps the agent loop, tool schema, and streaming mapping simple and testable; the product requirement names OpenAI. | `AgentModelProvider` interface; provider chosen by `AGENT_MODEL_PROVIDER`; the `fake` provider proves the seam works. Adding one = implement `stream()` + `listModels()` and register the name. |
| **Kubernetes** | Heavy to run locally, unnecessary for per-workspace isolation, and not the cheapest cloud target for this shape. | Same `WorkspaceRunner` seam (`KubernetesWorkspaceRunner` using the Jobs API + exec); infra is compose today and a Helm chart later if ever needed. |

Also intentionally not built (no seam needed, simply absent): pull-request management UI, site previews, plugins, voice input, file attachments, real-time collaboration, and credential verification buttons on Settings (the doctor script and the first turn surface invalid keys).
