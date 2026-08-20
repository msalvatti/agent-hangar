/**
 * Unit tests for the scripted agent runtime.
 *
 * Layer: unit.
 * Goal: the script answers only the runtime command, replays events in order as NDJSON, survives
 * being cut at arbitrary byte offsets, writes stderr noise, reports a non-zero exit, and holds
 * until it is cancelled.
 * Mocks: `FakeWorkspaceRunner` drives the script, as the processors do.
 */
import { agentEventSchema, createNdjsonParser } from '@agent-hangar/core';
import type { AgentEvent, ExecEvent, WorkspaceHandle } from '@agent-hangar/core';
import { FakeWorkspaceRunner } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import { scriptedRuntime, SPLIT_CHUNK_BYTES, stdinOf } from './scripted-runtime.js';

const RUNTIME_CMD = ['node', '/opt/agent-runtime/cli.js', 'turn'];

const events: AgentEvent[] = [
  { type: 'turn.started', turnId: 'turn-1', at: '2026-01-01T00:00:00.000Z' },
  { type: 'assistant.message', text: 'héllo — with a multi-byte character' },
  {
    type: 'turn.completed',
    usage: { inputTokens: 1, outputTokens: 2 },
    steps: 1,
    finalMessage: 'ok',
  },
];

/**
 * Creates a running workspace on a runner carrying one script.
 *
 * @param runner - The runner to create the workspace on.
 * @returns The workspace handle.
 */
async function workspaceOn(runner: FakeWorkspaceRunner): Promise<WorkspaceHandle> {
  return runner.create({
    workspaceId: 'ws-1',
    kind: 'CHAT',
    image: 'image',
    env: {},
    limits: { cpus: 1, memoryBytes: 1024, pids: 8 },
    labels: {},
  });
}

/**
 * Collects the exec stream, parsing stdout as NDJSON.
 *
 * @param stream - What `exec` yielded.
 * @returns The parsed events, the stderr text and the exit event.
 */
async function drain(
  stream: AsyncIterable<ExecEvent>,
): Promise<{ parsed: AgentEvent[]; stderr: string; exit: ExecEvent | undefined; chunks: number }> {
  const parser = createNdjsonParser(agentEventSchema);
  const parsed: AgentEvent[] = [];
  const decoder = new TextDecoder();
  let stderr = '';
  let chunks = 0;
  let exit: ExecEvent | undefined;
  for await (const event of stream) {
    if (event.type === 'stdout') {
      chunks += 1;
      parsed.push(...parser.push(event.data));
    }
    if (event.type === 'stderr') {
      stderr += decoder.decode(event.data);
    }
    if (event.type === 'exit') {
      exit = event;
    }
  }
  parsed.push(...parser.flush());
  return { parsed, stderr, exit, chunks };
}

describe('scriptedRuntime', () => {
  /**
   * Only the runtime command is answered; anything else falls through to the runner's default,
   * which is what keeps a stray exec from being mistaken for a turn.
   */
  it('matches only the runtime command', () => {
    const script = scriptedRuntime([]);
    expect(script.match(RUNTIME_CMD)).toBe(true);
    expect(script.match(['node', 'other'])).toBe(false);
    expect(script.match(['sh', '-c', 'turn'])).toBe(false);
  });

  /**
   * The events arrive in order as one stdout chunk and the process exits zero.
   */
  it('replays the events in order and exits zero', async () => {
    const runner = new FakeWorkspaceRunner({ scripts: [scriptedRuntime(events)] });
    const handle = await workspaceOn(runner);

    const { parsed, exit, chunks } = await drain(runner.exec(handle, { cmd: RUNTIME_CMD }));

    expect(parsed).toEqual(events);
    expect(chunks).toBe(1);
    expect(exit).toEqual({ type: 'exit', code: 0 });
  });

  /**
   * A real exec stream cuts wherever the socket does, including inside a line and inside a
   * multi-byte character; the parser has to survive both, so the script must be able to produce
   * them.
   */
  it('splits the stream at arbitrary byte offsets when asked', async () => {
    const runner = new FakeWorkspaceRunner({
      scripts: [scriptedRuntime(events, { splitChunks: true })],
    });
    const handle = await workspaceOn(runner);

    const { parsed, chunks } = await drain(runner.exec(handle, { cmd: RUNTIME_CMD }));

    expect(parsed).toEqual(events);
    expect(chunks).toBeGreaterThan(events.length);
    expect(SPLIT_CHUNK_BYTES).toBeGreaterThan(0);
  });

  /**
   * An empty script writes nothing on stdout at all, which is the "runtime died before it said
   * anything" case.
   */
  it('writes no stdout for an empty script', async () => {
    const runner = new FakeWorkspaceRunner({ scripts: [scriptedRuntime([], { exitCode: 2 })] });
    const handle = await workspaceOn(runner);

    const { parsed, exit, chunks } = await drain(runner.exec(handle, { cmd: RUNTIME_CMD }));

    expect(parsed).toEqual([]);
    expect(chunks).toBe(0);
    expect(exit).toEqual({ type: 'exit', code: 2 });
  });

  /**
   * Diagnostics go to stderr, where the worker logs them at debug level.
   */
  it('writes the requested stderr lines', async () => {
    const runner = new FakeWorkspaceRunner({
      scripts: [scriptedRuntime([], { stderr: ['warming up'] })],
    });
    const handle = await workspaceOn(runner);

    const { stderr } = await drain(runner.exec(handle, { cmd: RUNTIME_CMD }));

    expect(stderr).toBe('warming up\n');
  });

  /**
   * Held scripts emit their prefix and then wait: the stream ends only once the exec is
   * cancelled, and it ends without a terminal event, which is the case the executor classifies.
   */
  it('holds after the requested prefix until it is cancelled', async () => {
    const runner = new FakeWorkspaceRunner({
      scripts: [scriptedRuntime(events, { holdUntilSignal: { afterEvent: 1 } })],
    });
    const handle = await workspaceOn(runner);
    const parser = createNdjsonParser(agentEventSchema);
    const seen: AgentEvent[] = [];
    let exit: ExecEvent | undefined;
    let execRef = '';

    for await (const event of runner.exec(handle, { cmd: RUNTIME_CMD })) {
      if (event.type === 'started') {
        execRef = event.execRef;
      }
      if (event.type === 'stdout') {
        seen.push(...parser.push(event.data));
        await runner.signal(handle, execRef, 'INT');
      }
      if (event.type === 'exit') {
        exit = event;
      }
    }

    expect(seen).toEqual([events[0]]);
    expect(exit).toEqual({ type: 'exit', code: null, signal: 'INT' });
  });

  /**
   * The cancellation may also arrive while the script is already waiting, which is the ordering a
   * real turn produces: the worker subscribes, the runtime idles, and the user presses Cancel
   * some time later.
   */
  it('holds until a cancellation that arrives later', async () => {
    const runner = new FakeWorkspaceRunner({
      scripts: [scriptedRuntime(events, { holdUntilSignal: { afterEvent: 1 } })],
    });
    const handle = await workspaceOn(runner);
    let exit: ExecEvent | undefined;
    let execRef = '';

    for await (const event of runner.exec(handle, { cmd: RUNTIME_CMD })) {
      if (event.type === 'started') {
        execRef = event.execRef;
      }
      if (event.type === 'stdout') {
        setTimeout(() => {
          void runner.signal(handle, execRef, 'KILL');
        }, 0);
      }
      if (event.type === 'exit') {
        exit = event;
      }
    }

    expect(exit).toEqual({ type: 'exit', code: null, signal: 'KILL' });
  });
});

describe('stdinOf', () => {
  /**
   * The worker writes the turn request as a string; reading it back is how tests assert on what
   * the runtime was asked to do.
   */
  it('reads back string stdin', async () => {
    await expect(stdinOf({ cmd: RUNTIME_CMD, stdin: 'payload' })).resolves.toBe('payload');
  });

  /**
   * Bytes and async chunk streams are the other two shapes the runner contract allows.
   */
  it('reads back byte and stream stdin', async () => {
    const bytes = new TextEncoder().encode('bytes');
    await expect(stdinOf({ cmd: RUNTIME_CMD, stdin: bytes })).resolves.toBe('bytes');

    async function* chunks(): AsyncIterable<Uint8Array> {
      yield await Promise.resolve(new TextEncoder().encode('str'));
      yield new TextEncoder().encode('eam');
    }
    await expect(stdinOf({ cmd: RUNTIME_CMD, stdin: chunks() })).resolves.toBe('stream');
  });

  /**
   * An exec with no stdin reads back as empty rather than throwing.
   */
  it('reads absent stdin as empty', async () => {
    await expect(stdinOf({ cmd: RUNTIME_CMD })).resolves.toBe('');
  });
});
