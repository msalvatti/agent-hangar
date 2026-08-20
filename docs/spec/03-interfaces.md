# 03 — Interface Contracts

All contracts live in `packages/core` and are framework-free. Everything below is TypeScript (strict, `exactOptionalPropertyTypes`), validated at runtime with Zod where data crosses a process boundary.

## 1. `WorkspaceRunner`

The only abstraction that knows how to run an isolated workspace. **One implementation ships: `DockerWorkspaceRunner` (dockerode).** A cloud runner (Fargate task, Firecracker micro-VM, Fly Machine) is a second implementation of this same interface — see [08 Deployment](08-deployment-discussion.md). Nothing outside `packages/core/src/runner/docker/` imports dockerode; an ESLint `no-restricted-imports` rule enforces it.

```ts
// packages/core/src/runner/types.ts

export interface WorkspaceSpec {
  /** Stable id from the Workspace row; used to name/label the container. */
  workspaceId: string;
  kind: 'CHAT' | 'JOB';
  /** Image reference (tag or digest). */
  image: string;
  /** Environment injected at start. Secrets arrive here and nowhere else. */
  env: Readonly<Record<string, string>>;
  /** Resource ceilings; the runner must enforce or reject. */
  limits: {
    cpus: number;          // e.g. 2
    memoryBytes: number;   // e.g. 2 GiB
    pids: number;          // e.g. 512
    diskBytes?: number;    // advisory on Docker Desktop
  };
  /** Labels for discovery/GC (instance name, chat id, job run id). */
  labels: Readonly<Record<string, string>>;
}

export interface WorkspaceHandle {
  workspaceId: string;
  /** Runner-specific reference (Docker container id, cloud task ARN, ...). Opaque to callers. */
  runnerRef: string;
}

export interface ExecSpec {
  cmd: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  /** Data written to stdin, then stdin is closed. Used for the agent protocol. */
  stdin?: AsyncIterable<Uint8Array> | Uint8Array | string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ExecEvent =
  | { type: 'stdout'; data: Uint8Array }
  | { type: 'stderr'; data: Uint8Array }
  | { type: 'exit'; code: number | null; signal?: string };

export interface WorkspaceSnapshot {
  takenAt: Date;
  git: {
    branch: string | null;
    headSha: string | null;
    dirty: boolean;
    ahead: number;   // commits not on origin/<branch>
    behind: number;
  };
  /** Short `git status --porcelain` + `git diff --stat`, truncated to 16 KB. */
  summary: string;
}

export type WorkspaceHealth =
  | { status: 'healthy'; uptimeMs: number }
  | { status: 'unhealthy'; reason: string }
  | { status: 'gone' };

export interface WorkspaceRunner {
  /** Human-readable runner id stored on Workspace.runnerKind ("docker"). */
  readonly kind: string;

  /** Create and start an isolated workspace. Resolves when the container accepts exec. */
  create(spec: WorkspaceSpec, opts?: { signal?: AbortSignal }): Promise<WorkspaceHandle>;

  /** Run a process inside the workspace and stream its output. Never throws on non-zero exit. */
  exec(handle: WorkspaceHandle, spec: ExecSpec): AsyncIterable<ExecEvent>;

  /** Deliver a signal to the main process of a previous exec (cancellation). */
  signal(handle: WorkspaceHandle, execRef: string, sig: 'INT' | 'TERM' | 'KILL'): Promise<void>;

  /** Read git state so it can be persisted before destroy (restore hints). */
  snapshot(handle: WorkspaceHandle): Promise<WorkspaceSnapshot>;

  /** Stop and remove the workspace and all its storage. Idempotent. */
  destroy(handle: WorkspaceHandle): Promise<void>;

  /** Liveness check; 'gone' means destroyed or never existed. */
  health(handle: WorkspaceHandle): Promise<WorkspaceHealth>;

  /** Enumerate workspaces created by this runner for a label selector (GC, doctor). */
  list(labels: Readonly<Record<string, string>>): Promise<WorkspaceHandle[]>;
}
```

`exec` returns an `AsyncIterable` plus a way to reference the execution for `signal`; concretely `exec` yields a first event `{ type: 'started', execRef }` — omitted above for brevity, included in code.

### `DockerWorkspaceRunner` behaviour (contract, not code)

- Socket resolution order: `DOCKER_HOST` → `~/.docker/run/docker.sock` → `/var/run/docker.sock`.
- Container: `--name ah-ws-<instance>-<workspaceId>`, `--user agent`, `--workdir /workspace`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit`, `--memory`, `--cpus`, tmpfs `/tmp`, no volumes, no Docker socket, bridge network (egress only). Labels: `ah.instance`, `ah.workspace`, `ah.kind`, `ah.chat|ah.jobRun`.
- `create` pulls/builds nothing: the image must exist (`pnpm infra:image`). Missing image → typed error `WorkspaceImageMissing` with the exact command to run.
- `exec` uses Docker exec with attached stdin, demuxes stdout/stderr, honours `timeoutMs` by sending `KILL` and yielding `exit { code: null, signal: 'TIMEOUT' }`.
- `destroy` = stop (10 s grace) + remove with volumes. 404 is success.
- `list` queries by labels; used by GC to reap orphans after a worker crash.

## 2. `AgentModelProvider`

The LLM boundary. **One implementation ships: `OpenAIModelProvider`** over the Responses API. Adding a provider means implementing this interface and registering it under a name; nothing else changes.

```ts
// packages/core/src/model/types.ts

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12); strict mode requested from the provider. */
  parameters: Record<string, unknown>;
}

export type ConversationItem =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; output: string };

export interface ModelTurnInput {
  model: string;
  instructions: string;            // system prompt
  items: readonly ConversationItem[];
  tools: readonly ToolDefinition[];
  // No provider-side continuation handle on purpose: every call carries the full
  // `items` list, so the provider stays stateless and `store: false` is always valid.
  reasoningEffort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export type ModelEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'text.done'; text: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string }  // emitted once args complete
  | { type: 'tool_call.arguments.delta'; callId: string; delta: string }
  | { type: 'response.done'; responseId: string; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; code: 'rate_limit' | 'auth' | 'context_length' | 'network' | 'unknown'; message: string; retryable: boolean };

export interface AgentModelProvider {
  readonly name: string;  // "openai"
  /** One model round-trip. Yields deltas; ends with response.done or error. */
  stream(input: ModelTurnInput): AsyncIterable<ModelEvent>;
  /** Used by doctor/settings to validate a key and model id. */
  listModels(): Promise<string[]>;
}
```

### `OpenAIModelProvider` mapping

| This interface | OpenAI Responses API |
|---|---|
| `stream()` | `client.responses.stream({ model, instructions, input, tools, store: false, reasoning })` |
| `ToolDefinition` | `{ type: 'function', name, description, parameters, strict: true }` |
| `tool_call` item | output item `function_call { call_id, name, arguments }` |
| `tool_result` item | input item `function_call_output { call_id, output }` |
| `text.delta` | `response.output_text.delta` |
| `tool_call.arguments.delta` | `response.function_call_arguments.delta` |
| `tool_call` | `response.output_item.done` with `item.type === 'function_call'` |
| `response.done` | `response.completed` (usage from `response.usage`) |
| `error` | `response.failed` / SDK `APIError` mapped by status (401 → auth, 429 → rate_limit, 400 context → context_length) |

Model id comes from `OPENAI_MODEL` (default `gpt-5.6-sol`). `store: false` is sent on every call so no conversation state is retained provider-side, and the full `items` list (history window + this turn's tool calls/results) is resent on every step. `previous_response_id` is deliberately **not** used: it requires `store: true` on the prior response, which would contradict the stateless, Postgres-owns-state model. The cost is input tokens per step, bounded by the history window in the restore-context builder.

## 3. Agent runtime protocol (host ↔ workspace)

The runtime (`packages/agent-runtime`, bundled into the image as `/opt/agent-runtime/cli.js`) is started per turn by the worker via `WorkspaceRunner.exec`:

```
node /opt/agent-runtime/cli.js turn
```

**Transport:** NDJSON. One `TurnRequest` object on stdin, then stdin closes. Events stream on stdout, one JSON object per line. stderr carries runtime diagnostics (redacted, forwarded to worker logs at debug level). Exit code 0 = turn completed (even if the agent's task failed), non-zero = runtime failure. Cancellation = `runner.signal(handle, execRef, 'INT')`; the runtime aborts the model stream and the current tool and emits `turn.cancelled`.

Secrets reach the runtime only through the container environment (`OPENAI_API_KEY`, `GITHUB_TOKEN`) — never through the protocol.

```ts
// packages/core/src/agent-protocol/types.ts  (shared by worker and runtime; Zod schemas alongside)

export interface TurnRequest {
  protocolVersion: 1;
  turnId: string;                  // Turn.id or JobRun.id
  model: string;
  instructions: string;            // system prompt, built host-side
  items: ConversationItem[];       // history window (see 02 §4)
  repo: {
    url: string;                   // credential-free https URL
    baseBranch: string;
    workBranch: string;            // branch the agent should commit to
    expectedHeadSha?: string;      // restore verification
  };
  limits: {
    maxSteps: number;              // model round-trips (default 40)
    maxTurnMs: number;             // wall clock (default 20 min; jobs 30 min)
    toolTimeoutMs: number;         // per run_shell (default 5 min)
    maxToolOutputBytes: number;    // per result sent to the model (default 32 KB)
  };
  /** Whether to clone first (fresh/restored workspace) or assume /workspace is ready. */
  prepare: { clone: boolean };
}

export type AgentEvent =
  | { type: 'turn.started'; turnId: string; at: string }
  | { type: 'prepare.progress'; message: string }                     // "Cloning…", "Checked out agent/x at abc123"
  | { type: 'prepare.done'; headSha: string; branch: string }
  | { type: 'step.started'; step: number }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.message'; text: string }                       // final text of a step
  | { type: 'tool.call'; callId: string; name: ToolName; args: unknown; seq: number }
  | { type: 'tool.output.delta'; callId: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'tool.result'; callId: string; exitCode: number | null; bytes: number; durationMs: number; status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' }
  | { type: 'git.pushed'; branch: string; sha: string }              // emitted when a push is detected
  | { type: 'heartbeat'; at: string }                                 // every 10 s while idle
  | { type: 'turn.completed'; usage: { inputTokens: number; outputTokens: number }; steps: number; finalMessage: string }
  | { type: 'turn.failed'; error: { code: string; message: string } }
  | { type: 'turn.cancelled' };

export type ToolName = 'run_shell' | 'read_file' | 'write_file' | 'list_dir';
```

**Tools exposed to the model (inside the container):**

| Tool | Args | Behaviour |
|---|---|---|
| `run_shell` | `{ command: string, cwd?: string, timeoutMs?: number }` | `bash -lc` in `/workspace`; env has `GIT_ASKPASS` helper (PAT never in the shell env or remote URL); output truncated to `maxToolOutputBytes` with a note; exit code returned. Git clone/commit/push happen through this tool. |
| `read_file` | `{ path: string, startLine?: number, endLine?: number }` | Path confined to `/workspace`; returns numbered lines. |
| `write_file` | `{ path: string, content: string }` | Confined to `/workspace`; creates directories; returns byte count. |
| `list_dir` | `{ path?: string, depth?: number }` | Confined; respects `.gitignore`; capped entries. |

**Loop:** `prepare` (clone/checkout if requested) → for `step < maxSteps`: `provider.stream()` → collect text + tool calls → execute tool calls sequentially, emitting events → append `tool_result` items → continue until the model returns no tool calls → `turn.completed`. Every `tool.call`/`tool.result` is redacted in the runtime **and** again in the worker before persistence (defence in depth).

## 4. HTTP API (`apps/web` route handlers)

All JSON; Zod-validated; errors `{ error: { code, message } }`.

| Method & path | Purpose |
|---|---|
| `GET /api/repos?query=` | List repos the PAT can access (GitHub API), for the picker |
| `GET /api/repos/branches?repo=` | Branches of a repo |
| `POST /api/chats` | `{ repoUrl, baseBranch, prompt }` → creates Chat + first Turn, enqueues |
| `GET /api/chats?status=` | Sidebar list |
| `GET /api/chats/:id` | Chat + messages + turns + tool calls |
| `PATCH /api/chats/:id` | `{ title }` → rename (title is editable inline in the chat header) |
| `POST /api/chats/:id/messages` | `{ prompt }` → new Turn, enqueues |
| `POST /api/chats/:id/archive` · `/restore` | Status change; archive destroys live workspace; restore creates on next message (or immediately if `?warm=1`) |
| `POST /api/turns/:id/cancel` | Stop a chat turn: remove the queued job, or signal INT via worker (through a Redis command channel) |
| `DELETE /api/chats/:id` | Cascade delete |
| `GET /api/chats/:id/events` | **SSE** — live `AgentEvent`s for the chat; supports `Last-Event-ID` |
| `GET /api/jobs` · `POST /api/jobs` · `PATCH /api/jobs/:id` · `DELETE /api/jobs/:id` | CRUD; upserts/removes the BullMQ Job Scheduler |
| `POST /api/jobs/:id/run` | Manual trigger → JobRun |
| `GET /api/jobs/:id/runs` · `GET /api/runs/:id` | Run history and detail (output, tool calls) |
| `GET /api/runs/:id/events` | **SSE** for a running job run |
| `POST /api/runs/:id/cancel` | Stop a job run; same two shapes as the turn cancel, addressed by `JobRun.id` |
| `GET /api/settings` | `{ githubPat: { set, last4 }, openaiKey: { set, last4 }, model }` |
| `PUT /api/settings/:key` · `DELETE /api/settings/:key` | Save (encrypts) / remove |
| `GET /api/health` | DB, Redis and worker reachability, Docker reachability, image present. Docker and the image are the worker's own readings, taken from its heartbeat, so a silent worker reports `worker: false` and leaves those two unknown rather than blaming the daemon; the worker check carries `lastSeenAt` when it is alive |

**SSE framing:** `id: <redis-stream-id>`, `event: <AgentEvent.type>`, `data: <json>`. Heartbeat comment `: ping` every 15 s. No compression. Reconnect replays from `Last-Event-ID` via `XRANGE` on `events:turn:<turnId>` (1 h TTL), then tails with `XREAD BLOCK`.

## 5. Queue contracts (BullMQ)

| Queue | Job name | Data | Producer → Consumer |
|---|---|---|---|
| `chat-turns` | `run-turn` | `{ turnId }` | web → worker. Concurrency `WORKER_TURN_CONCURRENCY` (default 2). `jobId = turnId` for idempotency. |
| `scheduled-jobs` | `run-scheduled-job` | `{ jobId }` | Job Scheduler (`upsertJobScheduler(jobId, { pattern: cron, tz }, …)`) → worker. Also `POST /run` adds a one-off job with `trigger: MANUAL`. |
| `workspace-gc` | `reap-idle` | `{}` | Job Scheduler every 5 min → worker: destroy `READY` workspaces idle > `WORKSPACE_IDLE_TTL_MIN`; reconcile orphan containers via `runner.list()`. |

Worker connections use `maxRetriesPerRequest: null` (required by BullMQ workers); queue producers use defaults. Scheduler keys equal `ScheduledJob.id`; the worker reconciles DB ↔ schedulers on boot.

## 6. Secrets service

```ts
export interface SecretsService {
  set(key: SecretKey, plaintext: string): Promise<{ last4: string }>;
  remove(key: SecretKey): Promise<void>;
  status(): Promise<Record<SecretKey, { set: boolean; last4?: string; updatedAt?: Date }>>;
  /** Worker-only: decrypt for injection. Never called from apps/web. */
  reveal(key: SecretKey): Promise<string | null>;
}

export interface Redactor {
  /** Registers live secret values (called by worker after reveal) and applies shape-based patterns. */
  redact(input: string): string;
  redactJson(input: unknown): unknown;
}
```

Shape patterns always active: `ghp_[A-Za-z0-9]{36}`, `github_pat_[A-Za-z0-9_]{22,}`, `sk-[A-Za-z0-9_-]{20,}`, `sk-proj-[A-Za-z0-9_-]{20,}`, `Authorization: Bearer …`. Replacement token: `[REDACTED]`.
