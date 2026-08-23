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

Revision: 2026-08-23 — 01's S7 and 06 §5 restated against the mutation work that was actually done:
the score is 100 rather than 80, the scope is every package plus `infra/scripts/lib` rather than a
list of directories in `packages/core`, and the sweep is a local one rather than a CI job. 07's
phase 4 records that its mutation gate moved to a wave of its own. 2026-08-20 — 01 stack table verified against the installed tree; 05 corrected against
`infra/scripts/*` and `packages/core/src/config/schema.ts` (setup steps, script list, environment
table, workspace image); 06 corrected against `.github/workflows/ci.yml` and the Vitest configs
(job list, and the coverage/mutation success criteria themselves, raised from the tiered numbers
originally written there to what the configuration already enforces — 100 % on four metrics
everywhere, mutation scope including `packages/agent-runtime`); 09's authentication seam corrected
to name the `Request` each route handler already receives, not the process-wide `ServerContainer`
cache. Behaviour and decisions are unchanged; 06's testing success criteria are corrected upward to
match what is enforced, not left as originally written. 05's doctor description and instance-
resolution paragraph are further corrected against `fix/instance-resolution`: the checkout's
`.env.local` now decides which instance a command acts on, not the shell, and a shell that
disagrees is refused rather than obeyed or ignored.

Revision: 2026-08-21 — four routed findings closed against the code, and the documents corrected
to match rather than left describing what they replaced. 02's `JobRun` gains `workBranch` and
`lastPushedSha` with the invariant that governs them, and the reason a run is given columns rather
than the message channel R46 named; 03's `WorkspaceRunner` gains `imageExists`, its health row
says the image is read on every beat rather than remembered, its `reap-idle` row names three
reconciliation arms rather than two, and its SSE framing paragraph records that a resume point the
stream no longer holds is refused; 04's scheduled-run flow records the push write and its edge
cases record both the refusal and the crash-mid-teardown case; 10's "replay fills the gap
silently" is corrected — it fills it silently only while the stream still holds the client's
position, and admits the gap otherwise. 01, 06 and 07 follow the same four changes.
