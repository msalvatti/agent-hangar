# 04 — Sequence Flows

Four flows cover every requirement. Note how (b) and (c) reuse (a): a restore and a scheduled run are both "create a fresh workspace and run a turn".

## (a) New chat → task execution → streaming output

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant UI as Browser (Next.js UI)
  participant WEB as apps/web (route handlers)
  participant PG as Postgres
  participant Q as Redis (BullMQ + Streams)
  participant W as apps/worker
  participant R as DockerWorkspaceRunner
  participant C as Workspace container (agent-runtime)
  participant OAI as OpenAI API
  participant GH as GitHub

  U->>UI: pick repo + branch, type prompt, send
  UI->>WEB: POST /api/chats {repoUrl, baseBranch, prompt}
  WEB->>PG: INSERT Chat, Message(USER, seq 1), Turn(QUEUED)
  WEB->>Q: chat-turns.add('run-turn', {turnId}, {jobId: turnId})
  WEB-->>UI: 201 {chatId, turnId}
  UI->>WEB: GET /api/chats/:id/events (SSE, EventSource)
  WEB->>Q: XREAD BLOCK events:turn:<turnId>

  W->>Q: consume run-turn
  W->>PG: Turn → PREPARING; find live Workspace for chat (none)
  W->>PG: INSERT Workspace(CREATING, kind CHAT)
  W->>W: secrets.reveal(GITHUB_PAT, OPENAI_API_KEY); redactor.register(values)
  W->>R: create({image, env: {GITHUB_TOKEN, OPENAI_API_KEY, GIT_ASKPASS…}, limits, labels})
  R-->>W: handle {containerId}
  W->>PG: Workspace → READY (runnerRef = containerId)
  W->>PG: build TurnRequest: instructions + history window + repo + limits, prepare.clone=true
  W->>R: exec(handle, node cli.js turn, stdin=TurnRequest)
  R->>C: docker exec (stdin NDJSON)

  C->>GH: git clone --branch base (PAT via GIT_ASKPASS)
  C-->>R: prepare.progress / prepare.done
  loop until no tool calls or limits hit
    C->>OAI: responses.stream(model, instructions, items, tools)
    OAI-->>C: text deltas / function_call items
    C-->>R: assistant.delta / tool.call
    C->>C: execute tool (run_shell / read_file / write_file / list_dir)
    C-->>R: tool.output.delta… tool.result
    C->>C: append function_call_output
  end
  C-->>R: turn.completed {usage, finalMessage}
  R-->>W: ExecEvent stream → parsed AgentEvents

  Note over W,Q: for every AgentEvent
  W->>W: redact()
  W->>Q: XADD events:turn:<turnId> * event=… (MAXLEN ~5000, EXPIRE 1h)
  W->>PG: persist (ToolCallLog on tool.call/result, Message ASSISTANT on turn.completed, TOOL_SUMMARY per tool, Turn → SUCCEEDED, usage)
  W->>PG: Workspace → READY, lastActiveAt = now
  Q-->>WEB: stream entries
  WEB-->>UI: SSE id/event/data
  UI-->>U: live transcript: text, tool cards, final answer
```

**Edge cases**

- Image missing → `Turn.FAILED` with `WorkspaceImageMissing`, event `turn.failed` carries the fix command; UI shows a banner linking to README.
- OpenAI 401 → `turn.failed {code: 'auth'}`; UI links to Settings. 429 → runtime retries with backoff up to 3 times, then fails.
- Limits hit (`maxSteps`, `maxTurnMs`) → runtime emits `assistant.message` explaining what was done so far, then `turn.completed` with `stoppedBy: 'limit'` (field omitted in the type above for brevity).
- Cancel → `POST /api/turns/:id/cancel` → web publishes `cmd:turn:<id> cancel` on Redis pub/sub → worker `runner.signal(INT)` → `turn.cancelled` → Turn `CANCELLED`.
- Worker crash mid-turn → BullMQ stalled-job detection re-queues; on pickup the worker sees `Workspace.status = BUSY` with a dead exec, destroys that workspace (`list()` by label), and re-runs the turn in a fresh one with a `SYSTEM` note.
- Browser reconnect → `Last-Event-ID` → `XRANGE (id, +]` replay then tail; if the stream expired, UI re-fetches `GET /api/chats/:id` and shows persisted state.

**Second and later messages:** same flow, but step 11–13 find the live `READY` workspace, `prepare.clone=false`, and the history window is rebuilt from `Message` rows (the container's filesystem carries over as long as it is alive).

## (b) Archive → restore

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant UI
  participant WEB as apps/web
  participant PG as Postgres
  participant Q as Redis
  participant W as apps/worker
  participant R as DockerWorkspaceRunner
  participant C as New container
  participant GH as GitHub

  rect rgb(40,44,52)
  Note over U,R: ARCHIVE
  U->>UI: Archive chat
  UI->>WEB: POST /api/chats/:id/archive
  WEB->>PG: Chat → ARCHIVED, archivedAt
  WEB->>Q: workspace-gc.add('destroy', {chatId})  (immediate)
  WEB-->>UI: 200 (chat moves to "Archived")
  W->>Q: consume destroy
  W->>R: snapshot(handle) → {branch, headSha, dirty, ahead}
  W->>PG: Chat.workBranch/lastPushedSha updated if ahead==0 && pushed; Message(SYSTEM,"Workspace archived; N uncommitted changes discarded")
  W->>R: destroy(handle)
  W->>PG: Workspace → DESTROYED
  end

  rect rgb(40,52,44)
  Note over U,GH: RESTORE (days later)
  U->>UI: open archived chat → Restore
  UI->>WEB: POST /api/chats/:id/restore
  WEB->>PG: Chat → ACTIVE; Message(SYSTEM, restoration notice)
  WEB-->>UI: 200; UI shows full history + "Workspace will be recreated on next message"
  U->>UI: sends next prompt
  UI->>WEB: POST /api/chats/:id/messages
  WEB->>PG: Message(USER), Turn(QUEUED)
  WEB->>Q: chat-turns.add
  W->>Q: consume
  W->>PG: no live workspace → build RestoreContext (02 §4)
  W->>R: create(new container)
  W->>R: exec(turn, prepare.clone=true, repo.workBranch, expectedHeadSha)
  C->>GH: clone base; fetch + checkout workBranch if present
  C-->>W: prepare.done {headSha} (mismatch → prepare.progress warning)
  Note over C: continues exactly as flow (a) step 21+
  end
```

Restore is **not** a special code path: the worker's "ensure workspace" step always asks "is there a live workspace for this chat? no → create and clone from the persisted context". Idle-TTL GC (every 5 min, `WORKSPACE_IDLE_TTL_MIN` default 30) exercises the same path for active chats, so restore is tested on every long-lived chat, not only on archived ones.

## (c) Scheduled job trigger → fresh workspace → run recorded

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant UI
  participant WEB as apps/web
  participant PG as Postgres
  participant Q as Redis (BullMQ Job Scheduler)
  participant W as apps/worker
  participant R as DockerWorkspaceRunner
  participant C as Fresh container
  participant OAI as OpenAI

  U->>UI: New job {name, cron, tz, repo, branch, prompt}
  UI->>WEB: POST /api/jobs
  WEB->>WEB: validate cron (cron-parser), compute nextRunAt
  WEB->>PG: INSERT ScheduledJob(enabled)
  WEB->>Q: scheduled-jobs.upsertJobScheduler(jobId, {pattern: cron, tz}, {name:'run-scheduled-job', data:{jobId}})
  WEB-->>UI: 201

  Note over Q,W: at each cron tick
  Q->>W: deliver run-scheduled-job {jobId}
  W->>PG: job still enabled? (else ack & skip)
  W->>PG: INSERT JobRun(QUEUED→PREPARING, trigger SCHEDULE, scheduledFor)
  W->>PG: INSERT Workspace(kind JOB, CREATING)
  W->>R: create(fresh container, secrets env)
  W->>PG: Workspace READY; JobRun RUNNING
  W->>R: exec(turn, items=[user: prompt], prepare.clone=true, limits.jobs)
  C->>OAI: tool loop (as flow a)
  C-->>W: AgentEvents → XADD events:turn:<runId>; ToolCallLog(jobRunId)
  C-->>W: turn.completed {finalMessage}
  W->>PG: JobRun → SUCCEEDED, output=finalMessage, usage; ScheduledJob.lastRunAt/nextRunAt
  W->>R: destroy(handle)   (finally — also on failure/cancel)
  W->>PG: Workspace → DESTROYED
  UI->>WEB: GET /api/jobs/:id/runs (list) · GET /api/runs/:id/events (SSE while running)
```

**Guarantees**

- One workspace per run, always destroyed in `finally`; GC reaps any survivor by label `ah.jobRun`.
- Overlap policy: if a run is still executing when the next tick fires, the new run is recorded as `FAILED` with error `previous run still running` (no queueing pile-up). Stated in the UI.
- Disable → `removeJobScheduler(jobId)`; enable/edit → `upsertJobScheduler` (idempotent by key). Delete → remove scheduler + cascade rows.
- Worker boot → reconcile: for every enabled job upsert its scheduler; remove schedulers with no matching enabled row.
- Manual run → `scheduled-jobs.add('run-scheduled-job', {jobId, trigger:'MANUAL'})`; identical consumer path.

## (d) Secrets: save → encrypt → inject → redact

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant UI as Settings page
  participant WEB as apps/web
  participant S as SecretsService (core)
  participant K as Master key file (~/.agent-hangar/master.key)
  participant PG as Postgres
  participant W as apps/worker
  participant R as DockerWorkspaceRunner
  participant C as Container
  participant L as Logs / DB writes

  Note over U,PG: SAVE
  U->>UI: paste PAT, click Save
  UI->>WEB: PUT /api/settings/GITHUB_PAT {value}   (HTTPS-less localhost; value never logged)
  WEB->>S: set('GITHUB_PAT', value)
  S->>K: load 32-byte key (created 0600 on first run by `pnpm setup`)
  S->>S: iv = random(12); AES-256-GCM encrypt; authTag
  S->>PG: UPSERT Secret{ciphertext, iv, authTag, keyVersion, last4}
  S-->>WEB: {last4}
  WEB-->>UI: 200 {set:true, last4:"abcd"}
  UI-->>U: field shows ••••••••abcd, "Replace" / "Remove"

  Note over W,C: INJECT (per workspace create)
  W->>S: reveal('GITHUB_PAT'), reveal('OPENAI_API_KEY')
  S->>PG: SELECT row; decrypt with authTag verification
  S-->>W: plaintext (in memory only)
  W->>W: redactor.register([pat, key])
  W->>R: create({env:{GITHUB_TOKEN:pat, OPENAI_API_KEY:key, GIT_ASKPASS:'/opt/agent-runtime/askpass.sh'}})
  R->>C: container env at start (never in image layers, never in repo)
  Note over C: run_shell child processes receive a scrubbed env (no GITHUB_TOKEN/OPENAI_API_KEY); git obtains the token via GIT_ASKPASS

  Note over C,L: REDACT (every write)
  C-->>W: AgentEvent (runtime already redacted by shape)
  W->>W: redactor.redact(event) — exact values + shapes
  W->>L: pino logger with redact paths + serializer; ToolCallLog/Message via repositories that call redact()
```

**Controls, end to end**

| Where | Control |
|---|---|
| Repo | `.gitignore`: `.env*`, `master.key`, `*.pem`; CI step runs `gitleaks` on the tree |
| UI | Input `type=password`, never pre-filled; GET returns only `{set, last4}` |
| Transport | Localhost only; `PUT` body is the only place plaintext travels; route handler disables request logging for `/api/settings` |
| DB | ciphertext + iv + tag; key never in DB |
| Key | `~/.agent-hangar/master.key` (override `MASTER_KEY_PATH`), 0600, generated on first `pnpm setup`; README explains backup/rotation (`keyVersion`) |
| Worker memory | plaintext lives only in the `create()` call; not stored on any object |
| Container | env only; image built from repo without secrets; `docker inspect` locally shows env — acceptable for local single-user, replaced by secret-manager injection in production ([08](08-deployment-discussion.md)) |
| Shell tool | child env scrubbed; PAT only via `GIT_ASKPASS` |
| Logs | pino `redact` on known paths + `Redactor` serializer; log level `info` excludes tool args by default |
| Tests | unit: encrypt/decrypt roundtrip, tamper → throws, redaction of exact and shaped values, env scrubbing; E2E: mask; CI: `grep -R` of a known canary value across logs/images fails the build if found |
