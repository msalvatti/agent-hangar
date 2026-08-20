/**
 * Zod schemas of the host ↔ workspace agent protocol (NDJSON over exec stdin/stdout).
 *
 * Layer: contract.
 *
 * These schemas are the source of truth; the TypeScript types in `./types.ts` are derived from
 * them with `z.infer` so the two can never drift. The worker validates every line the runtime
 * emits and the runtime validates the single `TurnRequest` it receives.
 */
import { z } from 'zod';

import { credentialFreeUrl } from '../repo-url.ts';

/** Tools the agent runtime exposes to the model. */
export const toolNameSchema = z.enum(['run_shell', 'read_file', 'write_file', 'list_dir']);

/** One conversation item (mirrors `ConversationItem` of the model contract). */
export const conversationItemSchema = z.union([
  z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    callId: z.string().min(1),
    name: z.string().min(1),
    arguments: z.string(),
  }),
  z.object({ type: z.literal('tool_result'), callId: z.string().min(1), output: z.string() }),
]);

/**
 * Repository the turn works on.
 *
 * The URL must be credential-free and the schema enforces it: this value is handed to `git clone`
 * inside the workspace, so userinfo or a token-bearing query string would put the PAT into the
 * clone URL and into the container's process arguments instead of travelling via `GIT_ASKPASS`.
 * Which forge is allowed is the host's policy, decided before the request is built, so it is not
 * restated here.
 */
export const turnRepoSchema = z.object({
  url: credentialFreeUrl,
  baseBranch: z.string().min(1),
  /** Branch the agent should commit to. */
  workBranch: z.string().min(1),
  /** Restore verification: HEAD the host expects after checkout. */
  expectedHeadSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .optional(),
});

/** Hard limits the runtime enforces on one turn. */
export const turnLimitsSchema = z.object({
  /** Model round-trips (default 40). */
  maxSteps: z.number().int().positive(),
  /** Wall clock in ms (default 20 min; jobs 30 min). */
  maxTurnMs: z.number().int().positive(),
  /** Per `run_shell` call in ms (default 5 min). */
  toolTimeoutMs: z.number().int().positive(),
  /** Per tool result sent to the model (default 32 KB). */
  maxToolOutputBytes: z.number().int().positive(),
});

/** Token usage reported at the end of a turn. */
export const turnUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

/** The single object written to the runtime's stdin. */
export const turnRequestSchema = z.object({
  protocolVersion: z.literal(1),
  /** `Turn.id` or `JobRun.id`. */
  turnId: z.string().min(1),
  model: z.string().min(1),
  /** System prompt, built host-side. */
  instructions: z.string(),
  /** History window. */
  items: z.array(conversationItemSchema),
  repo: turnRepoSchema,
  limits: turnLimitsSchema,
  /** Whether to clone first (fresh/restored workspace) or assume `/workspace` is ready. */
  prepare: z.object({ clone: z.boolean() }),
});

/** Result status of a tool call. */
export const toolResultStatusSchema = z.enum(['SUCCEEDED', 'FAILED', 'TIMED_OUT']);

/**
 * Why the NDJSON parser rejected a line. A closed vocabulary on purpose: see
 * {@link protocolErrorEventSchema}.
 */
export const protocolErrorReasonSchema = z.enum([
  /** The line is not valid JSON. */
  'invalid-json',
  /** The line is valid JSON but does not satisfy the schema. */
  'schema-violation',
  /** The line exceeded the parser's buffered-line limit and was discarded. */
  'line-too-long',
]);

/**
 * Emitted by the NDJSON parser for a line that is not a valid event; never produced by the runtime.
 *
 * Security: the rejected bytes come from a process running inside an agent workspace, whose
 * environment holds the GitHub PAT and the OpenAI API key, and this event is persisted and
 * displayed. Every field is therefore machine-generated — a reason drawn from
 * {@link protocolErrorReasonSchema} and a character count — so the event has no free-form text
 * and is structurally incapable of carrying a credential, whoever builds it.
 */
export const protocolErrorEventSchema = z.object({
  type: z.literal('protocol.error'),
  reason: protocolErrorReasonSchema,
  /** Length in characters of the offending line. A count cannot carry a secret. */
  length: z.number().int().nonnegative(),
});

/** Every event the runtime streams on stdout, one JSON object per line. */
export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn.started'), turnId: z.string().min(1), at: z.iso.datetime() }),
  z.object({ type: z.literal('prepare.progress'), message: z.string() }),
  z.object({
    type: z.literal('prepare.done'),
    headSha: z.string().min(1),
    branch: z.string().min(1),
  }),
  z.object({ type: z.literal('step.started'), step: z.number().int().positive() }),
  z.object({ type: z.literal('assistant.delta'), text: z.string() }),
  /** Final text of a step. */
  z.object({ type: z.literal('assistant.message'), text: z.string() }),
  z.object({
    type: z.literal('tool.call'),
    callId: z.string().min(1),
    name: toolNameSchema,
    args: z.unknown(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('tool.output.delta'),
    callId: z.string().min(1),
    stream: z.enum(['stdout', 'stderr']),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool.result'),
    callId: z.string().min(1),
    exitCode: z.number().int().nullable(),
    bytes: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    status: toolResultStatusSchema,
  }),
  /** Emitted when a push is detected. */
  z.object({ type: z.literal('git.pushed'), branch: z.string().min(1), sha: z.string().min(1) }),
  /** Every 10 s while idle. */
  z.object({ type: z.literal('heartbeat'), at: z.iso.datetime() }),
  z.object({
    type: z.literal('turn.completed'),
    usage: turnUsageSchema,
    steps: z.number().int().nonnegative(),
    finalMessage: z.string(),
    /** Present when the loop stopped because `maxSteps`/`maxTurnMs` was hit. */
    stoppedBy: z.literal('limit').optional(),
  }),
  z.object({
    type: z.literal('turn.failed'),
    error: z.object({ code: z.string().min(1), message: z.string() }),
  }),
  z.object({ type: z.literal('turn.cancelled') }),
  protocolErrorEventSchema,
]);

/** Protocol version accepted by this build. */
export const PROTOCOL_VERSION = 1 as const;
