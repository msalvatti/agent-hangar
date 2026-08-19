# Wave 1 — Lane W1-C: OpenAIModelProvider, registry, fixtures (core)

| | |
|---|---|
| **Lane** | W1-C (Wave 1, parallel with W1-A … W1-I) |
| **Status** | 🟦 running |
| **Progress** | 3/5 tasks |
| **Branch** | `feat/w1c-openai-provider` |
| **Owned paths** | `packages/core/src/model/openai/**`, `packages/core/src/model/registry.ts` (+ `registry.test.ts`), `packages/core/fixtures/openai/**`, `packages/core/scripts/record-fixtures.ts` — plus three append-only exceptions: `packages/core/vitest.config.ts` (`coverage.include` only), (the root `packages/core/src/index.ts` is frozen — it already re-exports `./model/index.js`; this lane adds exports only to `packages/core/src/model/index.ts` and `model/openai/index.ts`), `packages/core/package.json` (one script `fixtures:record` only) |
| **Depends on** | W0 merged to `main` |
| **Unblocks** | W2-B (worker builds the provider via the registry; agent-runtime W1-D consumes the same provider through core) |
| **Source** | [docs/plan.md §6 W1-C](../plan.md) · spec [03 §2](../spec/03-interfaces.md) · [06 §2](../spec/06-testing.md) (model/openai) · [06 §7](../spec/06-testing.md) (recorded fixtures) |
| **Last updated** | 2026-08-19 |

## Context

W0 froze `AgentModelProvider`, `ModelTurnInput`, `ModelEvent`, `ToolDefinition`, `ConversationItem` in `packages/core/src/model/types.ts`, left `packages/core/src/model/openai/` empty (`.gitkeep`), shipped `FakeAgentModelProvider` in `packages/core/src/testing/`, the `openai` SDK 7.x in `packages/core` dependencies, and `ConfigError`/`AgentHangarError` in `errors.ts`. This lane implements the only real provider — `OpenAIModelProvider` over the Responses API streaming endpoint (`client.responses.stream`) — the pure mapping layer (request params, stream events → `ModelEvent`, SDK errors → `ModelEvent.error`), a fake SDK client that replays NDJSON fixtures, the registry `createModelProvider(name, deps)` that returns the OpenAI provider or the fake, and a manual recording script for fixtures.

Spec 03 §2 lists the event mapping. The SDK's event names must be **verified at build time** against the installed `openai` package types (`ResponseStreamEvent` union) and the official docs; any difference from the spec table is recorded in the PR body under "API verification" and reflected in `mapping.ts` JSDoc. The provider is the only place that changes if OpenAI renames an event.

## Rules of this lane

1. Edit only the owned paths. `model/types.ts`, `errors.ts`, `testing/**` are frozen — a needed change becomes a `contractChangeRequests[]` entry in the PR summary.
2. No new dependencies (`openai` is installed; `tsx` at the root runs the script). Stop and report if something is missing.
3. Extend `packages/core/vitest.config.ts` `coverage.include` with `src/model/openai/**` and `src/model/registry.ts`. Thresholds stay 100/100/100/100. Fixtures under `packages/core/fixtures/` are data, not coverage.
4. No `enum`, no suppression comments, JSDoc on every export + file header, test header + block comment on every `it()`, English only.
5. Fixtures and tests never contain real-looking secrets; any `Authorization`/`api_key` material in recorded data is replaced with canaries or removed by the record script. Use `OPENAI_CANARY` from `@agent-hangar/core/testing` where a key value is needed in tests.
6. The `openai` SDK is imported at runtime only inside `src/model/openai/**`; `mapping.ts` imports SDK **types** only, so it stays pure and mutation-testable (spec 06 §5 lists `src/model/openai/mapping.ts`).
7. Conventional Commits, English, no AI-attribution trailers. Branch `feat/w1c-openai-provider`, one PR at the end (Task 1C.5).

## Reference docs

- [docs/plan.md](../plan.md) § "3. Parallelism rules", § "6. Wave 1" (W1-C), § "11", § "12"
- [spec 03 — Interface contracts](../spec/03-interfaces.md) § "2. AgentModelProvider" incl. the "OpenAIModelProvider mapping" table
- [spec 04 — Flows](../spec/04-flows.md) § "(a)" edge cases (401 → auth, 429 retried by the runtime — not by the SDK)
- [spec 06 — Testing](../spec/06-testing.md) § "2. Unit tests" → `model/openai/`, § "7. Test doubles" (recorded fixtures)
- Contract files: `packages/core/src/model/types.ts`, `packages/core/src/errors.ts`, `packages/core/src/testing/{fake-agent-model-provider,canaries,index}.ts`, `packages/core/src/config/schema.ts` (`AGENT_MODEL_PROVIDER`, `OPENAI_MODEL`, `OPENAI_BASE_URL`)
- Installed SDK types: `node_modules/openai/resources/responses/responses.d.ts` (or `.d.mts`), `node_modules/openai/core/error.d.ts`, `node_modules/openai/lib/responses/ResponseStream.d.ts` (paths may differ by SDK minor — locate with `find node_modules/openai -name 'responses.d.*ts'`)

## Task index

| ID | Task | Status | Priority | Size | Depends on |
|---|---|---|---|---|---|
| 1C.1 | Pure mapping: request params, stream events → `ModelEvent`, SDK errors → `ModelEvent.error` (verified against SDK types) | ✅ | P0 | M | — |
| 1C.2 | Fixtures (`fixtures/openai/*.ndjson`), fixture loader, fake SDK client, record script | ✅ | P0 | M | 1C.1 |
| 1C.3 | `OpenAIModelProvider` (`stream`, `listModels`) + SDK client factory | ✅ | P0 | M | 1C.1, 1C.2 |
| 1C.4 | Registry `createModelProvider(name, deps)` → openai \| fake; barrel exports | 📋 | P0 | S | 1C.3 |
| 1C.5 | Close-out: gates, code review, dashboard, PR | 📋 | P0 | S | 1C.1–1C.4 |

---

## Task 1C.1 — Pure mapping: request params, stream events, errors

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** —

**Description.** Implement `packages/core/src/model/openai/mapping.ts`: `toResponseParams(input)` (tools with `strict: true`, items → Responses input items, `store: false` always, optional `reasoning`; no `previous_response_id` — the provider is stateless, see spec 03 §2), a stateful `createEventMapper()` that turns each SDK `ResponseStreamEvent` into zero or more `ModelEvent`s (tracking `item_id → call_id`), and `mapErrorToModelEvent(err)` for thrown SDK errors. Event names are verified against the installed SDK types and recorded.

**Acceptance criteria**
- [x] `toResponseParams` output: `{ model, instructions, input, tools, store: false, ...(reasoning: { effort }) }`; no `undefined`-valued keys (`exactOptionalPropertyTypes`); `ToolDefinition` → `{ type: 'function', name, description, parameters, strict: true }`; items mapped per the spec table
- [x] Event mapping covers: `response.output_text.delta` → `text.delta`; `response.output_text.done` → `text.done`; `response.output_item.added` (function_call) registers `item.id → item.call_id`; `response.function_call_arguments.delta` → `tool_call.arguments.delta` with the resolved `callId`; `response.output_item.done` (function_call) → `tool_call { callId, name, arguments }`; `response.completed` → `response.done { responseId, usage }`; `response.incomplete` → `response.done`; `response.failed` → `error`; stream `error` event → `error`; `response.refusal.delta/done` → `text.delta`/`text.done`; every other event → `[]`
- [x] `mapErrorToModelEvent`: 401/403 → `auth` (non-retryable); 429 → `rate_limit` (retryable); 400 with context-length code/message → `context_length`; other 4xx → `unknown` non-retryable; 5xx → `unknown` retryable; `APIConnectionError`/`APIConnectionTimeoutError`/`TypeError: fetch failed` → `network` retryable; `AbortError` → `null` (caller ends the stream silently); anything else → `unknown` non-retryable; messages never include request bodies or headers
- [x] `VERIFIED_EVENT_TYPES` constant lists every event type string consumed, typed as `ResponseStreamEvent['type']` so a rename fails `tsc`; file header records the SDK version verified
- [x] 100 % coverage on `mapping.ts`

**Files to create**
`packages/core/src/model/openai/mapping.ts`, `packages/core/src/model/openai/mapping.test.ts` (remove `packages/core/src/model/openai/.gitkeep`); modify `packages/core/vitest.config.ts` (`coverage.include` += `src/model/openai/**`, `src/model/registry.ts`).

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core is framework-free; `openai` SDK 7.x installed (Responses API, `client.responses.stream`). Vitest 4 with @vitest/coverage-v8.
Branch feat/w1c-openai-provider (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-C (OpenAIModelProvider) — Task 1C.1 of 5 (FIRST)

PRECONDITIONS
- W0 merged to main; branch off latest main; contracts exist at packages/core/src/model/types.ts (AgentModelProvider, ModelTurnInput, ModelEvent, ToolDefinition, ConversationItem), errors.ts, testing/* (FakeAgentModelProvider, canaries). `packages/core/src/model/openai/` contains only `.gitkeep`.
- `pnpm install --frozen-lockfile && pnpm typecheck` green on main.

REQUIRED READING (only these):
- CLAUDE.md (root)
- packages/core/src/model/types.ts (implement against these names verbatim)
- docs/spec/03-interfaces.md § "2. AgentModelProvider" (mapping table + the `store:false` paragraph explaining why `previous_response_id` is not used)
- docs/spec/04-flows.md § "(a)" edge cases (401/429 lines)
- Installed SDK types: the `ResponseStreamEvent` union and its members, `ResponseCreateParams`, `Tool`/`FunctionTool`, `ResponseInputItem` (`function_call`, `function_call_output`, `EasyInputMessage`), `ResponseUsage`, `ResponseFunctionToolCall`; `APIError`, `APIConnectionError`, `APIConnectionTimeoutError`, `APIUserAbortError` from `openai` (check `openai/core/error` or the root export). Then the official Responses API streaming reference for the same names.

TASK
Write the pure mapping layer between `AgentModelProvider` types and the OpenAI Responses API, verified against the installed SDK, so the provider (1C.3) is a thin loop around it.

DELIVERABLES

1. VERIFY FIRST. Run `node -e "console.log(require('openai/package.json').version)"` inside packages/core and open the `ResponseStreamEvent` union. Confirm these type strings exist exactly: `response.output_text.delta`, `response.output_text.done`, `response.output_item.added`, `response.output_item.done`, `response.function_call_arguments.delta`, `response.function_call_arguments.done`, `response.completed`, `response.incomplete`, `response.failed`, `response.refusal.delta`, `response.refusal.done`, `error`. Write the verified list into `export const VERIFIED_EVENT_TYPES = [...] as const satisfies readonly ResponseStreamEvent['type'][]` so a future SDK rename fails typecheck. If any name differs from the spec table, use the SDK's name and record the difference in the file header AND later in the PR body ("API verification" section). Also confirm: `response.completed` carries `response.id` and `response.usage.{input_tokens,output_tokens}`; function-call items expose `id`, `call_id`, `name`, `arguments`; `response.function_call_arguments.delta` carries `item_id` and `delta`.
2. `packages/core/src/model/openai/mapping.ts` (SDK **types** only — `import type { … } from 'openai/resources/responses/responses'` or the root `openai` type exports; no runtime import):
   ```ts
   export function toResponseParams(input: ModelTurnInput): ResponseCreateParamsStreaming   // or ResponseCreateParams & { stream: true } — whichever the installed SDK names
   export function toResponseTool(tool: ToolDefinition): FunctionTool                        // { type: 'function', name, description, parameters, strict: true }
   export function toResponseInputItem(item: ConversationItem): ResponseInputItem
   export interface EventMapper { map(event: ResponseStreamEvent): ModelEvent[]; readonly sawTerminal: boolean }
   export function createEventMapper(): EventMapper
   export function mapErrorToModelEvent(err: unknown): Extract<ModelEvent, { type: 'error' }> | null
   export function usageFromResponse(usage: ResponseUsage | null | undefined): { inputTokens: number; outputTokens: number }
   ```
   - `toResponseParams`: `model: input.model` (the model id comes from the input only — config is the caller's business), `instructions: input.instructions`, `input: input.items.map(toResponseInputItem)`, `tools: input.tools.map(toResponseTool)`, `store: false`, `stream: true` (if the param type needs it), `reasoning: { effort: input.reasoningEffort }` ONLY when defined. Build with conditional spreads — never assign `undefined` to an optional key. Never send `previous_response_id`: it requires `store: true` on the prior response, and this provider is stateless by design (the caller resends the full `items` list every step). JSDoc MUST state this.
   - `toResponseInputItem`: `{ role, content }` → `{ role, content }` (EasyInputMessage; role `system` stays `system`); `tool_call` → `{ type: 'function_call', call_id, name, arguments }`; `tool_result` → `{ type: 'function_call_output', call_id, output }`. Exhaustive `switch` with a `never` default helper `assertNever(x: never): never`.
   - `createEventMapper()`: state `itemIdToCallId = new Map<string, string>()`, `sawTerminal = false`. `map(event)` switch on `event.type`:
     - `response.output_text.delta` → `[{ type: 'text.delta', text: event.delta }]`
     - `response.output_text.done` → `[{ type: 'text.done', text: event.text }]`
     - `response.refusal.delta` → `text.delta` with `event.delta`; `response.refusal.done` → `text.done` with `event.refusal`
     - `response.output_item.added` with `event.item.type === 'function_call'` → register `event.item.id → event.item.call_id` (both present per SDK types; if `id` is optional, fall back to `call_id`) → `[]`
     - `response.function_call_arguments.delta` → `[{ type: 'tool_call.arguments.delta', callId: resolve(event.item_id), delta: event.delta }]` where `resolve` returns the mapped `call_id` or, when unknown, the raw `item_id` (documented fallback)
     - `response.output_item.done` with `item.type === 'function_call'` → `[{ type: 'tool_call', callId: item.call_id, name: item.name, arguments: item.arguments }]`; other item types → `[]`
     - `response.completed` → `sawTerminal = true`; `[{ type: 'response.done', responseId: event.response.id, usage: usageFromResponse(event.response.usage) }]`
     - `response.incomplete` → same as completed (the step ended; reason such as `max_output_tokens` is logged by the caller) — `sawTerminal = true`
     - `response.failed` → `sawTerminal = true`; `[{ type: 'error', code: codeFromApiErrorCode(event.response.error?.code), message: event.response.error?.message ?? 'response failed', retryable }]` where `rate_limit_exceeded` → `rate_limit`/true, `server_error` → `unknown`/true, `invalid_prompt` → `unknown`/false, else `unknown`/false
     - `error` (stream-level) → `sawTerminal = true`; `[{ type: 'error', code: 'unknown', message: event.message ?? 'stream error', retryable: false }]`
     - default → `[]`
   - `usageFromResponse`: null/undefined → `{ inputTokens: 0, outputTokens: 0 }`.
   - `mapErrorToModelEvent(err)`: order of checks — (1) `APIUserAbortError` or `err.name === 'AbortError'` → `null`; (2) `APIConnectionTimeoutError`/`APIConnectionError` (instanceof) or `err instanceof TypeError && /fetch failed/i.test(message)` → `network`, retryable true; (3) `APIError` (instanceof) → by `status`: 401/403 → `auth` false; 429 → `rate_limit` true; 400 with (`code === 'context_length_exceeded'` || /context length|maximum context|too many tokens/i on message) → `context_length` false; other 4xx → `unknown` false; ≥ 500 → `unknown` true; (4) `Error` → `unknown` false with `err.message`; (5) anything else → `unknown` false, message `'unknown error'`. Messages: use the SDK error `message` only (never `headers`, never request bodies).
3. `packages/core/src/model/openai/mapping.test.ts`: one it() per bullet above plus: `toResponseParams` omits `reasoning` when absent and includes it when present, and never contains a `previous_response_id` key (`Object.keys` assertions); `store === false` always; tools carry `strict: true`; items of all three kinds; `assertNever` path via an impossible item cast through `unknown`; arguments-delta before any `output_item.added` falls back to the raw item id; two interleaved function calls resolve to the right `call_id`s; `sawTerminal` false → true on completed/incomplete/failed/error; `usageFromResponse(null)`; every `mapErrorToModelEvent` branch (construct SDK errors with their real constructors — `new APIError(429, { message: 'x' }, 'x', new Headers())` — check the installed constructor signature; if constructing is awkward, `Object.create(APIError.prototype)` with `status` set is acceptable and documented); unknown SDK event type (`{ type: 'response.something.new' } as unknown as ResponseStreamEvent`) → `[]`.
4. `packages/core/vitest.config.ts`: add `'src/model/openai/**'` and `'src/model/registry.ts'` to `coverage.include`. Delete `src/model/openai/.gitkeep`.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- `mapping.ts` has zero runtime imports from `openai` (types only) — it is mutation-tested later and must not load the SDK.
- Do not modify `model/types.ts`.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green; 100 % on `src/model/openai/mapping.ts`
- `pnpm typecheck && pnpm lint` — exit 0
- `grep -n "from 'openai" packages/core/src/model/openai/mapping.ts` — every line is `import type`

Completion Protocol (after you finish):
1. Update this task's status emoji to ✅ in docs/tasks/wave-1c-openai-provider.md (task block and task index row)
2. Tick its acceptance-criteria checkboxes
3. Increment the lane progress counter in the header (`N/5 tasks`)
4. Append a completion log entry at the end of the file: `- 1C.1 ✅ <YYYY-MM-DD> — <one-line summary incl. SDK version verified>`
5. Commit: `feat(core): add OpenAI Responses API mapping layer`
````

---

## Task 1C.2 — Fixtures, fixture loader, fake SDK client, record script

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 1C.1

**Description.** Create the recorded-style NDJSON fixtures (synthetic, shaped exactly like real `ResponseStreamEvent`s, redacted), a loader, a fake SDK client (`createFakeOpenAIClient`) that replays fixtures or throws configured errors and records calls, and the manual `record-fixtures.ts` script that captures real streams with a real key and redacts them.

**Acceptance criteria**
- [x] `packages/core/fixtures/openai/{text,tool-call,text-and-tool-call,refusal,failed,incomplete,error-event}.ndjson` exist; each line parses as JSON with a `type` that is a member of the SDK union (a test asserts this for every file); ids look real (`resp_…`, `msg_…`, `fc_…`, `call_…`) but are synthetic; no secrets (`assertNoCanary` + shape grep pass)
- [x] `loadOpenAIFixture(name)` resolves the path relative to the module (`../../../fixtures/openai/`) so it works from `src/` and `dist/`; throws a readable error for an unknown name
- [x] `createFakeOpenAIClient(options)` satisfies the `OpenAIResponsesClient` interface (structural subset of the SDK client used by the provider); records `calls.stream[]` params and options; can yield events with optional per-event delay, throw before the first event, throw mid-stream, honour `signal` abort (stops yielding, throws `APIUserAbortError`-shaped error if configured), and serve `models.list()` from a configured id list or throw
- [x] `packages/core/scripts/record-fixtures.ts` runs with `OPENAI_API_KEY` set, writes raw events to the fixture files after redaction, refuses to run without a key, never prints the key; documented in `packages/core/fixtures/openai/README.md`; `pnpm --filter @agent-hangar/core fixtures:record` script wired
- [x] 100 % coverage on `src/model/openai/{fixtures,fake-client}.ts`

**Files to create**
`packages/core/fixtures/openai/*.ndjson`, `packages/core/fixtures/openai/README.md`, `packages/core/src/model/openai/fixtures.ts`, `packages/core/src/model/openai/fixtures.test.ts`, `packages/core/src/model/openai/client.ts` (interface `OpenAIResponsesClient` — implementation factory added in 1C.3), `packages/core/src/model/openai/fake-client.ts`, `packages/core/src/model/openai/fake-client.test.ts`, `packages/core/scripts/record-fixtures.ts`; modify `packages/core/package.json` (script `fixtures:record`).

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core; `openai` SDK 7.x; `tsx` available from the root devDependencies. Vitest 4 with @vitest/coverage-v8.
Branch feat/w1c-openai-provider (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-C (OpenAIModelProvider) — Task 1C.2 of 5 (MIDDLE)

PRECONDITIONS
- W0 merged to main; branch off latest main; contracts exist at packages/core/src/model/types.ts, errors.ts, secrets/types.ts (SECRET_SHAPE_PATTERNS), testing/* (canaries).
- Task 1C.1 done: `mapping.ts` with `VERIFIED_EVENT_TYPES`.

REQUIRED READING (only these):
- packages/core/src/model/openai/mapping.ts (your verified event names and the fields each event needs)
- packages/core/src/secrets/types.ts (SECRET_SHAPE_PATTERNS — used by the record script for redaction; W1-A's Redactor is not merged yet, do not depend on it)
- packages/core/src/testing/canaries.ts
- docs/spec/06-testing.md § "2. Unit tests" → `model/openai/` and § "7. Test doubles" (fixtures bullet)
- Installed SDK: `ResponseStream` (return type of `client.responses.stream`), `client.models.list()` return type (async-iterable page), `APIUserAbortError`

TASK
Provide the data and the fake SDK client the provider tests (1C.3) and future worker tests replay, plus the script that re-records fixtures from the real API.

DELIVERABLES

1. `packages/core/src/model/openai/client.ts` — the narrow structural interface the provider depends on (the real SDK client must be assignable to it; verify with a type-only test in 1C.3):
   ```ts
   export interface OpenAIStreamOptions { signal?: AbortSignal }
   export interface OpenAIResponsesClient {
     responses: { stream(params: ResponseCreateParamsStreaming, options?: OpenAIStreamOptions): AsyncIterable<ResponseStreamEvent> };
     models: { list(): AsyncIterable<{ id: string }> };
   }
   ```
   (Adjust the param type name to whatever 1C.1 used. If the SDK's `PagePromise` is not directly assignable to `AsyncIterable<{ id: string }>`, widen the interface minimally and document why.)
2. Fixtures — `packages/core/fixtures/openai/<name>.ndjson`, one SDK event per line, in realistic order with `sequence_number` increasing from 0, realistic ids (`resp_` + 24 hex-ish chars, `msg_…`, `fc_…`, `call_…`), `model: 'gpt-5.6-sol'`, `created_at` epoch seconds, `status` values as the API sends them:
   - `text.ndjson`: `response.created` → `response.in_progress` → `response.output_item.added` (message) → `response.content_part.added` → 3 × `response.output_text.delta` ("Hello", ", ", "world.") → `response.output_text.done` ("Hello, world.") → `response.content_part.done` → `response.output_item.done` (message) → `response.completed` with `usage: { input_tokens: 120, output_tokens: 18, total_tokens: 138 }`.
   - `tool-call.ndjson`: created → in_progress → `output_item.added` (function_call `{ id: 'fc_…', call_id: 'call_…', name: 'run_shell', arguments: '', status: 'in_progress' }`) → 3 × `function_call_arguments.delta` (`{"command"`, `: "ls -la"`, `}`) → `function_call_arguments.done` (`{"command": "ls -la"}`) → `output_item.done` (function_call with full arguments, status completed) → `completed` with usage.
   - `text-and-tool-call.ndjson`: text deltas for a short message ("Let me check.") then a function_call item (`write_file` with arguments `{"path":"NOTES.md","content":"hi"}`), then completed.
   - `refusal.ndjson`: output_item.added (message) → content_part.added (refusal) → 2 × `response.refusal.delta` → `response.refusal.done` → completed.
   - `failed.ndjson`: created → `response.failed` with `response.error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for requests' }`.
   - `incomplete.ndjson`: created → text deltas → `response.incomplete` with `incomplete_details: { reason: 'max_output_tokens' }` and usage.
   - `error-event.ndjson`: created → `{ type: 'error', code: 'server_error', message: 'The server had an error', param: null, sequence_number: 1 }`.
   Build the exact object shapes from the SDK types (every required field present) — write them by hand or generate once with a small throwaway script; they must round-trip `JSON.parse` and, per file, a test asserts each `type` ∈ the SDK union (compare against a `Set` built from `VERIFIED_EVENT_TYPES` plus the lifecycle events used: `response.created`, `response.in_progress`, `response.content_part.added/done`).
3. `packages/core/src/model/openai/fixtures.ts`
   ```ts
   export const OPENAI_FIXTURE_NAMES = ['text','tool-call','text-and-tool-call','refusal','failed','incomplete','error-event'] as const;
   export type OpenAIFixtureName = (typeof OPENAI_FIXTURE_NAMES)[number];
   export function openAIFixturesDir(): string                      // fileURLToPath(new URL('../../../fixtures/openai/', import.meta.url))
   export async function loadOpenAIFixture(name: OpenAIFixtureName): Promise<ResponseStreamEvent[]>   // readFile + split on '\n' + skip blank + JSON.parse; unknown name → Error listing valid names
   ```
4. `packages/core/src/model/openai/fake-client.ts`
   ```ts
   export interface FakeOpenAIClientOptions {
     events?: readonly ResponseStreamEvent[] | (() => readonly ResponseStreamEvent[]);   // per stream() call
     delayMs?: number;              // between events (use setTimeout; tests use fake timers)
     throwBeforeStream?: unknown;   // thrown synchronously-in-promise by stream()
     throwAfterEvents?: { count: number; error: unknown };  // throw while iterating after N events
     models?: readonly string[];    // default ['gpt-5.6-sol','gpt-5.6-mini']
     throwOnListModels?: unknown;
   }
   export interface FakeOpenAIClient extends OpenAIResponsesClient { readonly calls: { stream: Array<{ params: ResponseCreateParamsStreaming; options: OpenAIStreamOptions | undefined }>; listModels: number } }
   export function createFakeOpenAIClient(options?: FakeOpenAIClientOptions): FakeOpenAIClient
   ```
   `stream()` returns an object that is `AsyncIterable<ResponseStreamEvent>`; iteration checks `options.signal?.aborted` before each event and throws an `APIUserAbortError` (construct the real SDK class if its constructor is public; otherwise an `Error` with `name = 'AbortError'` — the mapper handles both) when aborted; `signal.addEventListener('abort')` wakes a pending delay.
5. `packages/core/scripts/record-fixtures.ts` (run with `tsx`): requires `OPENAI_API_KEY` (exit 1 with a message if missing; never print it), optional `OPENAI_MODEL`/`OPENAI_BASE_URL`; creates the real client; for each of three prompts (plain text; a forced tool call via `tool_choice: { type: 'function', name: 'run_shell' }` with the `run_shell` tool definition; a prompt likely to be refused — best effort, documented) streams with `store: false`, collects raw events, redacts every string value against `SECRET_SHAPE_PATTERNS` and the literal key (split/join), writes `fixtures/openai/recorded-<name>.ndjson` (NOT overwriting the hand-built fixtures — the developer diffs shapes and updates by hand), prints a summary (event counts, no content). `packages/core/package.json`: `"fixtures:record": "tsx scripts/record-fixtures.ts"`. Exclude `scripts/**` from coverage (not under `src/`, so it already is) and from `tsc -b` rootDir if needed (`tsconfig.json` `include` is `src` — leave the script outside the build; run it with tsx only).
6. `packages/core/fixtures/openai/README.md`: what each file is, how it was produced (hand-built from SDK types, verified against `openai@<version>`), how to re-record (`OPENAI_API_KEY=… pnpm --filter @agent-hangar/core fixtures:record`), the redaction rule, and that fixture content is synthetic.
7. Tests: `fixtures.test.ts` (every name loads; every event has a `type` in the allowed set and a numeric `sequence_number`; unknown name throws; `assertNoCanary` on each file; no `sk-`/`ghp_` shapes via `SECRET_SHAPE_PATTERNS`); `fake-client.test.ts` (replays events in order; records params/options; `delayMs` with `vi.useFakeTimers()`; throwBeforeStream; throwAfterEvents at the right index; abort before first event and mid-stream; `models.list()` iterates ids; `throwOnListModels`; `events` as a function is called per `stream()`).

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- No new dependencies. The record script may use the real SDK; everything under `src/` stays SDK-type-only except 1C.3's client factory.
- Fixture files contain no real ids, no keys, no personal data.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green; 100 % on `src/model/openai/fixtures.ts` and `fake-client.ts`
- `pnpm typecheck && pnpm lint` — exit 0
- `OPENAI_API_KEY= pnpm --filter @agent-hangar/core fixtures:record` — exits 1 with "OPENAI_API_KEY is required" (no network)

Completion Protocol: update status/AC/progress in docs/tasks/wave-1c-openai-provider.md; append `- 1C.2 ✅ <date> — <summary>`; commit `test(core): add OpenAI stream fixtures, fake SDK client and record script`.
````

---

## Task 1C.3 — `OpenAIModelProvider` (`stream`, `listModels`) + SDK client factory

**Status:** ✅ Done · **Priority:** P0 · **Size:** M · **Depends on:** 1C.1, 1C.2

**Description.** Implement `OpenAIModelProvider implements AgentModelProvider` over an injected `OpenAIResponsesClient`: `stream()` builds params via `toResponseParams`, iterates `client.responses.stream(params, { signal })`, maps events, guarantees exactly one terminal event (`response.done` or `error`) unless aborted, and `listModels()` returns sorted ids or throws `ModelProviderError`. Plus `createOpenAIClient({ apiKey, baseURL })` wrapping the real SDK with `maxRetries: 0`.

**Acceptance criteria**
- [x] `createOpenAIModelProvider({ client })` / `class OpenAIModelProvider` with `name = 'openai'`; `stream` yields mapped events for every fixture (`text`, `tool-call`, `text-and-tool-call`, `refusal`, `failed`, `incomplete`, `error-event`) matching exact expected `ModelEvent[]` sequences
- [x] `store: false` is in every request; `model` equals `input.model`; no `previous_response_id` key ever; `signal` forwarded to the SDK call
- [x] Thrown SDK errors before/mid-stream become one `error` event (mapped) and the iterable ends; a stream that ends without a terminal event yields `error { code: 'unknown', message: 'stream ended without completion', retryable: true }`; abort ends the stream silently (no error event)
- [x] `listModels()` → ids sorted ascending; SDK error → `ModelProviderError` (`code: 'MODEL_PROVIDER_ERROR'`, `modelErrorCode`, `retryable`)
- [x] `createOpenAIClient({ apiKey, baseURL? })` returns `new OpenAI({ apiKey, baseURL, maxRetries: 0 })` (retries belong to the agent-runtime per spec 04) and is assignable to `OpenAIResponsesClient` (type-level test); unit test mocks the `openai` module with `vi.mock` and asserts the constructor options
- [x] 100 % coverage on `provider.ts`, `client.ts`, `errors.ts`

**Files to create**
`packages/core/src/model/openai/provider.ts`, `packages/core/src/model/openai/provider.test.ts`, `packages/core/src/model/openai/errors.ts`, `packages/core/src/model/openai/client.test.ts`, `packages/core/src/model/openai/index.ts`; modify `packages/core/src/model/openai/client.ts` (add `createOpenAIClient`).

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core; `openai` SDK 7.x. Vitest 4 with @vitest/coverage-v8.
Branch feat/w1c-openai-provider (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-C (OpenAIModelProvider) — Task 1C.3 of 5 (MIDDLE)

PRECONDITIONS
- W0 merged to main; branch off latest main; contracts exist at packages/core/src/model/types.ts, errors.ts (AgentHangarError), testing/*.
- Tasks 1C.1 (mapping) and 1C.2 (fixtures, fake client, `OpenAIResponsesClient` interface) done.

REQUIRED READING (only these):
- packages/core/src/model/types.ts (AgentModelProvider — implement verbatim)
- packages/core/src/model/openai/{mapping,client,fake-client,fixtures}.ts (your own APIs)
- packages/core/src/errors.ts (AgentHangarError subclass pattern)
- docs/spec/03-interfaces.md § "2" (provider contract: "Yields deltas; ends with response.done or error")
- docs/spec/04-flows.md § "(a)" edge cases (429 retried by the runtime with backoff — therefore SDK `maxRetries: 0`)
- Installed SDK: `OpenAI` constructor options (`apiKey`, `baseURL`, `maxRetries`, `timeout`), `client.responses.stream` signature (params, RequestOptions with `signal`), `client.models.list()`

TASK
Implement the provider and the real-client factory so the worker/runtime can stream one model step and list models, with error handling that never leaks and never hangs.

DELIVERABLES

1. `packages/core/src/model/openai/errors.ts`
   ```ts
   export type ModelErrorCode = Extract<ModelEvent, { type: 'error' }>['code'];
   export class ModelProviderError extends AgentHangarError {
     readonly code = 'MODEL_PROVIDER_ERROR';
     constructor(readonly modelErrorCode: ModelErrorCode, message: string, readonly retryable: boolean, options?: ErrorOptions)
   }
   ```
2. `packages/core/src/model/openai/provider.ts`
   ```ts
   export interface OpenAIModelProviderOptions { client: OpenAIResponsesClient }
   export class OpenAIModelProvider implements AgentModelProvider {
     readonly name = 'openai';
     constructor(options: OpenAIModelProviderOptions)
     stream(input: ModelTurnInput): AsyncIterable<ModelEvent>
     listModels(): Promise<string[]>
   }
   export function createOpenAIModelProvider(options: OpenAIModelProviderOptions): OpenAIModelProvider
   ```
   - `stream` is an `async *` generator: `const params = toResponseParams(input); const mapper = createEventMapper();` then `try { for await (const ev of client.responses.stream(params, input.signal ? { signal: input.signal } : undefined)) { for (const m of mapper.map(ev)) yield m; if (mapper.sawTerminal) return; } } catch (err) { const mapped = mapErrorToModelEvent(err); if (mapped) yield mapped; return; }` and after the loop: `if (!mapper.sawTerminal) { if (input.signal?.aborted) return; yield { type: 'error', code: 'unknown', message: 'stream ended without completion', retryable: true }; }`. Guarantee: at most one terminal event; nothing after it. Never log. Never include `params` in errors.
   - `listModels`: `const ids: string[] = []; try { for await (const m of client.models.list()) ids.push(m.id); } catch (err) { const mapped = mapErrorToModelEvent(err) ?? { code: 'unknown', message: 'model listing aborted', retryable: false }; throw new ModelProviderError(mapped.code, mapped.message, mapped.retryable, { cause: err }); } return ids.sort();`
3. `packages/core/src/model/openai/client.ts` — add `export function createOpenAIClient(options: { apiKey: string; baseURL?: string }): OpenAIResponsesClient` returning `new OpenAI({ apiKey, ...(baseURL !== undefined ? { baseURL } : {}), maxRetries: 0 })` (runtime import of `openai` lives ONLY here). JSDoc: retries are owned by agent-runtime (spec 04: up to 3 with backoff on 429), so the SDK must not retry underneath. Include a compile-time assignability check in `client.test.ts`: `const assignable: OpenAIResponsesClient = new OpenAI({ apiKey: OPENAI_CANARY }); expect(assignable).toBeDefined();` — if the SDK's `PagePromise`/`ResponseStream` types are not assignable, adjust the interface in `client.ts` (keep it minimal) rather than casting.
4. `packages/core/src/model/openai/index.ts` barrel (provider, client factory, interface, errors, fixtures, fake client, mapping exports that other lanes may need: `VERIFIED_EVENT_TYPES`); add `export * from './openai/index.js';` to `packages/core/src/model/index.ts` (folder barrel; root `src/index.ts` is frozen).
5. Tests:
   - `provider.test.ts` — for each fixture, `createFakeOpenAIClient({ events: await loadOpenAIFixture(name) })` → collect `ModelEvent[]` → `toEqual` the exact expected array (write them out: text → 3 deltas + done + response.done {responseId, usage {120,18}}; tool-call → 3 arguments deltas with the fixture's `call_…` id + `tool_call` + response.done; text-and-tool-call → text events then tool_call then done; refusal → deltas/done as text + done; failed → single `error` rate_limit retryable; incomplete → text events + response.done; error-event → single `error` unknown). Then: request assertions (`calls.stream[0].params.store === false`, `model === input.model`, no `previous_response_id` key, `tools[0].strict === true`, `options.signal` is the input signal); `throwBeforeStream` with an `APIError` 401 → one `error { code: 'auth', retryable: false }` and nothing else; `throwAfterEvents` 429 after two text deltas → two deltas then `error { rate_limit, retryable: true }`; abort mid-stream (AbortController + fake client `delayMs`, fake timers) → events before abort, then the iterable ends with no error event; events exhausted without terminal (`events: [created, in_progress]`) → `error 'stream ended without completion'`; events after a terminal event are not yielded (fixture `completed` followed by an extra delta → stops at response.done); `name === 'openai'`; `listModels` sorted; `listModels` with `throwOnListModels` APIError 401 → `ModelProviderError` with `modelErrorCode 'auth'`, `retryable false`, `instanceof AgentHangarError`; abort-shaped error in listModels → ModelProviderError 'unknown'.
   - `client.test.ts` — `vi.mock('openai', () => ({ default: vi.fn().mockImplementation((opts) => ({ opts, responses: {}, models: {} })) }))` style; asserts `maxRetries: 0`, `apiKey`, `baseURL` present only when given (use `OPENAI_CANARY` as the key value); plus the assignability statement from item 3 in a non-mocked type-level block (`import type` + `expectTypeOf` from vitest).
   - `errors.test.ts` — fields, `instanceof`, `cause` preserved.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- Runtime `openai` import only in `client.ts`. No logging in the provider. No new dependencies.
- Do not modify `model/types.ts`.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green; 100 % on `src/model/openai/**`
- `pnpm typecheck && pnpm lint` — exit 0
- `grep -rn "from 'openai'" packages/core/src/model/openai/*.ts | grep -v "import type"` — only `client.ts`

Completion Protocol: update status/AC/progress in docs/tasks/wave-1c-openai-provider.md; append `- 1C.3 ✅ <date> — <summary>`; commit `feat(core): add OpenAIModelProvider over the Responses streaming API`.
````

---

## Task 1C.4 — Registry `createModelProvider(name, deps)` + barrel exports

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** S · **Depends on:** 1C.3

**Description.** Implement `packages/core/src/model/registry.ts`: `createModelProvider(name, deps)` returns the OpenAI provider (built from `apiKey`/`baseURL` or an injected client) for `'openai'` and `FakeAgentModelProvider` for `'fake'`; validates the name and the presence of a key with `ConfigError`.

**Acceptance criteria**
- [ ] `MODEL_PROVIDER_NAMES = ['openai', 'fake'] as const`, `ModelProviderName`, `isModelProviderName(value)` exported
- [ ] `createModelProvider('openai', { openai: { apiKey } })` → `OpenAIModelProvider` using `createOpenAIClient`; `{ openai: { client } }` uses the injected client (no SDK construction); missing both → `ConfigError` whose message says the OpenAI API key is not configured and points to Settings
- [ ] `createModelProvider('fake', { fake })` → `FakeAgentModelProvider` with the given options (default: empty script); unknown name (runtime string) → `ConfigError` listing valid names
- [ ] Barrel: `packages/core/src/model/index.ts` exports `./registry.js` and `./openai/index.js` (root `src/index.ts` untouched)
- [ ] 100 % coverage on `src/model/registry.ts`

**Files to create**
`packages/core/src/model/registry.ts`, `packages/core/src/model/registry.test.ts`; modify `packages/core/src/model/index.ts`.

**Agent prompt**

````
You are a senior TypeScript engineer working on the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 strict · Node 24 · packages/core. Vitest 4 with @vitest/coverage-v8.
Branch feat/w1c-openai-provider (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-C (OpenAIModelProvider) — Task 1C.4 of 5 (MIDDLE)

PRECONDITIONS
- W0 merged to main; branch off latest main; contracts exist at packages/core/src/model/types.ts, errors.ts (ConfigError), config/schema.ts (AGENT_MODEL_PROVIDER), testing/fake-agent-model-provider.ts.
- Task 1C.3 done: `createOpenAIModelProvider`, `createOpenAIClient`, `OpenAIResponsesClient`.

REQUIRED READING (only these):
- packages/core/src/testing/fake-agent-model-provider.ts (constructor options type — import the type from there)
- packages/core/src/config/schema.ts (how `AGENT_MODEL_PROVIDER` is typed — the registry must accept that type)
- packages/core/src/model/openai/{provider,client}.ts
- packages/core/src/errors.ts (ConfigError)

TASK
Provide the single place that maps a provider name to an `AgentModelProvider` instance, so apps/worker (W2-B) and E2E (`AGENT_MODEL_PROVIDER=fake`) never import provider classes directly.

DELIVERABLES

1. `packages/core/src/model/registry.ts`
   ```ts
   export const MODEL_PROVIDER_NAMES = ['openai', 'fake'] as const;
   export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];
   export function isModelProviderName(value: unknown): value is ModelProviderName
   export interface CreateModelProviderDeps {
     openai?: { apiKey?: string; baseURL?: string; client?: OpenAIResponsesClient };
     fake?: FakeAgentModelProviderOptions;   // the exported options type of the W0 fake (import type)
   }
   export function createModelProvider(name: string, deps?: CreateModelProviderDeps): AgentModelProvider
   ```
   - `!isModelProviderName(name)` → `ConfigError(\`unknown AGENT_MODEL_PROVIDER "${name}" (expected one of: openai, fake)\`)`.
   - `'openai'`: `client = deps.openai?.client ?? (deps.openai?.apiKey ? createOpenAIClient({ apiKey, ...(baseURL) }) : undefined)`; no client → `ConfigError('OpenAI API key is not configured — add it in Settings')`; return `createOpenAIModelProvider({ client })`.
   - `'fake'`: `new FakeAgentModelProvider(deps.fake ?? <the minimal valid options per the W0 type, e.g. { script: {} }>)`.
   - JSDoc on `createModelProvider` states who calls it (worker per turn after `reveal('OPENAI_API_KEY')`; never with a logged key) and that the model id is NOT part of the registry (it travels in `ModelTurnInput.model`).
2. Append to `packages/core/src/model/index.ts`: `export * from './registry.js';` (and confirm `./openai/index.js` from 1C.3 is present). Do not edit the root `src/index.ts`.
3. `registry.test.ts` (mock `./openai/client.js` `createOpenAIClient` with `vi.mock` to avoid SDK construction): openai with apiKey → calls `createOpenAIClient` with `{ apiKey, baseURL? }` exactly (baseURL key absent when not given) and returns a provider with `name === 'openai'`; openai with injected client → `createOpenAIClient` NOT called; openai without key/client → `ConfigError` mentioning Settings; fake with options → `name === 'fake'` and `listModels()` resolves `['fake-model']`; fake without options → works; unknown name → `ConfigError` listing names; `isModelProviderName` for `'openai'`, `'fake'`, `'other'`, `42`, `undefined`.

Constraints:
- Follow /bymax-workflow:standards (JSDoc, headers, English, no enum, no suppression, it() comments).
- No new dependencies; do not modify `model/types.ts` or `testing/**`.

Verification:
- `pnpm --filter @agent-hangar/core test -- --coverage` — green; 100 % on `src/model/registry.ts`
- `pnpm typecheck && pnpm lint` — exit 0
- `pnpm --filter @agent-hangar/core build && node -e "import('@agent-hangar/core').then(m => console.log(typeof m.createModelProvider))"` (run from apps/worker) — prints `function`

Completion Protocol: update status/AC/progress in docs/tasks/wave-1c-openai-provider.md; append `- 1C.4 ✅ <date> — <summary>`; commit `feat(core): add model provider registry`.
````

---

## Task 1C.5 — Close-out: gates, code review, dashboard, PR

**Status:** 📋 ToDo · **Priority:** P0 · **Size:** S · **Depends on:** 1C.1–1C.4

**Description.** Run every gate for the lane's owned paths, run the code review to zero findings, update the plan dashboard and tasks index, open the PR with the "API verification" section, and return the structured summary.

**Acceptance criteria**
- [ ] `pnpm lint && pnpm format:check && pnpm typecheck` exit 0; `pnpm --filter @agent-hangar/core test -- --coverage` green with 100 % ×4 on `src/model/openai/**` and `src/model/registry.ts`
- [ ] `/bymax-quality:code-review` zero open findings
- [ ] PR body contains "API verification" (SDK version, event names confirmed, differences from spec 03 §2, confirmation that `store:false` without `previous_response_id` is accepted by the API at build time)
- [ ] `docs/plan.md` §12 row W1-C → 🟨 with branch/PR/coverage; `docs/tasks/README.md` row updated
- [ ] PR opened; structured summary returned

**Files to modify**
`docs/plan.md` (§12 row only), `docs/tasks/README.md` (lane row only), `docs/tasks/wave-1c-openai-provider.md` (header + log).

**Agent prompt**

````
You are a senior engineer closing out lane W1-C of the Agent Hangar project.

PROJECT: Agent Hangar — local-first web app: AI agents run coding tasks against GitHub repos inside isolated Docker workspaces; cron-scheduled jobs in fresh workspaces; settings with encrypted credentials.
Stack: pnpm 11 · TypeScript ~6.0.3 · Node 24 · Vitest 4 · openai SDK 7.x · GitHub CLI.
Branch feat/w1c-openai-provider (worktree). Spec: docs/spec/. Plan: docs/plan.md.

CURRENT LANE: W1-C (OpenAIModelProvider) — Task 1C.5 of 5 (LAST)

PRECONDITIONS
- Tasks 1C.1–1C.4 done and committed on this branch; working tree clean.

REQUIRED READING (only these):
- docs/plan.md § "11. Orchestrator protocol", § "12. Status dashboard"
- docs/tasks/README.md (W1-C row)
- CLAUDE.md "Gates before any PR"
- The file header of packages/core/src/model/openai/mapping.ts (your recorded API verification notes)

TASK
Run all gates for the owned paths, review to zero findings, update dashboards, open the PR, return the summary. Do not merge, do not wait for CI.

DELIVERABLES

1. Gates (fix, never suppress):
   - `pnpm lint && pnpm format:check && pnpm typecheck`
   - `pnpm --filter @agent-hangar/core test -- --coverage` → 100×4 on `src/model/openai/**` + `src/model/registry.ts` (confirm `coverage.include`)
   - `grep -rn "from 'openai'" packages/core/src/model/openai/*.ts | grep -v "import type"` → only `client.ts`
   - `git diff --name-only main...HEAD` → only owned paths + `packages/core/vitest.config.ts` + `packages/core/src/model/index.ts` + `packages/core/package.json` (one script) + this task file (+ the two dashboard rows). Revert anything else.
2. `/bymax-quality:code-review` (full) on `main...HEAD`; resolve CRITICAL/HIGH/MEDIUM/LOW; unresolved items need a written justification in the PR "Review notes". Re-run gates after fixes. If the pre-push hook requires a cleared review, run `~/.claude/hooks/code-review-clear.sh` only when everything is resolved.
3. Dashboards: `docs/plan.md` §12 row `W1-C` → `🟨` with `feat/w1c-openai-provider` / `#<PR>` + coverage; `docs/tasks/README.md` W1-C row → 🟨 PR open; this file's header Status → 🟨 PR open, Progress 5/5. Commit `docs(tasks): close out W1-C`.
4. Open the PR: `gh pr create --base main --head feat/w1c-openai-provider --title "feat(core): OpenAI model provider, registry and stream fixtures (W1-C)" --body-file <generated>`. Body: Summary · Files · API verification (SDK version; event names confirmed vs spec 03 §2 table, with any renames; `store:false` stateless calls confirmed; `maxRetries: 0` rationale) · How consumers use it (`createModelProvider(config.AGENT_MODEL_PROVIDER, { openai: { apiKey } })`; fixtures + `createFakeOpenAIClient` for tests) · Gates · Coverage · Review notes · Contract change requests. English, no attribution.
5. Return: `{ pr, branch: 'feat/w1c-openai-provider', headSha, gates: { lint, format, typecheck, unit }, coverage: { lines, branches, functions, statements }, contractChangeRequests: [...] }`.

Constraints:
- English; Conventional Commits; no AI attribution anywhere. Do not touch paths outside the owned list except the two dashboard rows.

Verification:
- `gh pr view --json number,headRefOid,state` — PR exists, open
- `git status --porcelain` — empty

Completion Protocol: update status/AC/progress in docs/tasks/wave-1c-openai-provider.md (lane header Status → 🟨 PR open); append `- 1C.5 ✅ <date> — PR #<n> opened`; push the final commit before opening the PR.
````

---

## Completion log

(append-only — one line per completed task: `- <task-id> ✅ YYYY-MM-DD — <one-line summary>`)

- 1C.1 ✅ 2026-08-19 — Responses mapping layer verified against `openai@7.5.0`; every consumed event name matches the shipped `ResponseStreamEvent` union.
- 1C.2 ✅ 2026-08-19 — Seven synthetic NDJSON streams built from the SDK types, plus the fixture loader, the replaying fake client and the redacting record script.
- 1C.3 ✅ 2026-08-19 — `OpenAIModelProvider` over `responses.stream`, `ModelProviderError`, and the real client factory with `maxRetries: 0`.
