/**
 * Unit tests for the smoke check's frame decoder and event recorder.
 *
 * Layer: unit.
 * Goal: frames are reassembled whatever the transport did to them, every protocol event produces
 * the line the report promises (or is deliberately counted rather than printed), and the facts the
 * check later asserts on — tool calls with their exit codes, steps, usage, the final message — are
 * accumulated exactly once.
 * Mocks: none; both units are pure.
 */
import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../../packages/core/src/agent-protocol/types.js';

import { createEventRecorder, createFrameDecoder, formatTokens } from './smoke-openai-events.js';

/** An ISO timestamp the protocol schema accepts. */
const AT = '2026-08-20T12:00:00.000Z';

/**
 * Serialises one event the way the SSE route writes it.
 *
 * @param event - The event to frame.
 * @returns One complete `text/event-stream` frame.
 */
function frame(event: AgentEvent): string {
  return `id: 1-0\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Records a list of events and returns the lines the recorder produced.
 *
 * @param events - Events in arrival order.
 * @returns The recorder, so the caller can also read its observation.
 */
function recordAll(events: readonly AgentEvent[]): {
  lines: (string | null)[];
  recorder: ReturnType<typeof createEventRecorder>;
} {
  const recorder = createEventRecorder();
  return { lines: events.map((event) => recorder.record(event)), recorder };
}

describe('createFrameDecoder', () => {
  /**
   * The everyday case: one whole frame in one chunk decodes to the event it carried.
   */
  it('decodes a complete frame', () => {
    const decoder = createFrameDecoder();
    const decoded = decoder.push(frame({ type: 'step.started', step: 1 }));
    expect(decoded).toEqual([{ kind: 'event', event: { type: 'step.started', step: 1 } }]);
  });

  /**
   * A chunk is whatever the transport handed over, not a frame: the decoder has to hold the
   * remainder and finish the frame when the rest arrives. Splitting inside the JSON payload is the
   * case a naive "one chunk, one frame" reader gets wrong.
   */
  it('reassembles a frame split across chunks', () => {
    const decoder = createFrameDecoder();
    const text = frame({ type: 'step.started', step: 2 });
    const cut = text.indexOf('"step"');
    expect(decoder.push(text.slice(0, cut))).toEqual([]);
    expect(decoder.push(text.slice(cut))).toEqual([
      { kind: 'event', event: { type: 'step.started', step: 2 } },
    ]);
  });

  /**
   * The mirror case: several frames can arrive in one chunk, and all of them must come out in
   * order rather than only the first.
   */
  it('decodes several frames arriving together', () => {
    const decoder = createFrameDecoder();
    const decoded = decoder.push(
      `${frame({ type: 'step.started', step: 1 })}${frame({ type: 'heartbeat', at: AT })}`,
    );
    expect(
      decoded.map((entry) => (entry.kind === 'event' ? entry.event.type : entry.kind)),
    ).toEqual(['step.started', 'heartbeat']);
  });

  /**
   * The heartbeat is a bare comment with no `event:` line. It keeps an idle proxy from closing the
   * connection and means nothing to the report, so it must not surface as an unreadable frame.
   */
  it('ignores the heartbeat comment', () => {
    expect(createFrameDecoder().push(': ping\n\n')).toEqual([]);
  });

  /**
   * A block that names no event is nothing this reader can act on. Treated as one, its data would
   * be parsed under a name the decoder invented, and the report would carry a frame the server
   * never sent.
   */
  it('ignores a block that names no event', () => {
    expect(
      createFrameDecoder().push('id: 1-0\ndata: {"type":"step.started","step":1}\n\n'),
    ).toEqual([]);
  });

  /**
   * A frame that names an event and carries no payload is unreadable, not empty: every event this
   * protocol defines has fields, so there is nothing to fall back on — and a decoder holding a
   * default payload would report whatever that default happened to parse as.
   */
  it('reports a frame with no data as undecodable', () => {
    expect(createFrameDecoder().push('id: 1-0\nevent: step.started\n\n')).toEqual([
      { kind: 'undecodable', name: 'step.started' },
    ]);
  });

  /**
   * The decoder starts empty, so the very first frame is read exactly as it arrived — including
   * when it opens with the `event:` line, which is the line whose prefix decides the frame's name.
   */
  it('decodes a first frame that opens with its event line', () => {
    expect(
      createFrameDecoder().push('event: step.started\ndata: {"type":"step.started","step":1}\n\n'),
    ).toEqual([{ kind: 'event', event: { type: 'step.started', step: 1 } }]);
  });

  /**
   * A frame carries fields this reader does not use, and only the two it does may be read as those
   * two: a `retry:` line taken for the payload replaces the event with a number.
   */
  it('reads only the event and data fields', () => {
    expect(
      createFrameDecoder().push(
        'id: 1-0\nevent: step.started\ndata: {"type":"step.started","step":1}\nretry: 1000\n\n',
      ),
    ).toEqual([{ kind: 'event', event: { type: 'step.started', step: 1 } }]);
  });

  /**
   * `expired` tells the client the replay cache is gone. It is not an agent event, and the check
   * has to treat it as a reason it cannot verify the transcript rather than as noise.
   */
  it('reports the expired frame', () => {
    const decoder = createFrameDecoder();
    expect(decoder.push('id: 1-0\nevent: expired\ndata: {}\n\n')).toEqual([{ kind: 'expired' }]);
  });

  /**
   * Two ways a payload can fail to be an event — not JSON at all, and JSON that does not satisfy
   * the schema — and both are reported as one unreadable frame rather than throwing.
   */
  it.each([
    ['not JSON', 'id: 1-0\nevent: step.started\ndata: {oops\n\n'],
    ['not an event', 'id: 1-0\nevent: step.started\ndata: {"type":"step.started"}\n\n'],
  ])('reports a payload that is %s as undecodable', (_case, text) => {
    expect(createFrameDecoder().push(text)).toEqual([
      { kind: 'undecodable', name: 'step.started' },
    ]);
  });
});

describe('createEventRecorder lines', () => {
  /**
   * The lifecycle events around the turn: each prints one line naming the fact it carries, and the
   * git object names are shortened because a report is read, not diffed.
   */
  it('prints the preparation and lifecycle events', () => {
    const { lines } = recordAll([
      { type: 'turn.started', turnId: 'turn-1', at: AT },
      { type: 'prepare.progress', message: 'Cloning\n  the   repository…' },
      { type: 'prepare.done', headSha: '7fd1a6031f8b5b4b1e2e6f9c0d', branch: 'agent/abc' },
      { type: 'turn.cancelled' },
    ]);
    expect(lines).toEqual([
      'turn.started turn-1',
      'prepare Cloning the repository…',
      'prepare.done branch=agent/abc sha=7fd1a60',
      'turn.cancelled',
    ]);
  });

  /**
   * A `prepare.progress` message is the one free-form string the runtime emits before the model
   * speaks, and a clone can print a great deal. It is cut to a bounded length, with the cut marked
   * so nobody reads a truncation as the whole message.
   */
  it('truncates a long preparation message', () => {
    const { lines } = recordAll([{ type: 'prepare.progress', message: 'x'.repeat(200) }]);
    expect(lines[0]).toBe(`prepare ${'x'.repeat(120)}…`);
  });

  /**
   * A message that fits is printed whole, ellipsis and all: the mark says text was cut, so putting
   * one after the last character of a complete message tells the reader something was withheld
   * when nothing was. The limit itself fits.
   */
  it('leaves a message that fits exactly as it is', () => {
    const { lines } = recordAll([{ type: 'prepare.progress', message: 'x'.repeat(120) }]);
    expect(lines[0]).toBe(`prepare ${'x'.repeat(120)}`);
  });

  /**
   * And the surrounding whitespace goes: git writes progress with leading indentation and trailing
   * newlines, and a report is one line per event — a message kept as it arrived would break the
   * line it was printed on, and would spend its own budget on spaces.
   */
  it('strips the whitespace around a message before printing it', () => {
    const { lines } = recordAll([{ type: 'prepare.progress', message: '  \n cloning  now \n  ' }]);
    expect(lines[0]).toBe('prepare cloning now');
  });

  /**
   * The two high-frequency events carry free-form model and command output. Printing them would
   * bury the evidence and paste a transcript wherever the report goes, so they are counted; only
   * the assistant text is counted, because that is what the summary reports.
   */
  it('counts the streaming events instead of printing them', () => {
    const { lines, recorder } = recordAll([
      { type: 'assistant.delta', text: 'hello ' },
      { type: 'assistant.delta', text: 'world' },
      { type: 'tool.output.delta', callId: 'c1', stream: 'stdout', text: 'noisy' },
      { type: 'heartbeat', at: AT },
    ]);
    expect(lines).toEqual([null, null, null, null]);
    expect(recorder.observation.assistantChars).toBe(11);
  });

  /**
   * A completed step's text is reported by length rather than quoted: the final message is what
   * the report shows, and every intermediate one would drown it.
   */
  it('reports an assistant message by length', () => {
    const { lines } = recordAll([{ type: 'assistant.message', text: 'abcde' }]);
    expect(lines[0]).toBe('assistant.message 5 chars');
  });

  /**
   * A tool call names what it acts on: `path` for the file tools, `command` for the shell. The
   * result line ties back to the call's tool name, which is what makes the log readable when
   * several calls are in flight.
   */
  it('pairs a tool call with its result', () => {
    const { lines, recorder } = recordAll([
      {
        type: 'tool.call',
        callId: 'c1',
        name: 'write_file',
        args: { path: 'SMOKE.md', content: 'x' },
        seq: 0,
      },
      {
        type: 'tool.result',
        callId: 'c1',
        exitCode: 0,
        bytes: 12,
        durationMs: 4,
        status: 'SUCCEEDED',
      },
    ]);
    expect(lines).toEqual([
      'tool.call write_file SMOKE.md',
      'tool.result write_file SUCCEEDED exit=0 bytes=12 4ms',
    ]);
    expect(recorder.observation.toolCalls).toEqual([
      {
        seq: 0,
        name: 'write_file',
        target: 'SMOKE.md',
        status: 'SUCCEEDED',
        exitCode: 0,
        bytes: 12,
      },
    ]);
  });

  /**
   * `run_shell` carries a `command` rather than a `path`, and the command is kept whole on the
   * record — the assertions read it — while the printed line is cut to a bounded width.
   */
  it('keeps a long shell command whole on the record and short in the line', () => {
    const command = `find . -name '${'a'.repeat(100)}'`;
    const { lines, recorder } = recordAll([
      { type: 'tool.call', callId: 'c1', name: 'run_shell', args: { command }, seq: 0 },
    ]);
    expect(lines[0]).toBe(`tool.call run_shell ${command.slice(0, 80)}…`);
    expect(recorder.observation.toolCalls[0]?.target).toBe(command);
  });

  /**
   * `list_dir` at the workspace root carries a null path: a real call with nothing to name. The
   * line drops the argument rather than printing a trailing space, which would read as a value
   * that went missing.
   */
  it('names a tool call that carries no target', () => {
    const { lines } = recordAll([
      {
        type: 'tool.call',
        callId: 'c1',
        name: 'list_dir',
        args: { path: null, depth: null },
        seq: 0,
      },
    ]);
    expect(lines[0]).toBe('tool.call list_dir');
  });

  /**
   * A result whose call was never seen — a resumed stream that replayed from after the call —
   * still prints, naming the tool as unknown rather than dropping the exit code on the floor. A
   * tool that is not a process reports no exit code, which is printed as such.
   */
  it('prints a result for a call it never saw', () => {
    const { lines, recorder } = recordAll([
      {
        type: 'tool.result',
        callId: 'ghost',
        exitCode: null,
        bytes: 0,
        durationMs: 1,
        status: 'FAILED',
      },
    ]);
    expect(lines[0]).toBe('tool.result unknown FAILED exit=n/a bytes=0 1ms');
    expect(recorder.observation.toolCalls).toEqual([]);
  });

  /**
   * A push is the other half of "write something", so the branch and commit are recorded and
   * printed even though this check's prompt asks the turn not to push.
   */
  it('records a push', () => {
    const { lines, recorder } = recordAll([
      { type: 'git.pushed', branch: 'agent/abc', sha: '1234567890abcdef' },
    ]);
    expect(lines[0]).toBe('git.pushed agent/abc 1234567');
    expect(recorder.observation.pushed).toEqual({ branch: 'agent/abc', sha: '1234567890abcdef' });
  });

  /**
   * A frame the parser rejected reaches the recorder as a `protocol.error`, whose fields are
   * machine-generated by construction. It prints both of them: a reason with no count says nothing
   * about how much was lost.
   */
  it('prints a protocol error', () => {
    const { lines } = recordAll([{ type: 'protocol.error', reason: 'invalid-json', length: 42 }]);
    expect(lines[0]).toBe('protocol.error invalid-json length=42');
  });
});

describe('createEventRecorder outcomes', () => {
  /**
   * The completion carries the numbers the summary reports. `steps` is taken as the larger of what
   * the step events showed and what the completion states, so a stream resumed past the early
   * steps still reports the whole turn.
   */
  it('records a completed turn', () => {
    const { lines, recorder } = recordAll([
      { type: 'step.started', step: 3 },
      {
        type: 'turn.completed',
        usage: { inputTokens: 100, outputTokens: 20 },
        steps: 2,
        finalMessage: 'done',
      },
    ]);
    expect(lines[1]).toBe('turn.completed steps=2 tokens=100/20');
    expect(recorder.observation).toMatchObject({
      steps: 3,
      terminal: 'completed',
      usage: { inputTokens: 100, outputTokens: 20 },
      finalMessage: 'done',
    });
  });

  /**
   * A turn stopped by its own step or time limit completed in the protocol's sense but did not
   * finish its work, and a report that hid that would read as an unqualified success.
   */
  it('marks a turn that stopped at a limit', () => {
    const { lines } = recordAll([
      {
        type: 'turn.completed',
        usage: { inputTokens: 1, outputTokens: 2 },
        steps: 9,
        finalMessage: '',
        stoppedBy: 'limit',
      },
    ]);
    expect(lines[0]).toBe('turn.completed steps=9 tokens=1/2 stoppedBy=limit');
  });

  /**
   * A failure records both halves of what went wrong, since a code without a message is rarely
   * enough to act on and a message without a code is not searchable.
   */
  it('records a failed turn', () => {
    const { lines, recorder } = recordAll([
      { type: 'turn.failed', error: { code: 'PREPARE_FAILED', message: 'git clone failed' } },
    ]);
    expect(recorder.observation.terminal).toBe('failed');
    expect(recorder.observation.failure).toBe('PREPARE_FAILED: git clone failed');
    // And says so on the line as well as in the observation: the report is what an operator reads,
    // and a failure printed as a bare `turn.failed` names nothing they can act on.
    expect(lines[0]).toBe('turn.failed PREPARE_FAILED: git clone failed');
  });

  /**
   * A cancelled turn is recorded as cancelled rather than merely as "not completed": the check
   * skips the workspace teardown request for a turn it knows ended, and the drawer's own wording
   * differs. Its ending is a fact about the turn, not the absence of one.
   */
  it('records a cancelled turn', () => {
    const { lines, recorder } = recordAll([{ type: 'turn.cancelled' }]);

    expect(lines[0]).toBe('turn.cancelled');
    expect(recorder.observation.terminal).toBe('cancelled');
  });

  /**
   * What a recorder holds before a single event reaches it. Every field is the value the report
   * formats when the stream produced nothing — a summary reads `toolCalls=none`, `tokens=n/a` and
   * no final line — so a different starting value is a report about a turn that never ran.
   */
  it('starts from an empty observation', () => {
    expect(createEventRecorder().observation).toStrictEqual({
      steps: 0,
      assistantChars: 0,
      toolCalls: [],
      usage: null,
      finalMessage: '',
      pushed: null,
      terminal: null,
      failure: '',
    });
  });
});

describe('formatTokens', () => {
  /**
   * A turn that never completed reports no usage, and `n/a` says that without inviting the reader
   * to believe the turn cost nothing.
   */
  it.each([
    [null, 'n/a'],
    [{ inputTokens: 7, outputTokens: 3 }, '7/3'],
  ])('formats %o as %s', (usage, expected) => {
    expect(formatTokens(usage)).toBe(expected);
  });
});

describe('createEventRecorder tool arguments', () => {
  /**
   * Tool arguments come from the model, so the protocol types them as `unknown`. Every shape that
   * carries no usable target — a bare string, `null`, an object with neither key, a `path` that is
   * not a string — has to leave the call named and unadorned rather than throw or print a stray
   * value: the report has to survive whatever the model produced.
   */
  it.each([
    ['a primitive', 'text'],
    ['null', null],
    ['an object with neither key', { other: 'x' }],
    ['a non-string path', { path: 42 }],
  ])('names a call whose arguments are %s', (_case, args) => {
    const { lines, recorder } = recordAll([
      { type: 'tool.call', callId: 'c1', name: 'read_file', args, seq: 0 },
    ]);
    expect(lines[0]).toBe('tool.call read_file');
    expect(recorder.observation.toolCalls[0]?.target).toBe('');
  });

  /**
   * The `command` key is read only when there is no `path`, which is what lets one accessor serve
   * both the file tools and the shell without either shadowing the other.
   */
  it('falls back to the command when there is no path', () => {
    const { lines } = recordAll([
      { type: 'tool.call', callId: 'c1', name: 'run_shell', args: { command: 'ls -la' }, seq: 0 },
    ]);
    expect(lines[0]).toBe('tool.call run_shell ls -la');
  });
});
