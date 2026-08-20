# Agent Hangar — Specification

Technical specification for **Agent Hangar**, a local-first web application where AI agents answer questions and perform coding tasks against GitHub repositories inside isolated, disposable workspaces. Read in order; each document is self-contained.

| # | Document | What it answers |
|---|---|---|
| 01 | [System overview](01-overview.md) | Goal, scope, user stories, success criteria, component diagram, stack, decisions, risks, open questions |
| 02 | [Data model](02-data-model.md) | Prisma schema, invariants, what must be persisted for faithful restore |
| 03 | [Interface contracts](03-interfaces.md) | `WorkspaceRunner`, `AgentModelProvider`, agent-runtime protocol, HTTP API, queues, secrets service |
| 04 | [Sequence flows](04-flows.md) | New chat → run → stream · archive → restore · scheduled job → fresh workspace · secrets save → encrypt → inject → redact |
| 05 | [Local dev & run story](05-local-dev.md) | docker-compose, environment model, first-run experience, scripts, Conductor parameterisation, README outline |
| 06 | [Testing strategy](06-testing.md) | Unit, integration against real Docker, Playwright E2E list, mutation gate, CI |
| 07 | [Phased build plan](07-build-plan.md) | Seven phases with scope, files, tests, and DONE criteria — walking skeleton first |
| 08 | [Deployment discussion](08-deployment-discussion.md) | Cloud mapping, scaling, isolation, secrets delivery, cost estimate, production changes |
| 09 | [Non-goals](09-non-goals.md) | What is out of scope and where each seam already exists |
| 10 | [UI design](10-ui-design.md) | Direction, tokens, shell, screens, components, states, motion, accessibility |

Status: **Approved** — 2026-08-19. Execution plan: [../plan.md](../plan.md).

Revision: 2026-08-20 — 01 stack table verified against the installed tree; 05 corrected against
`infra/scripts/*` and `packages/core/src/config/schema.ts` (setup steps, script list, environment
table, workspace image); 06 corrected against `.github/workflows/ci.yml` and the Vitest configs
(job list, coverage policy); 09's authentication seam names the `ServerContainer` the handlers
actually take. Behaviour, decisions and success criteria are unchanged.
