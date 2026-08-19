/**
 * Tests for the scripted SSE layer: frame encoding/order, `from` replay, cancel behaviour, the
 * canned turn script (including the failing-turn/expired-stream scenarios), store persistence,
 * and the `GET /api/chats/:id/events` handler itself.
 *
 * Runs under the project's default jsdom environment rather than switching this file to the
 * per-file Node environment directive the task originally specified (deliberately not spelled
 * out here as a literal docblock pragma, even in prose — Vitest's docblock scanner matches it
 * anywhere in a leading comment, not only as a standalone pragma line, and would force this file
 * onto a plain Node environment that has no `location` global): `src/mocks/vitest.ts` shims
 * `fetch` so a relative URL (what `apiFetch` sends) resolves against `location.origin`, and only
 * jsdom provides `location`. Nothing here needs Node-only globals, so jsdom is a safe, working
 * substitute; kept the `events.node.test.ts` filename the task's file list expects.
 *
 * One MSW quirk to know when reading the `GET /api/chats/:id/events` tests below: for a streamed
 * response body, `ReadableStreamDefaultReader.cancel()` never settles when the stream came back
 * through MSW's Node interceptor (the underlying source's `cancel()` runs and stops the mock
 * stream, but the interceptor's proxy never propagates completion back to the caller). Calling it
 * without `await` still stops the reader; awaiting it hangs the test for the full script's
 * cumulative frame delay before timing out.
 */
import { agentEventSchema } from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { createSseResponse, scriptedTurnFrames, turnFramesToStore } from './events';
import type { SseScriptFrame } from './events';
import { nowIso, seedChat, store } from './store';
import type { StoredChat } from './store';

interface ParsedFrame {
  id: string;
  event: string;
  data: unknown;
}

/** Parses raw SSE text (`id:`/`event:`/`data:` blocks, blank-line separated) into frames. */
function parseSseText(text: string): ParsedFrame[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim().length > 0 && !block.startsWith(': '))
    .map((block) => {
      const lines = block.split('\n');
      const id = lines.find((line) => line.startsWith('id: '))?.slice('id: '.length) ?? '';
      const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length) ?? '';
      const dataLine = lines.find((line) => line.startsWith('data: ')) ?? 'data: null';
      return { id, event, data: JSON.parse(dataLine.slice('data: '.length)) as unknown };
    });
}

/** A seeded chat with no turns yet, for the "no turn for this chat" edge cases below. */
function chatWithNoTurns(id: string): StoredChat {
  const now = nowIso();
  return {
    chat: {
      id,
      title: 'No turns yet',
      status: 'ACTIVE',
      repoUrl: 'https://github.com/acme/api',
      baseBranch: 'main',
      workBranch: null,
      lastPushedSha: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      lastTurnStatus: null,
    },
    messages: [],
    turns: [],
    toolCalls: [],
    workspace: null,
  };
}

async function readAll(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return '';
  }
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      return text;
    }
    text += decoder.decode(value, { stream: true });
  }
}

describe('createSseResponse', () => {
  // Frames are encoded as id:/event:/data: blocks, in order, with the right content type.
  it('encodes frames in order with the right headers', async () => {
    vi.useFakeTimers();
    const frames: SseScriptFrame[] = [
      { id: '1-0', event: 'step.started', data: { type: 'step.started', step: 1 }, delayMs: 5 },
      { id: '2-0', event: 'step.started', data: { type: 'step.started', step: 2 }, delayMs: 5 },
    ];
    const response = createSseResponse(frames);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');

    const readPromise = readAll(response);
    await vi.advanceTimersByTimeAsync(20);
    const text = await readPromise;
    vi.useRealTimers();

    const parsed = parseSseText(text);
    expect(parsed).toEqual([
      { id: '1-0', event: 'step.started', data: { type: 'step.started', step: 1 } },
      { id: '2-0', event: 'step.started', data: { type: 'step.started', step: 2 } },
    ]);
  });

  // `from` skips frames at or before that id (Redis XRANGE (id, +] semantics).
  it('skips frames at or before `from`', async () => {
    vi.useFakeTimers();
    const frames: SseScriptFrame[] = [
      { id: '1-0', event: 'a', data: 1, delayMs: 0 },
      { id: '2-0', event: 'b', data: 2, delayMs: 0 },
      { id: '3-0', event: 'c', data: 3, delayMs: 0 },
    ];
    const response = createSseResponse(frames, { from: '1-0' });
    const readPromise = readAll(response);
    await vi.advanceTimersByTimeAsync(10);
    const parsed = parseSseText(await readPromise);
    vi.useRealTimers();
    expect(parsed.map((frame) => frame.id)).toEqual(['2-0', '3-0']);
  });

  // onFrame fires once per frame, at the moment it is enqueued.
  it('calls onFrame for each frame as it is enqueued', async () => {
    vi.useFakeTimers();
    const onFrame = vi.fn();
    const frames: SseScriptFrame[] = [
      { id: '1-0', event: 'a', data: 1, delayMs: 0 },
      { id: '2-0', event: 'b', data: 2, delayMs: 0 },
    ];
    const response = createSseResponse(frames, { onFrame });
    const readPromise = readAll(response);
    await vi.advanceTimersByTimeAsync(10);
    await readPromise;
    vi.useRealTimers();
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onFrame).toHaveBeenNthCalledWith(1, frames[0]);
  });

  // An already-aborted signal closes the stream immediately, with no frames delivered.
  it('closes immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const frames: SseScriptFrame[] = [{ id: '1-0', event: 'a', data: 1, delayMs: 0 }];
    const response = createSseResponse(frames, { signal: controller.signal });
    const text = await readAll(response);
    expect(text).toBe('');
  });

  // Aborting mid-stream stops further frames from being enqueued.
  it('stops delivering frames once the signal aborts mid-stream', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const frames: SseScriptFrame[] = [
      { id: '1-0', event: 'a', data: 1, delayMs: 5 },
      { id: '2-0', event: 'b', data: 2, delayMs: 5 },
    ];
    const response = createSseResponse(frames, { signal: controller.signal });
    const readPromise = readAll(response);
    await vi.advanceTimersByTimeAsync(5);
    controller.abort();
    await vi.advanceTimersByTimeAsync(20);
    const parsed = parseSseText(await readPromise);
    vi.useRealTimers();
    expect(parsed.map((frame) => frame.id)).toEqual(['1-0']);
  });

  // An empty script closes the stream with no frames.
  it('closes immediately for an empty script', async () => {
    const text = await readAll(createSseResponse([]));
    expect(text).toBe('');
  });

  // A frame with no `delayMs` sends immediately (defaults to 0), not never.
  it('sends a frame with no delayMs immediately', async () => {
    const frames: SseScriptFrame[] = [{ id: '1-0', event: 'a', data: 1 }];
    const text = await readAll(createSseResponse(frames));
    expect(parseSseText(text).map((frame) => frame.id)).toEqual(['1-0']);
  });

  // Aborting again after the stream already finished naturally is a no-op, not a double-close.
  it('ignores an abort signal that fires after the stream already finished', async () => {
    const controller = new AbortController();
    const text = await readAll(createSseResponse([], { signal: controller.signal }));
    expect(text).toBe('');
    expect(() => {
      controller.abort();
    }).not.toThrow();
  });

  // The heartbeat comment keeps the connection alive during a long gap between frames, and
  // cancelling the reader directly (rather than via the abort signal) still clears its timers.
  it('emits a heartbeat comment during a long gap and stops on cancel', async () => {
    vi.useFakeTimers();
    const frames: SseScriptFrame[] = [{ id: '1-0', event: 'a', data: 1, delayMs: 20_000 }];
    const response = createSseResponse(frames);
    const reader = response.body?.getReader();
    const readPromise = reader?.read();
    await vi.advanceTimersByTimeAsync(15_000);
    const { value } = (await readPromise) ?? {};
    vi.useRealTimers();
    const text = value !== undefined ? new TextDecoder().decode(value) : '';
    expect(text).toContain(': ping');
    await reader?.cancel();
  });
});

describe('scriptedTurnFrames', () => {
  // The default scenario produces the full sequence described in the acceptance criteria, and
  // every frame's data satisfies agentEventSchema.
  it('produces the full default sequence with valid AgentEvent payloads', () => {
    const frames = scriptedTurnFrames({
      turnId: 't1',
      scenario: 'default',
      baseMs: 1_700_000_000_000,
    });
    const types = frames.map((frame) => frame.event);
    expect(types[0]).toBe('turn.started');
    expect(types).toContain('prepare.done');
    expect(types).toContain('tool.call');
    expect(types).toContain('tool.result');
    expect(types.at(-1)).toBe('turn.completed');
    for (const frame of frames) {
      expect(() => agentEventSchema.parse(frame.data)).not.toThrow();
    }
  });

  // Frame ids are strictly increasing and share the given base.
  it('generates strictly increasing ids from the given base', () => {
    const frames = scriptedTurnFrames({ turnId: 't1', scenario: 'default', baseMs: 1_000 });
    const ids = frames.map((frame) => frame.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('1000-0');
  });

  // failing-turn short-circuits after prepare with a turn.failed(auth) frame.
  it('failing-turn ends with turn.failed(auth) after prepare', () => {
    const frames = scriptedTurnFrames({ turnId: 't1', scenario: 'failing-turn', baseMs: 0 });
    const last = frames.at(-1);
    expect(last?.event).toBe('turn.failed');
    const data = last?.data as { error: { code: string } };
    expect(data.error.code).toBe('auth');
    expect(frames.some((frame) => frame.event === 'tool.call')).toBe(false);
  });

  // expired-stream is a single "expired" frame.
  it('expired-stream is a single expired frame', () => {
    const frames = scriptedTurnFrames({ turnId: 't1', scenario: 'expired-stream', baseMs: 0 });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe('expired');
  });
});

describe('turnFramesToStore', () => {
  // Applying the full default script updates the turn to SUCCEEDED, records the tool calls, and
  // appends the final assistant message.
  it('fast-forwards a chat to the turn script outcome', () => {
    const frames = scriptedTurnFrames({ turnId: 'turn-running-1', scenario: 'default', baseMs: 0 });
    turnFramesToStore('chat-running', frames);

    const entry = store.chats.find((candidate) => candidate.chat.id === 'chat-running');
    expect(entry?.turns[0]?.status).toBe('SUCCEEDED');
    expect(entry?.toolCalls).toHaveLength(2);
    expect(entry?.toolCalls.every((call) => call.status === 'SUCCEEDED')).toBe(true);
    expect(entry?.messages.at(-1)?.role).toBe('ASSISTANT');
    expect(entry?.chat.lastTurnStatus).toBe('SUCCEEDED');
    expect(entry?.chat.workBranch).toBe('agent/k3x9');
  });

  // The failing-turn script marks the turn FAILED with the scripted error message.
  it('marks the turn FAILED for the failing-turn script', () => {
    const frames = scriptedTurnFrames({
      turnId: 'turn-running-1',
      scenario: 'failing-turn',
      baseMs: 0,
    });
    turnFramesToStore('chat-running', frames);
    const entry = store.chats.find((candidate) => candidate.chat.id === 'chat-running');
    expect(entry?.turns[0]?.status).toBe('FAILED');
    expect(entry?.turns[0]?.error).toContain('401');
  });

  // An unknown chat id is a silent no-op.
  it('does nothing for an unknown chat id', () => {
    expect(() => {
      turnFramesToStore('does-not-exist', []);
    }).not.toThrow();
  });

  // A chat with no turns yet is a silent no-op (defence against a malformed fixture, not a real
  // reachable state through the handlers).
  it('does nothing for a chat with no turns yet', () => {
    seedChat(chatWithNoTurns('chat-no-turns-store'));
    const frames = scriptedTurnFrames({ turnId: 't1', scenario: 'default', baseMs: 0 });
    expect(() => {
      turnFramesToStore('chat-no-turns-store', frames);
    }).not.toThrow();
  });

  // The expired-stream scenario's single synthetic "expired" frame carries no AgentEvent payload
  // to apply, so it is a no-op on the store.
  it('does nothing for the expired-stream scenario', () => {
    const frames = scriptedTurnFrames({
      turnId: 'turn-running-1',
      scenario: 'expired-stream',
      baseMs: 0,
    });
    const entry = store.chats.find((candidate) => candidate.chat.id === 'chat-running');
    const statusBefore = entry?.turns[0]?.status;
    turnFramesToStore('chat-running', frames);
    expect(entry?.turns[0]?.status).toBe(statusBefore);
  });

  // A tool.result with no matching tool.call (an out-of-order or malformed frame sequence) is a
  // no-op on the tool call log rather than throwing.
  it('does nothing when a tool.result has no matching tool.call', () => {
    const frames: SseScriptFrame[] = [
      {
        id: '1-0',
        event: 'tool.result',
        data: {
          type: 'tool.result',
          callId: 'call-without-a-call-frame',
          exitCode: 0,
          bytes: 0,
          durationMs: 1,
          status: 'SUCCEEDED',
        },
      },
    ];
    const entry = store.chats.find((candidate) => candidate.chat.id === 'chat-running');
    const toolCallsBefore = entry?.toolCalls.length;
    expect(() => {
      turnFramesToStore('chat-running', frames);
    }).not.toThrow();
    expect(entry?.toolCalls.length).toBe(toolCallsBefore);
  });
});

describe('GET /api/chats/:id/events', () => {
  // An unknown chat id is a 404.
  it('404s for an unknown chat', async () => {
    const response = await fetch('/api/chats/does-not-exist/events');
    expect(response.status).toBe(404);
  });

  // A chat with no turns yet (e.g. one still being created) is also a 404, with its own message.
  it('404s for a chat with no turns yet', async () => {
    seedChat(chatWithNoTurns('chat-no-turns-get'));
    const response = await fetch('/api/chats/chat-no-turns-get/events');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe('No turn for this chat');
  });

  // A known chat's stream starts with turn.started and is served as text/event-stream.
  it('streams turn.started first for a known chat', async () => {
    const response = await fetch('/api/chats/chat-running/events');
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    const reader = response.body?.getReader();
    const { value } = (await reader?.read()) ?? {};
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: turn.started');
    // Not awaited: MSW's Node interceptor never settles the promise `ReadableStreamDefaultReader
    // .cancel()` returns for a streamed response body (the underlying source's `cancel()` runs,
    // but the interceptor's stream proxy doesn't propagate completion back to the caller). Firing
    // it without awaiting still stops the reader; see the module doc comment for the full story.
    void reader?.cancel();
  });

  // A terminal turn (as if a previous connection already ran it to completion) replays every
  // frame instantly rather than with the script's real-time delays.
  it('replays instantly once the turn is already terminal', async () => {
    const entry = store.chats.find((candidate) => candidate.chat.id === 'chat-running');
    const turn = entry?.turns[0];
    expect(turn).toBeDefined();
    if (turn !== undefined) {
      turn.status = 'SUCCEEDED';
    }

    const start = Date.now();
    const text = await readAll(await fetch('/api/chats/chat-running/events'));
    expect(Date.now() - start).toBeLessThan(500);
    expect(parseSseText(text).length).toBeGreaterThan(0);
  });
});
