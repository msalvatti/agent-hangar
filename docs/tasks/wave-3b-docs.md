# Wave 3 — W3-B README + docs refresh

| | |
|---|---|
| **Lane** | W3-B (single agent; documentation only — runs in parallel with W3-A 🐳) |
| **Status** | 📋 ToDo |
| **Progress** | 0/5 tasks |
| **Branch** | `feat/w3b-docs` |
| **Owned paths** | `README.md`, `docs/**` (except `docs/tasks/wave-3a-integration.md` and the W3-A row of `docs/plan.md` §12 / `docs/tasks/README.md`, which W3-A keeps current) |
| **Depends on** | W2-A, W2-B merged (may start on the W1 state and rebase before the close-out) |
| **Unblocks** | — (no lane depends on it; Wave 4 depends on W3-A). Must merge before the product is considered delivered |
| **Source** | [docs/plan.md §8](../plan.md) (W3-B) · spec [05 §7](../spec/05-local-dev.md) [01 §5–§6](../spec/01-overview.md) [06](../spec/06-testing.md) [08](../spec/08-deployment-discussion.md) [09](../spec/09-non-goals.md) |
| **Last updated** | 2026-08-19 |

## Context

W0 left a README skeleton; Waves 1–2 changed names, scripts and versions while building. This lane writes the real README following the outline in spec 05 §7 — from quick start to the deployment discussion — and refreshes `docs/spec/*` wherever reality diverged (versions, file names, paths, script names), keeping each spec **Approved** and adding a "Revision" line. It also brings `docs/plan.md` §12 and `docs/tasks/README.md` statuses up to date for merged lanes. The README is the first thing a reader sees: it must let someone clone, run and understand the system without opening the spec, and must state honestly what is not finished (Wave 4 mutation testing) with the plan to finish it.

Everything written here is about the product only — the README reads like the documentation of an open-source developer tool, with no reference to anything outside it (no people, organisations, dates of delivery or context of origin).

## Rules of this lane

1. **Owned paths only:** `README.md` and `docs/**`. Do not touch code, configs, `.github/**`, `package.json`, or `CLAUDE.md`. If a doc reveals a code bug, write it down in the completion log for the orchestrator — do not fix it here.
2. **Reality wins over the spec, and the doc must say so.** Every statement in the README is verified against the repository at the time of writing (`package.json` versions, script names, env variable names from `packages/core/src/config/schema.ts`, paths from `ls`). Where the spec is stale, update the spec (keep status Approved, add `Revision: <date> — <what changed>` under the status line) instead of leaving two truths.
3. **English only.** Concise, specific, action-oriented. Commands are copy-pasteable. Every table has a header row. Mermaid diagrams render on GitHub (no HTML labels beyond `<br/>`).
4. **Honesty section is mandatory:** "Known gaps & plan to finish" is generated from `docs/plan.md` §12 at close-out time — every lane not 🟩 appears with one line and a plan; Wave 4 (Stryker) status is always stated, even if it is "scheduled, not started".
5. **No secrets, no real-looking tokens** in docs — use the canary shapes from `@agent-hangar/core/testing` (`ghp_TESTCANARY…`, `sk-TESTCANARY…`) when an example is needed.
6. Conventional Commits (`docs:` scope), no AI-attribution trailers. Branch `feat/w3b-docs`. One PR at the end (T3B.5). Rebase on `main` before each task if W3-A merged contract/script changes meanwhile.
7. The usual repository rules still apply to anything that could be parsed as code in docs (fenced examples): no `enum`, JSDoc shown on exported examples, no suppression comments.

## Reference docs

- [docs/plan.md](../plan.md) § "8. Wave 3" (W3-B), § "9. Wave 4" (for Known gaps), § "12. Status dashboard"
- [spec 01 — Overview](../spec/01-overview.md) § "5. Success criteria", § "6. Technical approach" (component diagram, decisions table, stack table)
- [spec 05 — Local dev](../spec/05-local-dev.md) § "1. Prerequisites", § "3. Environment model", § "4. First-run experience", § "6. Conductor integration", § "7. What the README will contain"
- [spec 06 — Testing](../spec/06-testing.md) § "1. Layers", § "3. Integration tests", § "4. Playwright E2E", § "5. Mutation testing", § "6. CI pipeline"
- [spec 08 — Deployment discussion](../spec/08-deployment-discussion.md) (all sections — condensed into README)
- [spec 09 — Non-goals](../spec/09-non-goals.md)
- [spec 04 — Flows](../spec/04-flows.md) (d) settings — for the secrets lifecycle paragraph
- `docs/tasks/wave-1i-infra-conductor.md` appendix (Conductor README draft, if present), `docs/tasks/wave-3a-integration.md` completion log (smoke script paragraph, `src/shared/ui` decision, doctor tables — read-only)

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 3B.1 | README part 1: What this is, Requirements, Quick start, How it works, Configuration, Scripts, Conductor | 📋 | P0 | M | — |
| 3B.2 | README part 2: Testing, Security notes, Troubleshooting | 📋 | P0 | S | 3B.1 |
| 3B.3 | README part 3: Known gaps & plan, Deployment discussion, Decisions & trade-offs, Non-goals | 📋 | P0 | M | 3B.1 |
| 3B.4 | Spec refresh (`docs/spec/*` Revision lines), plan §12 and tasks index statuses | 📋 | P1 | S | 3B.1–3B.3 |
| 3B.5 | Close-out: gates, code review, dashboard, PR | 📋 | P0 | S | 3B.1–3B.4 |

---

## Task 3B.1 — README part 1: What this is, Requirements, Quick start, How it works, Configuration, Scripts, Conductor

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** Rewrite the top half of `README.md` per spec 05 §7 items 1–7, verified against the repository: a three-sentence description with a screenshot placeholder, requirements table, the four-command quick start, "How it works" with the Mermaid component diagram from spec 01 §6 and the three pillars (isolated workspaces, scheduled jobs, encrypted settings), the full configuration table, the scripts reference, and "Working with Conductor".

**Acceptance criteria**
- [ ] README starts with the title, one-paragraph description (what, for whom, the three pillars), a badges line (CI badge for `.github/workflows/ci.yml`; mutation badge placeholder commented out until W4-C), and a screenshot placeholder `![Agent Hangar — chat view](.github/assets/readme/chat.png)` with an HTML comment noting W3-A's evidence screenshots can be promoted here by the orchestrator
- [ ] "Requirements" table = spec 05 §1 (macOS 13+, Docker Desktop/OrbStack/Colima, Node 24 LTS, pnpm 11 via corepack, Git 2.40+) with the check command per row
- [ ] "Quick start": `git clone … && cd agent-hangar`, `corepack enable`, `pnpm setup`, `pnpm dev`, then "Settings → paste GitHub PAT and OpenAI API key → New chat → choose repository → prompt"; the numbered list of what `pnpm setup` does (spec 05 §4) verified against `infra/scripts/setup.sh`; a note that `pnpm setup` is idempotent and that `pnpm doctor` explains anything missing
- [ ] "How it works": the Mermaid flowchart from spec 01 §6 (copied, then checked that every node name matches real package/app names), the components table (apps/web, apps/worker, packages/core, packages/agent-runtime, infra/), the three pillars in one paragraph each (chat turn lifecycle incl. idle TTL + restore; scheduled job = fresh workspace per run, destroyed in `finally`; secrets = AES-256-GCM envelopes in Postgres, master key outside the repo, last-4 in UI, redaction on every persisted string), and links to `docs/spec/01-overview.md`, `04-flows.md`, `10-ui-design.md`
- [ ] "Configuration" table = every variable in `packages/core/src/config/schema.ts` with default and purpose (spec 05 §3 as the base; add anything W1–W3 introduced, e.g. `NEXT_PUBLIC_API_MOCK`, `ALLOWED_REPO_HOSTS` if present) and the explicit sentence that PAT/OpenAI key are **not** env vars
- [ ] "Scripts" table = every root `package.json` script with one line each (verified against the file), grouped: run · infra · db · test · quality · workspaces · smoke
- [ ] "Working with Conductor": the draft from `docs/tasks/wave-1i-infra-conductor.md` appendix if present (adapted), else written from spec 05 §6: what Conductor sets, how `env.sh` maps it, the `.conductor/settings.toml` content, the isolation table, and "two workspaces side by side" with the `pnpm doctor` proof; instance/port derivation explained for non-Conductor users too (`AH_INSTANCE`, `AH_PORT_BASE`)

**Files to modify**
`README.md`.

**Agent prompt**

````
You are a senior technical writer and TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 workspaces · TypeScript ~6.0.3 strict · Node 24 · Next.js 16.3 App Router + React 19.2 · Tailwind v4 + shadcn (Base UI) · Postgres 18 + Prisma 7.9 · Redis 8 + BullMQ 6 · dockerode 5 · openai SDK 7.5 · Vitest 4 · Playwright 1.62 · Stryker 10.
Branch feat/w3b-docs (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W3-B (README + docs refresh) — Task 3B.1 of 5 (FIRST)

PRECONDITIONS
- W2-A and W2-B are merged (or, if you start earlier on the W1 state, you will rebase and re-verify every command/path before 3B.5).
- README.md is the W0 skeleton; docs/spec/* are Approved; W3-A runs in parallel and owns all code paths — you own README.md and docs/** only.

REQUIRED READING (only these):
- docs/spec/05-local-dev.md § "1. Prerequisites", § "3. Environment model", § "4. First-run experience", § "6. Conductor integration", § "7. What the README will contain"
- docs/spec/01-overview.md § "1. Goal", § "3. Scope", § "6. Technical approach" (diagram + components table)
- docs/tasks/wave-1i-infra-conductor.md (appendix only, if it exists)
- Repository files to verify against: root package.json (scripts), infra/scripts/setup.sh, infra/scripts/env.sh, .conductor/settings.toml, .env.example, packages/core/src/config/schema.ts, pnpm-workspace.yaml

TASK
Write README sections 1–7 of the spec 05 §7 outline so a developer can clone, run and understand the system from the README alone, with every command, path, variable and version verified against the repository.

DELIVERABLES

1. Header block: `# Agent Hangar`; one paragraph (what it is, the three pillars, local-first on macOS + Docker); badges line (`[![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](…)` — read owner/repo from `git remote get-url origin`; a commented-out mutation badge line `<!-- mutation badge: added by W4-C -->`); screenshot placeholder `![Agent Hangar — chat view](.github/assets/readme/chat.png)` followed by `<!-- TODO(orchestrator): promote a W3-A evidence screenshot from .github/assets/w3a/ -->`; a 3-line table of contents of the README sections.
2. `## Requirements` — table from spec 05 §1 with a "Check" column.
3. `## Quick start` — the four commands, then "then in the browser: Settings → …", then "What `pnpm setup` does" as a numbered list cross-checked line by line against infra/scripts/setup.sh (order, flags, idempotency), then one line on `pnpm doctor`. Mention `AH_INSTANCE`/`AH_PORT_BASE` here in one sentence with a forward link to the Conductor section.
4. `## How it works` — the Mermaid flowchart from spec 01 §6 (verify node labels against real names: `apps/web`, `apps/worker`, `packages/core`, `packages/agent-runtime`, Postgres 18, Redis 8, workspace containers); the components table; three short paragraphs titled **Isolated workspaces**, **Scheduled jobs**, **Encrypted settings** describing the lifecycle (chat: queue → worker → container (reuse if live, else create + clone, or restore with history window) → NDJSON events → Redis Streams → SSE; idle TTL GC; archive/restore; job: fresh container per run, destroyed in `finally`, overlap skipped; secrets: AES-256-GCM, master key `~/.agent-hangar/master.key` 0600, ciphertext + last4 in Postgres, reveal only in the worker at container start, redaction of every persisted string). End with links to docs/spec/01, 02, 03, 04, 10.
5. `## Configuration` — table (Variable · Default · Purpose) generated from packages/core/src/config/schema.ts in source order; mark which ones Conductor derives; the sentence "GitHub PAT and OpenAI API key are not environment variables — enter them in Settings; they are stored encrypted in Postgres." in bold.
6. `## Scripts` — table of every root package.json script, grouped (Run · Infra · Database · Tests · Quality · Workspaces · Smoke), one line each; flag scripts that need Docker or the user's keys.
7. `## Working with Conductor` — if docs/tasks/wave-1i-infra-conductor.md has an appendix titled README draft, adapt it; else write: what Conductor provides (`CONDUCTOR_WORKSPACE_NAME`, `CONDUCTOR_PORT`, scripts setup/run/archive), how `infra/scripts/env.sh` maps them to `AH_INSTANCE`/`AH_PORT_BASE` and derives ports/DB/compose project/container prefix, the `.conductor/settings.toml` (copied verbatim from the repo), the isolation table (spec 05 §6), the "two workspaces side by side" walkthrough with an example `pnpm doctor` excerpt showing different ports and DB names (take the real shape from infra/scripts/doctor.sh output; use `default`/`feat-x`).

Constraints:
- English; copy-pasteable commands; every claim verified against the repo (`grep`/`ls`/`cat`), not against the spec alone. Where the spec and repo differ, follow the repo and note the divergence in your working notes for T3B.4.
- Owned paths only (README.md now). No code changes, no package.json edits.
- No mention of anything outside the product (no people, organisations, delivery dates or context of origin).

Verification:
- Every script named in README exists in root package.json: `node -e "const s=require('./package.json').scripts; for (const n of process.argv.slice(1)) if(!s[n]) {console.error('missing',n);process.exit(1)}" <names>` — exit 0
- Every env var in the Configuration table appears in packages/core/src/config/schema.ts (`grep -c`)
- Mermaid block renders (paste into https://mermaid.live or `gh` preview) — no syntax error
- `pnpm format:check` — README passes Prettier

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-3b-docs.md (task index row and task block)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/5 tasks`)
4. Append a completion log entry at the end of the file: `- 3B.1 ✅ <YYYY-MM-DD> — <one-line summary>`
5. Commit: `docs(readme): write overview, quick start, architecture, configuration, scripts and Conductor sections`
````

---

## Task 3B.2 — README part 2: Testing, Security notes, Troubleshooting

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** S · **Depends on:** 3B.1

**Description.** Write spec 05 §7 items 8–10: how to run every test layer locally (unit, integration, E2E, mutation, real-model smoke) with the coverage policy (100 % on all four metrics per package) and Stryker thresholds; the security notes (secrets lifecycle, what is and is not protected on a local machine, the `docker inspect` caveat); and a troubleshooting section with the six known situations and their fixes.

**Acceptance criteria**
- [ ] "Testing": a table (Layer · Command · Needs · Budget) for unit (`pnpm test`, `pnpm test -- --coverage`), integration (`pnpm test:integration`, needs Docker + test stack `AH_INSTANCE=test`, tags `@docker @db @redis`, "fails loudly, never silently skipped in CI"), E2E (`pnpm test:e2e`, what the harness starts, `--ui` locally), mutation (`pnpm test:mutation`, per package, runtime expectation, not yet in CI — status from plan §12), real-model smoke (`pnpm smoke:openai`, preconditions from W3-A's completion log, not in CI); the coverage policy paragraph ("100 % lines/branches/functions/statements on `src/**` of every package, enforced by Vitest thresholds; `apps/web/src/shared/ui/**` decision from W3-A's log); the Stryker paragraph (scope table from spec 06 §5, `break: 80`, target 90, reports in `reports/mutation/`); the rule that every `it()` carries a comment; link to `docs/spec/06-testing.md`
- [ ] "Security notes": secrets lifecycle in five steps (enter in Settings → `PUT /api/settings/:key` over localhost → AES-256-GCM with the master key → Postgres row (ciphertext, iv, authTag, last4, keyVersion) → worker `reveal` only when starting a container → injected as env at container start → redacted everywhere); "what is protected locally" vs "what is not" (the master key file protects against reading the DB dump, not against root on the same machine; `docker inspect` on a running workspace shows env on the developer's own machine — spec 08 §4 wording; logs are redacted but the browser devtools show the PUT body once); key rotation (`infra/scripts/rotate-key.sh` if W1-I shipped it — verify) ; CI secret scan; canary convention for tests
- [ ] "Troubleshooting": Docker socket not found (`DOCKER_HOST`, `~/.docker/run/docker.sock`, `/var/run/docker.sock`, Docker Desktop setting), port in use (`AH_PORT_BASE`, `pnpm doctor` shows the port, `lsof -i :<port>`), workspace image missing (`pnpm infra:image`), model not available (`OPENAI_MODEL`, `pnpm doctor` model check, 401/404 meaning), macOS `localhost` IPv6 (why `127.0.0.1` is used everywhere; what to do if a tool insists on `localhost`), worker not running / pill red (`pnpm dev` starts both; heartbeat explanation from W3-A), plus "stale containers" (`pnpm ws:list`, `pnpm ws:reap`) — each as **Symptom → Cause → Fix** with the exact command, verified against `infra/scripts/doctor.sh` messages

**Files to modify**
`README.md`.

**Agent prompt**

````
You are a senior technical writer and TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: Vitest 4 (@vitest/coverage-v8, 100 % thresholds) · Playwright 1.62 · Stryker 10 (`@stryker-mutator/core` + `vitest-runner`) · Docker Desktop · Postgres 18 · Redis 8 · AES-256-GCM via node:crypto.
Branch feat/w3b-docs (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W3-B — Task 3B.2 of 5 (MIDDLE)

PRECONDITIONS
- Task 3B.1 done (README sections 1–7 written).

REQUIRED READING (only these):
- docs/spec/06-testing.md § "1. Layers", § "3. Integration tests", § "4. Playwright E2E", § "5. Mutation testing"
- docs/spec/04-flows.md (d) settings (secrets lifecycle + the "Transport" row)
- docs/spec/08-deployment-discussion.md § "4. How secrets are stored and delivered" (last bullet — local `docker inspect` caveat)
- docs/spec/01-overview.md § "8. Risks" R2, R4, R7
- docs/tasks/wave-3a-integration.md completion log (smoke script paragraph; src/shared/ui decision) — read-only; if not yet written, leave a clearly marked `<!-- W3-A pending: … -->` placeholder and fill it at 3B.5
- Repository files: root package.json scripts, infra/scripts/doctor.sh (messages), infra/scripts/rotate-key.sh (exists?), packages/core/src/testing/canaries.ts, the four vitest.config.ts, .github/workflows/ci.yml (secret-scan job)

TASK
Write README sections "Testing", "Security notes" and "Troubleshooting" so a developer can run every test layer, understands exactly what the local security model does and does not protect, and can self-serve the six known failure modes.

DELIVERABLES

1. `## Testing` — table Layer · Command · Needs · Budget (unit / integration / E2E / mutation / real-model smoke); a paragraph "Coverage policy" (100 % on all four metrics for src/** of every package; thresholds in vitest.config.ts fail the run; the src/shared/ui decision as recorded by W3-A; every it() carries a one-line comment of the behaviour proved); a paragraph "Mutation testing" (scope table: packages/core modules + agent-runtime tools; `break: 80`, target 90; reports under reports/mutation/ — gitignored; status and plan per docs/plan.md §9/§12: state plainly whether it is enforced in CI yet); a paragraph "Real model smoke" (`pnpm smoke:openai`: what it does, preconditions — keys in Settings, stack running with `AGENT_MODEL_PROVIDER=openai` — and that it never runs in CI); link to docs/spec/06-testing.md.
2. `## Security notes` — "Secrets lifecycle" numbered steps (verify each against docs/spec/04 (d) and the code paths' names: `SecretsService`, `Redactor`, `GIT_ASKPASS`); "What is protected locally / what is not" as two short bullet lists (include verbatim the honest `docker inspect` statement from spec 08 §4 adapted to local wording; browser devtools see the PUT body once; a root user on the same machine can read the master key; logs are redacted by value and by shape, tests assert canaries never leak); "Rotation" (rotate-key script if present — verify, else say how `keyVersion` enables a future rotation); "Repository hygiene" (gitleaks in CI, `.gitignore` for `.env*`/`master.key`, canary constants for tests).
3. `## Troubleshooting` — seven entries, each `**Symptom** → **Cause** → **Fix**` with the exact command: Docker socket not found; port already in use; workspace image missing; model not available (401/404, `OPENAI_MODEL`); macOS `localhost` resolves to IPv6 (why the repo uses 127.0.0.1); worker not running / environment pill red (heartbeat); stale workspace containers (`pnpm ws:list` / `pnpm ws:reap`). Cross-check each message against infra/scripts/doctor.sh so the README and the doctor say the same thing.

Constraints:
- English; verified against the repository; no secrets, only canary shapes as examples.
- Owned paths only. Do not invent behaviour: if rotate-key or a doctor row does not exist, write what exists and note the gap for "Known gaps" (T3B.3).

Verification:
- Every command in the three sections exists (`grep` the scripts block / infra/scripts)
- `pnpm format:check` — README passes Prettier
- Section anchors (#testing, #security-notes, #troubleshooting) resolve from the README table of contents

Completion Protocol: update status/AC/progress in docs/tasks/wave-3b-docs.md; append `- 3B.2 ✅ <date> — <summary>`; commit `docs(readme): add testing, security notes and troubleshooting`.
````

---

## Task 3B.3 — README part 3: Known gaps & plan, Deployment discussion, Decisions & trade-offs, Non-goals

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** M · **Depends on:** 3B.1

**Description.** Write the honest and the forward-looking tail of the README: "Known gaps & plan to finish" generated from `docs/plan.md` §12 (every lane not 🟩 with one line and its plan; Wave 4 mutation status explicit), the condensed deployment discussion (spec 08: cloud mapping table, runner options, scaling, isolation, secrets, cost table, production changes — ≤ 1.5 pages + link), "Decisions & trade-offs" as short sentences from spec 01 §6 plus the TypeScript 6 pin, and "Non-goals" one line each from spec 09.

**Acceptance criteria**
- [ ] "Known gaps & plan to finish": generated from `docs/plan.md` §12 at writing time — a table (Item · Status · Plan) listing every lane not 🟩 (expected: W3-A 🟨/🟦, W4-A, W4-B ⬜) with one concrete line each; a sentence "Mutation testing (Stryker 10) is scheduled as the last wave: scope and thresholds are fixed (see Testing); the CI `mutation` job is added when both package runs pass" (or the actual status); any doc-found gaps from 3B.2 (e.g. missing rotate-key) listed; closing sentence that the section is regenerated at every merge and empty is the goal
- [ ] "Deployment discussion" (≤ 1.5 printed pages): intro sentence (local topology already has the seams: stateless web, worker as the only runner client, Postgres truth, Redis queue + bus, `WorkspaceRunner` interface); the Local → Cloud mapping table (8 rows from spec 08 §1); the runner options table (4 rows); "Scaling" 5 bullets; "Isolation in production" 4 bullets; "Secrets" 3 bullets (KMS envelope, per-workspace secret at task start, logs); the cost table (9 rows + takeaway sentence); "Before operating in production" 8 one-line items; link `See docs/spec/08-deployment-discussion.md for the full discussion.`
- [ ] "Decisions & trade-offs": one short sentence per row of spec 01 §6 decisions table (runner interface + dockerode; exec + NDJSON over per-container HTTP; SSE over WebSocket; BullMQ over pg-boss; Postgres + Prisma over SQLite; AES-GCM + master key file over keychain/Vault; Responses API over Chat Completions; `gpt-5.6-sol` via `OPENAI_MODEL`; Next 16 + Tailwind v4 + shadcn/Base UI) **plus** the TypeScript `~6.0.3` pin (why not TS 7: native compiler without a stable programmatic API until 7.1; tsconfig avoids removed options so the upgrade is a version bump) and any decision recorded by W0 T0.8 that is still true
- [ ] "Non-goals": one line each for multi-user auth, cloud deployment, multiple LLM providers, Kubernetes — with the seam named in a few words — and the "also not built" sentence from spec 09
- [ ] A short "License" line matches the repository's LICENSE file (or "TBD" if absent — note for the orchestrator)

**Files to modify**
`README.md`.

**Agent prompt**

````
You are a senior technical writer and architect working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: TypeScript ~6.0.3 · Next.js 16.3 · Postgres 18 + Prisma 7.9 · Redis 8 + BullMQ 6 · dockerode 5 · OpenAI Responses API (`gpt-5.6-sol` via OPENAI_MODEL) · Stryker 10.
Branch feat/w3b-docs (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W3-B — Task 3B.3 of 5 (MIDDLE)

PRECONDITIONS
- Task 3B.1 done (README sections 1–7). 3B.2 may be done or in progress — the three sections of this task are independent of it.

REQUIRED READING (only these):
- docs/plan.md § "9. Wave 4", § "12. Status dashboard" (current state — read it fresh from main at writing time)
- docs/spec/08-deployment-discussion.md (all six sections — you condense them)
- docs/spec/01-overview.md § "6. Technical approach" (Key decisions table, Stack table), § "8. Risks" R1
- docs/spec/09-non-goals.md
- README.md "Decisions" section as W0 T0.8 wrote it (keep what is still true)

TASK
Write the README sections "Known gaps & plan to finish", "Deployment discussion", "Decisions & trade-offs", "Non-goals" and the license line — honest, condensed, and verifiable against docs/plan.md and the spec.

DELIVERABLES

1. `## Known gaps & plan to finish` — read docs/plan.md §12 on the current main; produce a table Item · Status · Plan with one row per lane whose status is not 🟩 (use the human-readable lane name, e.g. "Mutation testing — packages/core (W4-A)"), plus rows for gaps you found while documenting (missing script, spec/readme divergence that needs code — each with the lane/PR expected to close it). Add the Wave 4 sentence (Stryker scope fixed, thresholds `break: 80` target 90, CI job added by a follow-up once both packages pass) and the closing sentence that this section is regenerated at every merge. If the table is empty at writing time, say so explicitly.
2. `## Deployment discussion` — condense docs/spec/08 to ≤ 1.5 pages: one intro sentence; the Local → Cloud table (8 rows, shortened Notes); the Runner options table (4 rows: Fargate task per workspace (recommended first step), Firecracker micro-VMs (self-managed or as a service), Kubernetes + gVisor/Kata, Lambda (not suitable)); **Scaling** (5 bullets: horizontal by design, warm pool, idle economics, back-pressure, state stays small); **Isolation in production** (4 bullets); **Secrets** (3 bullets: KMS-wrapped data key in Secrets Manager; per-workspace secret resolved at task start and deleted on destroy; same Redactor + encrypted logs, with the honest local-vs-prod `docker inspect` sentence); **Rough monthly cost at small scale** (the 9-row table with the assumptions line and the takeaway: infrastructure ≈ 620 USD is a rounding error next to model spend 2 000–6 000 USD); **Before operating in production** (8 one-liners). Close with the link to docs/spec/08-deployment-discussion.md. Keep the Mermaid diagram out (link only) to respect the length budget.
3. `## Decisions & trade-offs` — bullet list, one sentence each in the form "**<Decision>** over <alternative> — <reason>", covering every row of spec 01 §6's decisions table plus: TypeScript pinned to `~6.0.3` (TS 7 native compiler lacks a stable programmatic API until 7.1; tsconfig avoids `baseUrl`/legacy `moduleResolution` so upgrading is a version bump); shadcn on Base UI; `coverage.include` src/** with 100 % on four metrics; Stryker last and non-blocking; secrets in Settings not env; 127.0.0.1 over localhost. Merge with the W0 "Decisions" text — keep one list.
4. `## Non-goals` — four lines (auth, cloud, multi-provider, Kubernetes) each ending with "seam: <where>", then the "also intentionally not built" sentence from spec 09 verbatim in spirit.
5. `## License` — match the repository's LICENSE; if absent write `License: TBD` and note it in the completion log for the orchestrator.

Constraints:
- English; ≤ 1.5 pages for the deployment section (≈ 70 lines of Markdown incl. tables); numbers copied exactly from spec 08; nothing promised that the spec does not say.
- Owned paths only. No references to anything outside the product.

Verification:
- Every lane in "Known gaps" matches a non-🟩 row of docs/plan.md §12 at the time of writing (diff by eye)
- `wc -l` of the Deployment section ≤ 80 lines
- `pnpm format:check` — README passes Prettier; all intra-README anchors resolve

Completion Protocol: update status/AC/progress in docs/tasks/wave-3b-docs.md; append `- 3B.3 ✅ <date> — <summary>`; commit `docs(readme): add known gaps, deployment discussion, decisions and non-goals`.
````

---

## Task 3B.4 — Spec refresh (`docs/spec/*` Revision lines), plan §12 and tasks index statuses

**Status:** 📋 ToDo · **Priority:** P1 · **Size:** S · **Depends on:** 3B.1–3B.3

**Description.** Using the divergence notes collected while writing the README, bring `docs/spec/01–10` in line with reality where versions, names, paths or script names changed during implementation — without changing any behaviour statement. Each touched spec keeps status **Approved** and gains a `Revision:` line. Update `docs/plan.md` §12 and `docs/tasks/README.md` statuses for every merged lane (🟩) and set W3-B's row to 🟦 running.

**Acceptance criteria**
- [ ] Every divergence noted in 3B.1–3B.3 is resolved in the spec (e.g. stack table versions in 01 §6 match `package.json`; paths in 05 §2 match `ls`; script names in 05 §4 match root `package.json`; route list in 03 §4 matches `apps/web/app/api/**`; env table in 05 §3 matches `config/schema.ts`; E2E harness description in 06 §4 matches W2-C; Conductor file in 05 §6 matches `.conductor/settings.toml`) — only factual corrections, never a behaviour change
- [ ] Each touched spec file: status line stays `Approved`; a line `Revision: 2026-MM-DD — <what changed, in ≤ 15 words>` is added directly under the status line (append to an existing Revision line as a new line if one exists); `docs/spec/README.md` index unchanged except for a "last revised" column if it has one
- [ ] `docs/plan.md` §12: every merged lane row set to 🟩 with its PR number (verify with `gh pr list --state merged --search "W1-"` etc. — do not trust memory); W3-B row → 🟦 running (worktree path); W3-A row left untouched (W3-A owns it)
- [ ] `docs/tasks/README.md`: status column updated to match plan §12 for every lane; W3-B → 🟦; W3-A row untouched
- [ ] A "Docs divergence log" subsection in this task file's completion entry listing `spec file → change` one per line

**Files to modify**
`docs/spec/01-overview.md` … `docs/spec/10-ui-design.md` (only where needed), `docs/spec/README.md` (only if it has a revised column), `docs/plan.md` (§12 rows other than W3-A), `docs/tasks/README.md` (rows other than W3-A).

**Agent prompt**

````
You are a senior technical writer and TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: see docs/spec/01-overview.md § "6. Technical approach" (Stack table) — you are about to verify it against package.json.
Branch feat/w3b-docs (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W3-B — Task 3B.4 of 5 (MIDDLE)

PRECONDITIONS
- Tasks 3B.1–3B.3 done; your working notes list every spec/repo divergence found while writing the README.
- main has been fetched; you have rebased this branch on it.

REQUIRED READING (only these):
- docs/spec/README.md (index + status convention)
- Your divergence notes from 3B.1–3B.3
- docs/plan.md § "12. Status dashboard" and docs/tasks/README.md
- For verification: root package.json, the four workspace package.json files, apps/web/app/api/** (route list), packages/core/src/config/schema.ts, infra/scripts/*.sh, .conductor/settings.toml, apps/web/e2e/** (harness summary)

TASK
Correct docs/spec/01–10 where the implementation diverged in facts (versions, names, paths, scripts, route lists, env variables), keep every spec Approved with a Revision line, and refresh the plan dashboard and tasks index statuses for merged lanes.

DELIVERABLES

1. For each spec file with a divergence: apply the minimal factual correction (e.g. `Prisma 7.9` → the installed minor; a renamed script; a moved file; a route added in W2-A; an env var added in W3-A) — do NOT change behaviour, decisions, diagrams' meaning or success criteria. Add `Revision: <date> — <summary>` under the status line. Leave untouched files untouched.
2. docs/spec/01-overview.md § "6. Technical approach" Stack table: set every version to what `pnpm ls -r --depth 0` reports (major.minor), dated "verified <today>".
3. docs/plan.md § "12. Status dashboard": for every lane whose PR is merged (`gh pr list --state merged --limit 50 --json number,title,headRefName`), set 🟩 + PR number; W3-B → `🟦 running (<worktree path>)`; do not edit the W3-A row. Keep the legend.
4. docs/tasks/README.md: mirror the statuses; do not edit the W3-A row.
5. Completion-log entry with a "Docs divergence log" list: `<spec file> → <change>` per line.

Constraints:
- English; owned paths only; minimal diffs (one fact per change); never delete a section.
- If a divergence implies a product bug (the code does something the spec forbids), do NOT change the spec to match — record it under "Known gaps" in README (T3B.3) and in the completion log for the orchestrator.

Verification:
- `git diff --stat main -- docs/spec` shows only the intended files
- Every touched spec has exactly one status line still reading Approved and ≥ 1 Revision line
- `grep -n "W3-A" docs/plan.md docs/tasks/README.md` shows the rows unchanged from main (`git diff main -- docs/plan.md | grep "W3-A"` empty)
- `pnpm format:check` — docs pass Prettier

Completion Protocol: update status/AC/progress in docs/tasks/wave-3b-docs.md; append `- 3B.4 ✅ <date> — <n> spec files revised; dashboards refreshed` followed by the divergence log lines indented under it; commit `docs(spec): refresh specs to match the implementation and update dashboards`.
````

---

## Task 3B.5 — Close-out: gates, code review, dashboard, PR

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** S · **Depends on:** 3B.1–3B.4

**Description.** Final verification of the README against a fresh checkout (every command, path and link), fill any `W3-A pending` placeholders from W3-A's completion log, run the repository gates that apply to docs (format, lint on Markdown/Prettier, link check), run the code review to zero findings, set the dashboard rows to 🟨, and open the PR.

**Acceptance criteria**
- [ ] Fresh-clone dry run of the Quick start on the current branch (`git clone` into a temp dir, follow the README literally; stop before `pnpm setup` if Docker is not available to this agent and say so) — every referenced file exists, every script name resolves, every relative link in README and docs/** resolves (`grep -o '](\.[^)]*)'` + `test -e`)
- [ ] All `<!-- W3-A pending -->` placeholders resolved (from `docs/tasks/wave-3a-integration.md` completion log) or converted to a line in "Known gaps" if W3-A has not finished
- [ ] `pnpm format:check` and `pnpm lint` green (Markdown is Prettier-formatted; no code changed)
- [ ] `/bymax-quality:code-review` run on the branch with zero open findings (docs diffs still get checked for English, wording, secrets-looking strings, broken fences)
- [ ] `docs/plan.md` §12 W3-B row → 🟨 with branch + PR number; `docs/tasks/README.md` W3-B row → 🟨; this file's header Status → 🟨 PR open, Progress 5/5
- [ ] PR opened with `gh pr create`; body: summary, README section list with anchors, spec revision list, dashboard changes, known gaps as written, checks performed; returned `{ pr, branch, headSha, gates, coverage, contractChangeRequests }` (coverage `n/a — docs only`; `contractChangeRequests: []`)

**Files to modify**
`README.md` (placeholders), `docs/plan.md` (§12 W3-B row), `docs/tasks/README.md` (W3-B row), `docs/tasks/wave-3b-docs.md` (header, log).

**Agent prompt**

````
You are a senior engineer closing out the documentation lane of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · Node 24 · Prettier (Markdown) · GitHub CLI.
Branch feat/w3b-docs (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W3-B — Task 3B.5 of 5 (LAST)

PRECONDITIONS
- Tasks 3B.1–3B.4 done and committed on this branch; branch rebased on latest main.

REQUIRED READING (only these):
- README.md (the whole file, as a first-time reader)
- docs/tasks/wave-3a-integration.md completion log (to resolve placeholders)
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard"

TASK
Verify the README end to end as a new reader would, resolve placeholders, run the docs gates and the code review to zero findings, update the dashboards, and open the PR.

DELIVERABLES

1. Fresh-clone check: `git clone <repo> <tmp> && cd <tmp> && git checkout feat/w3b-docs`; follow Quick start literally up to the point your environment allows; verify every referenced path exists and every script exists. Link check: for every `](./…)`/`](docs/…)` target in README.md and docs/**, `test -e`; fix broken ones.
2. Resolve every `<!-- W3-A pending -->` placeholder from W3-A's completion log (smoke script paragraph, src/shared/ui decision, doctor tables, heartbeat wording). If W3-A has not recorded an item yet, replace the placeholder with a "Known gaps" row ("README: <item> — filled when W3-A merges") rather than leaving an HTML comment.
3. Gates: `pnpm format:check && pnpm lint` green. Run `/bymax-quality:code-review` on `main..HEAD`; fix every finding (language, wording, fenced-code validity, anything secret-looking; no suppressions); re-run the gates; repeat on every new commit before pushing.
4. Dashboards: docs/plan.md §12 W3-B row → `🟨 PR open` with branch/PR number (leave the W3-A row alone); docs/tasks/README.md W3-B → 🟨; this file: header Status → 🟨, Progress 5/5.
5. Push and open the PR: `gh pr create --base main --title "docs: README and spec refresh (W3-B)" --body-file <generated>` — body: Summary · README sections (with anchors) · Spec revisions (file → change) · Dashboard updates · Known gaps as written · Checks performed (fresh clone, link check, format, review). Do not wait for CI; do not merge.
6. Return to the orchestrator: `{ pr, branch, headSha, gates: { format, lint, review: 'zero findings' }, coverage: 'n/a (docs only)', contractChangeRequests: [] }`.

Constraints:
- English; Conventional Commits; no AI attribution anywhere (commits, PR body, comments).
- Owned paths only; if the fresh-clone check finds a code/script problem, it goes into "Known gaps" and the PR body — not into a code change.

Verification:
- `gh pr view --json number,headRefOid` — PR exists
- `git diff --name-only main..HEAD | grep -v '^README.md$' | grep -v '^docs/'` — empty (owned paths only)
- `git log --format=%B main..HEAD | grep -i "co-authored-by\|generated with"` — empty

Completion Protocol: update status/AC/progress in docs/tasks/wave-3b-docs.md (header Status → 🟨 PR open); append `- 3B.5 ✅ <date> — PR #<n> opened`; commit `docs: close out W3-B documentation lane` before opening the PR (then a `docs(plan): record W3-B PR number` commit after `gh pr create`).
````

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)
