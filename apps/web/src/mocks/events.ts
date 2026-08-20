/**
 * Scripted server-sent events for `GET /api/chats/:id/events` (and, by construction, the same
 * shape for `GET /api/runs/:id/events`): a small SSE framer plus a canned turn script.
 *
 * Layer: mock (handler).
 *
 * Mock simplification, documented here rather than left implicit: the store is fast-forwarded to
 * the turn's final outcome (turn status, tool call log, final message) as soon as its event
 * stream is first requested, while the *frames themselves* are still delivered to the SSE client
 * with realistic delays. A real backend would only persist as each event actually happens; this
 * mock trades that precision for a simple, reconnect-safe implementation — `GET /api/chats/:id`
 * called mid-stream already shows the turn's end state, which is enough to exercise the UI.
 */
import { apiError, pushedNoticeText, routes } from '@agent-hangar/core';
import type { AgentEvent } from '@agent-hangar/core';
import { http, HttpResponse } from 'msw';

import { compareStreamIds } from '@/shared/transcript';

import type { MockScenario } from './scenario';
import { getScenario } from './scenario';
import { nowIso, store } from './store';
import type { StoredChat } from './store';

/** One frame of a scripted SSE stream. */
export interface SseScriptFrame {
  id: string;
  event: string;
  data: unknown;
  delayMs?: number;
}

/** Options of {@link createSseResponse}. */
export interface CreateSseResponseOptions {
  /** Resume point: frames at or before this id are skipped (Redis `XRANGE (id, +]` semantics). */
  from?: string | null;
  /** Aborts the stream and stops its timers. */
  signal?: AbortSignal;
  /** Called with each frame at the moment it is enqueued (for test/store hooks). */
  onFrame?: (frame: SseScriptFrame) => void;
}

/** Heartbeat comment interval, matching the real server (spec 03 §4). */
const HEARTBEAT_MS = 15_000;

const encoder = new TextEncoder();
const HEARTBEAT_COMMENT = encoder.encode(': ping\n\n');

function encodeFrame(frame: SseScriptFrame): Uint8Array {
  return encoder.encode(
    `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`,
  );
}

/**
 * Builds a scripted `text/event-stream` response.
 *
 * @param frames - The full script; `from` filters it before streaming starts.
 * @param options - Resume point, abort signal, and a per-frame hook.
 * @returns A `text/event-stream` `Response`.
 */
export function createSseResponse(
  frames: readonly SseScriptFrame[],
  options: CreateSseResponseOptions = {},
): Response {
  const { from = null, signal, onFrame } = options;
  const pending =
    from === null ? [...frames] : frames.filter((frame) => compareStreamIds(frame.id, from) > 0);

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  function cleanup(): void {
    clearInterval(heartbeat);
    clearTimeout(timeout);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0;
      let closed = false;

      // `cleanup()` (both here and in `cancel()` below) always runs synchronously, and
      // `clearInterval`/`clearTimeout` guarantee a cleared timer's callback never fires again —
      // so once `closed` flips, `heartbeat` and `timeout` are already inert; their callbacks
      // don't need their own re-check of `closed`.
      function finish(): void {
        if (closed) {
          return;
        }
        closed = true;
        cleanup();
        controller.close();
      }

      if (signal?.aborted === true) {
        finish();
        return;
      }
      signal?.addEventListener('abort', finish);

      heartbeat = setInterval(() => {
        controller.enqueue(HEARTBEAT_COMMENT);
      }, HEARTBEAT_MS);

      function sendNext(): void {
        const frame = pending[index];
        if (frame === undefined) {
          finish();
          return;
        }
        index += 1;
        timeout = setTimeout(() => {
          controller.enqueue(encodeFrame(frame));
          onFrame?.(frame);
          sendNext();
        }, frame.delayMs ?? 0);
      }
      sendNext();
    },
    cancel() {
      cleanup();
    },
  });

  return new HttpResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

/** Options of {@link scriptedTurnFrames}. */
export interface ScriptedTurnOptions {
  turnId: string;
  scenario: MockScenario;
  /** Base epoch millisecond for generated stream ids; must be stable across reconnects. */
  baseMs: number;
}

/**
 * Builds the scripted `AgentEvent` sequence for one turn (spec 03 §3): a workspace prepare, a
 * short assistant reply, two tool calls (`run_shell`, `read_file`), a push, then completion — or,
 * for the `failing-turn`/`expired-stream` scenarios, the corresponding short-circuited script.
 *
 * @param options - Turn id, scenario, and the base id used to generate stream ids.
 * @returns The ordered script.
 */
export function scriptedTurnFrames(options: ScriptedTurnOptions): SseScriptFrame[] {
  const { turnId, scenario, baseMs } = options;
  let sequence = 0;

  function frame(
    event: AgentEvent['type'] | 'expired',
    data: unknown,
    delayMs: number,
  ): SseScriptFrame {
    const id = `${baseMs + sequence}-0`;
    sequence += 1;
    return { id, event, data, delayMs };
  }

  if (scenario === 'expired-stream') {
    return [frame('expired', {}, 0)];
  }

  const startedAt = new Date(baseMs).toISOString();
  const frames: SseScriptFrame[] = [
    frame('turn.started', { type: 'turn.started', turnId, at: startedAt }, 0),
    frame('prepare.progress', { type: 'prepare.progress', message: 'Cloning repository…' }, 300),
    frame(
      'prepare.progress',
      { type: 'prepare.progress', message: 'Checking out base branch…' },
      500,
    ),
    frame(
      'prepare.done',
      { type: 'prepare.done', headSha: 'abcdef1234567890', branch: 'agent/k3x9' },
      400,
    ),
  ];

  if (scenario === 'failing-turn') {
    frames.push(
      frame(
        'turn.failed',
        {
          type: 'turn.failed',
          error: { code: 'auth', message: 'OpenAI rejected the API key (401)' },
        },
        400,
      ),
    );
    return frames;
  }

  frames.push(frame('step.started', { type: 'step.started', step: 1 }, 200));
  const deltas = [
    "I'll start by ",
    'locating the failing ',
    'test and checking ',
    'its recent history ',
    'to see what ',
    'changed recently.',
  ];
  for (const text of deltas) {
    frames.push(frame('assistant.delta', { type: 'assistant.delta', text }, 150));
  }

  const firstCallId = 'call-1';
  frames.push(
    frame(
      'tool.call',
      {
        type: 'tool.call',
        callId: firstCallId,
        name: 'run_shell',
        args: { command: 'rg -n "login" tests/' },
        seq: 0,
      },
      300,
    ),
  );
  frames.push(
    frame(
      'tool.output.delta',
      {
        type: 'tool.output.delta',
        callId: firstCallId,
        stream: 'stdout',
        text: 'tests/auth/login.test.ts:12:  it("logs in", async () => {\n',
      },
      300,
    ),
  );
  frames.push(
    frame(
      'tool.result',
      {
        type: 'tool.result',
        callId: firstCallId,
        exitCode: 0,
        bytes: 58,
        durationMs: 320,
        status: 'SUCCEEDED',
      },
      200,
    ),
  );

  const secondCallId = 'call-2';
  frames.push(
    frame(
      'tool.call',
      {
        type: 'tool.call',
        callId: secondCallId,
        name: 'read_file',
        args: { path: 'tests/auth/login.test.ts', startLine: 1, endLine: 80 },
        seq: 1,
      },
      300,
    ),
  );
  frames.push(
    frame(
      'tool.output.delta',
      {
        type: 'tool.output.delta',
        callId: secondCallId,
        stream: 'stdout',
        text: "import { login } from '../../src/auth';\n",
      },
      300,
    ),
  );
  frames.push(
    frame(
      'tool.result',
      {
        type: 'tool.result',
        callId: secondCallId,
        exitCode: 0,
        bytes: 220,
        durationMs: 180,
        status: 'SUCCEEDED',
      },
      200,
    ),
  );

  const finalMessage =
    'Found the flaky assertion — it depended on system time. Fixed by freezing the clock in the test.';
  frames.push(frame('assistant.message', { type: 'assistant.message', text: finalMessage }, 300));
  frames.push(
    frame('git.pushed', { type: 'git.pushed', branch: 'agent/k3x9', sha: 'fedcba0987654321' }, 200),
  );
  frames.push(
    frame(
      'turn.completed',
      {
        type: 'turn.completed',
        usage: { inputTokens: 3_600, outputTokens: 540 },
        steps: 1,
        finalMessage,
      },
      200,
    ),
  );

  return frames;
}

/**
 * Applies a scripted turn's frames to the store: tool call log, final message, turn status and
 * usage, and the chat's `lastTurnStatus`/`lastPushedSha`/`workBranch`. Safe to call once per
 * turn; the events handler only calls it the first time a turn's stream is requested (see the
 * module docs for why the store is fast-forwarded rather than updated frame-by-frame).
 *
 * @param chatId - The chat the turn belongs to.
 * @param frames - The turn's scripted frames, as built by {@link scriptedTurnFrames}.
 */
export function turnFramesToStore(chatId: string, frames: readonly SseScriptFrame[]): void {
  const entry = store.chats.find((candidate) => candidate.chat.id === chatId);
  if (entry === undefined) {
    return;
  }
  for (const frame of frames) {
    applyFrameToStore(entry, frame);
  }
}

function applyFrameToStore(entry: StoredChat, frame: SseScriptFrame): void {
  if (frame.event === 'expired') {
    return;
  }
  const event = frame.data as AgentEvent;
  const turn = entry.turns[entry.turns.length - 1];
  if (turn === undefined) {
    return;
  }
  switch (event.type) {
    case 'turn.started':
      turn.status = 'PREPARING';
      turn.startedAt = event.at;
      return;
    case 'prepare.done':
      return;
    case 'tool.call':
      entry.toolCalls.push({
        id: `${turn.id}-${event.callId}`,
        turnId: turn.id,
        jobRunId: null,
        callId: event.callId,
        seq: event.seq,
        toolName: event.name,
        args: event.args,
        resultHead: null,
        resultBytes: null,
        exitCode: null,
        status: 'RUNNING',
        startedAt: nowIso(),
        finishedAt: null,
        durationMs: null,
      });
      return;
    case 'tool.result': {
      const call = entry.toolCalls.find((candidate) => candidate.callId === event.callId);
      if (call !== undefined) {
        call.status = event.status;
        call.exitCode = event.exitCode;
        call.durationMs = event.durationMs;
        call.resultBytes = event.bytes;
        call.finishedAt = nowIso();
      }
      return;
    }
    case 'git.pushed': {
      const now = nowIso();
      entry.chat = { ...entry.chat, workBranch: event.branch, lastPushedSha: event.sha };
      // The worker stores the push as a SYSTEM message so a reloaded transcript still shows it;
      // the double stores it too, or mock mode would render a chat the API cannot produce.
      entry.messages.push({
        id: `${turn.id}-pushed-${event.sha}`,
        turnId: turn.id,
        seq: entry.messages.length + 1,
        role: 'SYSTEM',
        content: pushedNoticeText(event.branch, event.sha),
        createdAt: now,
      });
      return;
    }
    case 'turn.completed': {
      const now = nowIso();
      turn.status = 'SUCCEEDED';
      turn.finishedAt = now;
      turn.usage = { ...event.usage, stepCount: event.steps };
      entry.messages.push({
        id: `${turn.id}-final`,
        turnId: turn.id,
        seq: entry.messages.length + 1,
        role: 'ASSISTANT',
        content: event.finalMessage,
        createdAt: now,
      });
      entry.chat = { ...entry.chat, lastTurnStatus: 'SUCCEEDED', updatedAt: now };
      return;
    }
    case 'turn.failed': {
      const now = nowIso();
      turn.status = 'FAILED';
      turn.finishedAt = now;
      turn.error = event.error.message;
      entry.chat = { ...entry.chat, lastTurnStatus: 'FAILED', updatedAt: now };
      return;
    }
    // Streamed progress/content events and the heartbeat/cancellation/protocol-error events carry
    // nothing the store persists (the UI renders them straight from the stream); listed explicitly
    // rather than folded into a catch-all default so a future `AgentEvent` variant fails this
    // switch's exhaustiveness check instead of silently landing here unnoticed.
    case 'step.started':
    case 'prepare.progress':
    case 'assistant.delta':
    case 'assistant.message':
    case 'tool.output.delta':
    case 'heartbeat':
    case 'turn.cancelled':
    case 'protocol.error':
      return;
  }
}

function isTerminalTurnStatus(status: string): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

/** `GET /api/chats/:id/events` — SSE stream of the chat's latest turn. */
const chatEvents = http.get(routes.chatEvents, ({ params, request }) => {
  const id = String(params.id);
  const entry = store.chats.find((candidate) => candidate.chat.id === id);
  if (entry === undefined) {
    return HttpResponse.json(
      apiError.parse({ error: { code: 'NOT_FOUND', message: 'Unknown chat' } }),
      {
        status: 404,
      },
    );
  }
  const turn = entry.turns[entry.turns.length - 1];
  if (turn === undefined) {
    return HttpResponse.json(
      apiError.parse({ error: { code: 'NOT_FOUND', message: 'No turn for this chat' } }),
      {
        status: 404,
      },
    );
  }

  const wasTerminal = isTerminalTurnStatus(turn.status);
  const scenario = getScenario();
  const frames = scriptedTurnFrames({
    turnId: turn.id,
    scenario,
    baseMs: Date.parse(turn.queuedAt),
  }).map((frame) => (wasTerminal ? { ...frame, delayMs: 0 } : frame));

  if (!wasTerminal) {
    turnFramesToStore(id, frames);
  }

  const url = new URL(request.url);
  const from = request.headers.get('Last-Event-ID') ?? url.searchParams.get('from');
  return createSseResponse(frames, { from });
});

/** Handlers for `GET /api/chats/:id/events`. */
export const eventHandlers = [chatEvents];
