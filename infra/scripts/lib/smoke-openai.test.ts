/**
 * Unit tests for the verdicts `runSmoke` reaches.
 *
 * Layer: unit.
 * Goal: the check reports a pass only when a real turn completed *and* did both halves of the work
 * — read the repository, write the file — and reports a precise, non-zero failure for every way a
 * turn or its transcript can fall short: a failed or cancelled turn, tool calls that ran but did
 * not succeed, near misses that a looser assertion would wave through, and a stream that ended
 * early, expired, dropped or timed out.
 * Mocks: the stub instance in `../testing/smoke-openai-harness.ts`; fake timers for the deadline.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../../../packages/core/src/agent-protocol/types.js';
import {
  AT,
  frame,
  HAPPY_EVENTS,
  json,
  options,
  runCheck,
  stream,
  stubFetch,
} from '../testing/smoke-openai-harness.js';
import type { RecordedCall } from '../testing/smoke-openai-harness.js';

import { FINAL_MESSAGE_PREVIEW_LENGTH } from './smoke-openai-events.js';
import {
  DEFAULT_BRANCH,
  DEFAULT_REPO_URL,
  EXIT_FAILED,
  EXIT_OK,
  SMOKE_PROMPT,
} from './smoke-openai-options.js';
import { runSmoke } from './smoke-openai.js';

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Decodes the JSON body of a recorded request.
 *
 * @param call - The recorded request, if there was one.
 * @returns The parsed body, or `undefined` when the request carried no textual body.
 */
function requestBody(call: RecordedCall | undefined): unknown {
  const body = call?.init?.body;
  return typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined;
}

describe('runSmoke, passing', () => {
  /**
   * The whole point of the check: a turn that listed the repository and wrote the file passes, the
   * prompt that was sent is the one the check promises, and the summary carries the evidence a
   * reader is expected to quote — model, steps, tool calls, duration and tokens.
   */
  it('passes a turn that read and wrote', async () => {
    const result = await runCheck();
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.summary).toBe(
      'model=gpt-5.6-sol steps=2 toolCalls=list_dir,write_file duration=2.5s ' +
        'tokens=1200/300 assistantChars=0',
    );
    // The whole report, in order. This is a diagnostic whose only product is what it printed, so a
    // line that stopped being written — or that started reading as nothing — is the whole of the
    // defect: an operator pastes this transcript somewhere and it has to say what ran.
    expect(result.lines).toStrictEqual([
      'health ok instance=local',
      'settings ok model=gpt-5.6-sol',
      `repo ${DEFAULT_REPO_URL} branch=${DEFAULT_BRANCH}`,
      'chat=chat-1 turn=turn-1',
      'turn.started turn-1',
      'prepare.done branch=agent/abc sha=7fd1a60',
      'step 1',
      'tool.call list_dir',
      'tool.result list_dir SUCCEEDED exit=0 bytes=6 3ms',
      'tool.call write_file SMOKE.md',
      'tool.result write_file SUCCEEDED exit=0 bytes=7 2ms',
      'turn.completed steps=2 tokens=1200/300',
      'cleanup ok chat=chat-1 workspace teardown queued',
      'final Listed the files and wrote SMOKE.md.',
      result.summary,
      'smoke PASS',
    ]);
    const created = result.calls.find((call) => call.url.endsWith('/api/chats'));
    expect(requestBody(created)).toEqual({
      repoUrl: DEFAULT_REPO_URL,
      baseBranch: DEFAULT_BRANCH,
      prompt: SMOKE_PROMPT,
    });
  });

  /**
   * The stream is asked for as a stream. Without the header a server is entitled to negotiate
   * something else, and the check would then be reading a body it cannot frame — a failure it would
   * report against the product.
   */
  it('asks for the event stream by content type', async () => {
    const result = await runCheck();

    const events = result.calls.find((call) => call.url.endsWith('/events'));
    expect(events?.init?.headers).toStrictEqual({ accept: 'text/event-stream' });
  });

  /**
   * The deadline timer is cleared on the way out. This is a short-lived process, but a pending
   * timer holds the closure that cancels the reader, and Node will not exit while it is armed —
   * a check that printed its verdict and then sat there is a check nobody can put in a script.
   */
  it('leaves no timer armed behind it', async () => {
    vi.useFakeTimers();
    try {
      const result = await runCheck();

      expect(result.exitCode).toBe(EXIT_OK);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Every write the check issues has to satisfy the API's same-origin guard, which refuses a
   * state-changing request that cannot show where it came from. Losing this header would turn the
   * whole check into a 403 that reads like a product defect.
   */
  it('proves same-origin on every write', async () => {
    const result = await runCheck();
    const writes = result.calls.filter((call) => call.init?.method !== undefined);
    expect(writes.map((call) => call.init?.method)).toEqual(['POST', 'DELETE']);
    for (const write of writes) {
      expect(write.init?.headers).toMatchObject({ 'sec-fetch-site': 'same-origin' });
    }
  });

  /**
   * A frame can arrive split anywhere, and a check that only worked when the transport happened to
   * deliver whole frames would fail at random against a real server.
   */
  it('passes when frames arrive split across chunks', async () => {
    const text = HAPPY_EVENTS.map(frame).join('');
    const cut = Math.floor(text.length / 2);
    const result = await runCheck({ events: () => stream([text.slice(0, cut), text.slice(cut)]) });
    expect(result.exitCode).toBe(EXIT_OK);
  });

  /**
   * And split anywhere means anywhere: a chunk boundary can fall inside a single character. The
   * transport carries bytes, and the two bytes of an `é` are as splittable as two characters are,
   * so the decoder is told the chunks are a stream — decoded one at a time, the leading half
   * becomes a replacement character and the model's own words come out corrupted.
   */
  it('rejoins a character split across two chunks', async () => {
    const events = HAPPY_EVENTS.map((event) =>
      event.type === 'turn.completed' ? { ...event, finalMessage: 'wrote café notes' } : event,
    );
    const bytes = new TextEncoder().encode(events.map(frame).join(''));
    const eAcute = bytes.indexOf(0xc3);
    const chunks = [bytes.slice(0, eAcute + 1), bytes.slice(eAcute + 1)];

    const result = await runCheck({
      events: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              for (const chunk of chunks) {
                controller.enqueue(chunk);
              }
              controller.close();
            },
          }),
          { status: 200 },
        ),
    });

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.lines).toContain('final wrote café notes');
  });

  /**
   * `run_shell` is the other way a model lists files, and it is at least as common as the tool.
   * A push is reported when one happened, since the branch is what an operator would look at next.
   */
  it('accepts a shell listing and reports a push', async () => {
    const events: AgentEvent[] = [
      { type: 'step.started', step: 1 },
      // Counted rather than printed: the report stays readable and quotes no streamed output.
      { type: 'heartbeat', at: AT },
      { type: 'assistant.delta', text: 'thinking' },
      {
        type: 'tool.call',
        callId: 'c1',
        name: 'run_shell',
        args: { command: 'git ls-files' },
        seq: 0,
      },
      {
        type: 'tool.result',
        callId: 'c1',
        exitCode: 0,
        bytes: 6,
        durationMs: 3,
        status: 'SUCCEEDED',
      },
      {
        type: 'tool.call',
        callId: 'c2',
        name: 'write_file',
        args: { path: 'docs/SMOKE.md', content: 'x' },
        seq: 1,
      },
      {
        type: 'tool.result',
        callId: 'c2',
        exitCode: 0,
        bytes: 1,
        durationMs: 1,
        status: 'SUCCEEDED',
      },
      { type: 'git.pushed', branch: 'agent/abc', sha: 'abcdef1234' },
      {
        type: 'turn.completed',
        usage: { inputTokens: 1, outputTokens: 2 },
        steps: 1,
        finalMessage: '',
      },
    ];
    const result = await runCheck({ events: () => stream(events.map(frame)) });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.summary).toContain('pushed=agent/abc');
    expect(result.summary).toContain('assistantChars=8');
    // The whole report again, because this turn is the one that carries the events the report is
    // supposed to count rather than print: a heartbeat and the model's streamed text. Each of them
    // produces no line, and a check that printed something for them would put a `null` — or the
    // model's own words — into a transcript written to be pasted somewhere public.
    expect(result.lines).toStrictEqual([
      'health ok instance=local',
      'settings ok model=gpt-5.6-sol',
      `repo ${DEFAULT_REPO_URL} branch=${DEFAULT_BRANCH}`,
      'chat=chat-1 turn=turn-1',
      'step 1',
      'tool.call run_shell git ls-files',
      'tool.result run_shell SUCCEEDED exit=0 bytes=6 3ms',
      'tool.call write_file docs/SMOKE.md',
      'tool.result write_file SUCCEEDED exit=0 bytes=1 1ms',
      'git.pushed agent/abc abcdef1',
      'turn.completed steps=1 tokens=1/2',
      'cleanup ok chat=chat-1 workspace teardown queued',
      result.summary,
      'smoke PASS',
    ]);
  });

  /**
   * `--keep` is for an operator who wants to open the chat afterwards, so it must genuinely leave
   * the chat alone rather than deleting it and saying it did not.
   */
  /**
   * The model is free to list the repository however it likes, and the check accepts each of the
   * ways it actually reaches for — measured against `gpt-5.6-sol`, which picks `find` as readily as
   * the tool. A program dropped from the list is a check that reports a defect every time the model
   * chooses that perfectly good way; `git` is a pair, since `git` alone lists nothing.
   */
  it.each([
    ['ls -la', true],
    ['find . -type f', true],
    ['tree -L 2', true],
    ['git ls-files', true],
    // Two spaces: the words are split on runs of separators, so the pair stays adjacent.
    ['git  ls-files', true],
    ['git status', false],
    ['cat ls-files', false],
    ['echo hi', false],
  ])('reads %s as a listing: %s', async (command, listed) => {
    const events: AgentEvent[] = [
      { type: 'tool.call', callId: 'c1', name: 'run_shell', args: { command }, seq: 0 },
      {
        type: 'tool.result',
        callId: 'c1',
        exitCode: 0,
        bytes: 3,
        durationMs: 1,
        status: 'SUCCEEDED',
      },
      {
        type: 'tool.call',
        callId: 'c2',
        name: 'write_file',
        args: { path: 'SMOKE.md', content: '' },
        seq: 1,
      },
      {
        type: 'tool.result',
        callId: 'c2',
        exitCode: 0,
        bytes: 1,
        durationMs: 1,
        status: 'SUCCEEDED',
      },
      {
        type: 'turn.completed',
        usage: { inputTokens: 1, outputTokens: 1 },
        steps: 1,
        finalMessage: 'x',
      },
    ];

    const result = await runCheck({ events: () => stream(events.map(frame)) });

    expect(result.lines.includes('problem no successful tool call listed the repository')).toBe(
      !listed,
    );
    expect(result.exitCode).toBe(listed ? EXIT_OK : EXIT_FAILED);
  });

  /**
   * Each half of the check names the tool it requires. A listing is a `list_dir` or a shell call;
   * the write is a `write_file`. Without the name, any successful call whose target happened to
   * read like one would satisfy the requirement — and a turn that only read files would pass a
   * check whose entire purpose is to prove the agent can write one.
   */
  it('will not take another tool for the listing or the write', async () => {
    const events: AgentEvent[] = [
      // Its target contains a listing word, and it is not a shell call.
      { type: 'tool.call', callId: 'c1', name: 'read_file', args: { path: 'docs/ls' }, seq: 0 },
      {
        type: 'tool.result',
        callId: 'c1',
        exitCode: 0,
        bytes: 3,
        durationMs: 1,
        status: 'SUCCEEDED',
      },
      // Its target is the file the write is required to produce, and it is not a write.
      { type: 'tool.call', callId: 'c2', name: 'read_file', args: { path: 'SMOKE.md' }, seq: 1 },
      {
        type: 'tool.result',
        callId: 'c2',
        exitCode: 0,
        bytes: 1,
        durationMs: 1,
        status: 'SUCCEEDED',
      },
      {
        type: 'turn.completed',
        usage: { inputTokens: 1, outputTokens: 1 },
        steps: 1,
        finalMessage: 'x',
      },
    ];

    const result = await runCheck({ events: () => stream(events.map(frame)) });

    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.lines).toContain('problem no successful tool call listed the repository');
    expect(result.lines).toContain('problem no successful write_file produced SMOKE.md');
  });

  it('leaves the chat in place under --keep', async () => {
    const result = await runCheck({}, { options: { keep: true } });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.calls.some((call) => call.init?.method === 'DELETE')).toBe(false);
    expect(result.lines).toContain('cleanup skipped (--keep) chat=chat-1');
  });
});

describe('runSmoke, failures', () => {
  /**
   * A chat that cannot be created is a failure of the product rather than of the environment: the
   * preconditions all held a moment earlier.
   */
  it.each([
    [
      'a refused creation',
      { createChat: () => json({ error: { code: 'X', message: 'y' } }, 409) },
      '/api/chats answered HTTP 409',
    ],
    [
      'a creation answering the wrong shape',
      { createChat: () => json({ chatId: 'c' }) },
      '/api/chats answered an unrecognised body',
    ],
  ])('reports %s', async (_case, overrides, expected) => {
    const result = await runCheck(overrides);
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.lines).toContain(`error ${expected}`);
    // A chat that could not be created is the product failing, so the report says so — "not run"
    // is reserved for the instance not being ready, which was checked a moment earlier and held.
    expect(result.lines).toContain('smoke FAIL');
    expect(result.lines).not.toContain('smoke NOT RUN');
    // Nothing ran, so there is no evidence line to quote.
    expect(result.summary).toBe('');
  });

  /**
   * A failure the check did not anticipate is still reported as a failure of the run rather than
   * escaping as an unhandled rejection: the operator gets a verdict and a class name, and never a
   * stack trace carrying whatever the failure was built from.
   */
  it('reports a failure it did not anticipate', async () => {
    const lines: string[] = [];
    let reads = 0;
    const result = await runSmoke(options(), {
      fetch: stubFetch().fetch,
      // Fails on the reading that measures the duration, which is the last step before the
      // summary and well inside the part of the run that has a workspace to give back.
      now: (): number => {
        reads += 1;
        if (reads > 1) {
          throw new TypeError('the clock went away');
        }
        return 0;
      },
      log: (line) => lines.push(line),
    });

    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(lines.slice(-2)).toStrictEqual(['error unexpected failure (TypeError)', 'smoke FAIL']);
    expect(result.summary).toBe('');
  });

  /**
   * The failure this whole check exists to catch: the turn ran and did not work. Every unmet
   * requirement is listed, because "it failed" without saying what was missing is what a person
   * would have to re-run the check to learn.
   */
  it('reports a failed turn and everything it therefore did not do', async () => {
    const events: AgentEvent[] = [
      { type: 'turn.started', turnId: 'turn-1', at: AT },
      { type: 'turn.failed', error: { code: 'PREPARE_FAILED', message: 'git clone failed' } },
    ];
    const result = await runCheck({ events: () => stream(events.map(frame)) });
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.lines).toContain('problem the turn failed — PREPARE_FAILED: git clone failed');
    expect(result.lines).toContain('problem no successful tool call listed the repository');
    expect(result.lines).toContain('problem no successful write_file produced SMOKE.md');
    expect(result.summary).toContain('toolCalls=none');
    expect(result.summary).toContain('tokens=n/a');
  });

  /**
   * A cancelled turn completed nothing, and reporting it as merely "did not complete" is what
   * keeps the check from claiming a turn was cancelled when the stream simply ended.
   */
  it('reports a cancelled turn', async () => {
    const result = await runCheck({
      events: () => stream([frame({ type: 'turn.cancelled' })]),
    });
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.lines).toContain('problem the turn did not complete');
    expect(result.lines).toContain('smoke FAIL');
    // A turn that said nothing gets no preview line. An empty `final` reads as a model that
    // answered with nothing, which is a different fact from a turn that never got that far.
    expect(result.lines.some((line) => line.startsWith('final'))).toBe(false);
  });

  /**
   * The preview is bounded and flattened: it is one line of a report an operator pastes elsewhere,
   * so a model that answered with several paragraphs cannot turn the report into several paragraphs
   * of its own, and a run of whitespace collapses to a single space rather than being preserved one
   * space at a time.
   */
  it('flattens and truncates the final message', async () => {
    const long = `first\n\nsecond  spaced ${'x'.repeat(FINAL_MESSAGE_PREVIEW_LENGTH)}`;
    const events = HAPPY_EVENTS.map((event) =>
      event.type === 'turn.completed' ? { ...event, finalMessage: long } : event,
    );

    const result = await runCheck({ events: () => stream(events.map(frame)) });

    const preview = result.lines.find((line) => line.startsWith('final '));
    expect(preview).toBe(
      `final ${`first second spaced ${'x'.repeat(FINAL_MESSAGE_PREVIEW_LENGTH)}`.slice(
        0,
        FINAL_MESSAGE_PREVIEW_LENGTH,
      )}`,
    );
  });

  /**
   * A tool call that ran and failed is not evidence of anything, so the requirement it would have
   * satisfied stays unmet. Asserting on the status rather than on the call's existence is what
   * stops the check passing on a turn that only tried.
   */
  it('does not accept a tool call that failed', async () => {
    const events: AgentEvent[] = [
      { type: 'tool.call', callId: 'c1', name: 'list_dir', args: { path: null }, seq: 0 },
      { type: 'tool.result', callId: 'c1', exitCode: 1, bytes: 0, durationMs: 1, status: 'FAILED' },
      {
        type: 'tool.call',
        callId: 'c2',
        name: 'write_file',
        args: { path: 'SMOKE.md', content: '' },
        seq: 1,
      },
      {
        type: 'tool.result',
        callId: 'c2',
        exitCode: null,
        bytes: 0,
        durationMs: 1,
        status: 'TIMED_OUT',
      },
      {
        type: 'turn.completed',
        usage: { inputTokens: 1, outputTokens: 1 },
        steps: 1,
        finalMessage: 'x',
      },
    ];
    const result = await runCheck({ events: () => stream(events.map(frame)) });
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.lines).toContain('problem no successful tool call listed the repository');
    expect(result.lines).toContain('problem no successful write_file produced SMOKE.md');
  });

  /**
   * A shell call that ran something other than a listing, and a write of some other file, are both
   * near misses — exactly the shape a check that matched too loosely would wave through.
   */
  it('does not accept a shell call or a write that did something else', async () => {
    const events: AgentEvent[] = [
      { type: 'tool.call', callId: 'c1', name: 'run_shell', args: { command: 'echo hi' }, seq: 0 },
      {
        type: 'tool.result',
        callId: 'c1',
        exitCode: 0,
        bytes: 3,
        durationMs: 1,
        status: 'SUCCEEDED',
      },
      {
        type: 'tool.call',
        callId: 'c2',
        name: 'write_file',
        args: { path: 'NOTES.md', content: '' },
        seq: 1,
      },
      {
        type: 'tool.result',
        callId: 'c2',
        exitCode: 0,
        bytes: 1,
        durationMs: 1,
        status: 'SUCCEEDED',
      },
      {
        type: 'turn.completed',
        usage: { inputTokens: 1, outputTokens: 1 },
        steps: 1,
        finalMessage: 'x',
      },
    ];
    const result = await runCheck({ events: () => stream(events.map(frame)) });
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.lines).toContain('problem no successful tool call listed the repository');
    expect(result.lines).toContain(`problem no successful write_file produced SMOKE.md`);
  });
});

describe('runSmoke, interrupted streams', () => {
  /**
   * Four ways the transcript can stop being trustworthy. None of them may read as a pass, and each
   * says which one happened, because the operator's next move differs for every one.
   */
  it.each([
    [
      'a stream that cannot be opened',
      { events: (): Response => new Response(null, { status: 404 }) },
      'problem /api/chats/chat-1/events answered HTTP 404',
    ],
    [
      'a stream with no body',
      { events: (): Response => new Response(null, { status: 200 }) },
      'problem /api/chats/chat-1/events answered with no body',
    ],
    [
      'a stream that ends early',
      { events: (): Response => stream([frame({ type: 'step.started', step: 1 })]) },
      'problem the stream ended before the turn reached a terminal event',
    ],
    [
      'a replay cache that expired',
      { events: (): Response => stream(['id: 1-0\nevent: expired\ndata: {}\n\n']) },
      'problem the replay cache expired, so the transcript cannot be verified',
    ],
  ])('reports %s', async (_case, overrides, expected) => {
    const result = await runCheck(overrides);
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.lines).toContain(expected);
    // The interruption is the whole account of why the transcript cannot be trusted. Adding "the
    // turn did not complete" on top of it states as a finding what is merely the consequence of
    // not having watched — the turn may well have completed, unobserved.
    expect(result.lines).not.toContain('problem the turn did not complete');
  });

  /**
   * A stream that cannot even be requested is reported by the route it was requested on, never by
   * the URL, which is where an operator's own credentials could have been typed.
   */
  it('reports a stream request that could not be issued', async () => {
    const { calls } = stubFetch();
    const lines: string[] = [];
    const result = await runSmoke(options(), {
      fetch: (url, init) => {
        calls.push({ url, init });
        if (url.endsWith('/events')) {
          return Promise.reject(new TypeError('socket hang up'));
        }
        return stubFetch().fetch(url, init);
      },
      now: () => 0,
      log: (line) => lines.push(line),
    });
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(lines).toContain('problem could not open /api/chats/chat-1/events (TypeError)');
  });

  /**
   * A connection that drops mid-transcript is not the same as one that ended: the turn may still
   * be running, and the check says which failure it saw rather than guessing.
   */
  it('reports a stream that drops', async () => {
    const result = await runCheck({
      events: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.error(new TypeError('aborted'));
            },
          }),
          { status: 200 },
        ),
    });
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.lines).toContain('problem the event stream dropped (TypeError)');
  });

  /**
   * Releasing the connection after the turn ended is the last thing that can go wrong, and it must
   * not throw past the caller: the workspace still has to be given back. The observation survives
   * it, so the turn is still reported on.
   */
  it('reports a connection it could not release, keeping what it saw', async () => {
    const encoder = new TextEncoder();
    const result = await runCheck({
      events: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              for (const event of HAPPY_EVENTS) {
                controller.enqueue(encoder.encode(frame(event)));
              }
            },
            cancel(): void {
              throw new RangeError('will not close');
            },
          }),
          { status: 200 },
        ),
    });
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.lines).toContain('problem the event stream could not be closed (RangeError)');
    expect(result.summary).toContain('toolCalls=list_dir,write_file');
    expect(result.lines).toContain('cleanup ok chat=chat-1 workspace teardown queued');
  });

  /**
   * A frame this build cannot decode is surfaced rather than dropped: a transcript with a hole in
   * it is exactly the situation in which a silent reader would report a confident wrong answer.
   */
  it('surfaces an unreadable frame', async () => {
    const result = await runCheck({
      events: () =>
        stream(['id: 1-0\nevent: step.started\ndata: {oops\n\n', ...HAPPY_EVENTS.map(frame)]),
    });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.lines).toContain('unreadable frame event=step.started');
  });

  /**
   * The deadline. A turn that never reports an outcome may still hold its container, so the check
   * cancels the turn before deleting the chat instead of leaving a workspace running behind a
   * report that says the check failed.
   */
  it('times out, cancels the turn and still releases the workspace', async () => {
    vi.useFakeTimers();
    const { fetch: fetchImpl, calls } = stubFetch({
      events: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(): void {
              // Never enqueues and never closes: the deadline is the only thing that can end it.
            },
          }),
          { status: 200 },
        ),
    });
    const lines: string[] = [];
    const pending = runSmoke(options({ timeoutMs: 1000 }), {
      fetch: fetchImpl,
      now: () => 0,
      log: (line) => lines.push(line),
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(lines).toContain('problem timed out after 1 s — is the worker running?');
    expect(lines).toContain('cancel turn=turn-1 HTTP 202');
    // The cancel is a state-changing request and is issued as one: a `GET` reads the route rather
    // than acting on it, and a request that cannot show where it came from is refused by the
    // same-origin guard — either way the turn keeps its container and the workspace stays up,
    // which is the outcome this whole path exists to prevent.
    const cancel = calls.find((call) => call.url.endsWith('/api/turns/turn-1/cancel'));
    expect(cancel?.init).toStrictEqual({
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(lines).toContain('cleanup ok chat=chat-1 workspace teardown queued');
  });

  /**
   * The cancel is best effort: an instance that has gone away between the turn and the cleanup is
   * reported rather than retried, because the delete that follows will report the same thing.
   */
  it('reports a cancel that could not be issued', async () => {
    vi.useFakeTimers();
    const { fetch: fetchImpl } = stubFetch({
      events: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(): void {
              // Never ends; the deadline is what stops it.
            },
          }),
          { status: 200 },
        ),
    });
    const lines: string[] = [];
    const pending = runSmoke(options({ timeoutMs: 1000 }), {
      fetch: (url, init) =>
        url.endsWith('/cancel') ? Promise.reject(new Error('down')) : fetchImpl(url, init),
      now: () => 0,
      log: (line) => lines.push(line),
    });
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(lines).toContain('cancel turn=turn-1 unreachable');
  });
});
