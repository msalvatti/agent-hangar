/**
 * Unit tests for the built-in fake scripts.
 *
 * Layer: unit.
 * Goal: every scripted step is a well-formed model round-trip, every scripted tool call would pass
 * the real tool schemas, and the prompts the end-to-end suite sends are all covered — a script the
 * executor would reject turns those specs into a confusing tool failure.
 * Mocks: none.
 */
import { FAKE_USAGE } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import { builtInFakeScript } from './fake-scripts.js';
import { TOOL_SCHEMAS } from './tools/schemas.js';

const script = builtInFakeScript();

describe('builtInFakeScript', () => {
  /** Each key is the exact text a spec sends; a typo makes the fake answer "Done." instead. */
  it('covers the prompts of the end-to-end suite and has a fallback', () => {
    expect(Object.keys(script).toSorted()).toStrictEqual([
      'default',
      'list files and create NOTES.md',
      'print date',
      'run a long command',
      'show NOTES.md',
    ]);
  });

  /** A stream without `response.done` is treated as an unknown provider failure. */
  it('ends every step with a response, so the loop never sees a truncated stream', () => {
    for (const steps of Object.values(script)) {
      for (const step of steps) {
        expect(step.events.at(-1)).toMatchObject({ type: 'response.done' });
      }
    }
  });

  /** `turn.completed` sums these; a missing usage silently under-reports the turn's cost. */
  it('reports usage on every response so the turn totals add up', () => {
    for (const steps of Object.values(script)) {
      for (const step of steps) {
        expect(step.events.at(-1)).toMatchObject({
          usage: {
            inputTokens: expect.any(Number) as number,
            outputTokens: expect.any(Number) as number,
          },
        });
      }
    }
  });

  /** The scripted calls go through the same executor as a real model's, schema and all. */
  it('only calls tools with arguments the real schemas accept', () => {
    const calls = Object.values(script)
      .flat()
      .flatMap((step) => step.events)
      .filter((event) => event.type === 'tool_call');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const schema = TOOL_SCHEMAS[call.name as keyof typeof TOOL_SCHEMAS];
      expect(schema).toBeDefined();
      expect(schema.safeParse(JSON.parse(call.arguments)).success).toBe(true);
    }
  });

  /** Duplicate response ids make a recorded transcript impossible to follow. */
  it('gives every response a distinct identifier', () => {
    const ids = Object.values(script)
      .flat()
      .flatMap((step) => step.events)
      .filter((event) => event.type === 'response.done')
      .map((event) => event.responseId);
    expect(new Set(ids).size).toBe(ids.length);
  });
  /**
   * The scripts are a fixture the end-to-end suite and the local demo are written against: those
   * specs send these exact prompts and assert these exact answers, and the container executes these
   * exact tool arguments. So the whole thing is pinned literally rather than described in the
   * abstract — every check above this one passes just as happily on an empty object, on an empty
   * argument string, or on an answer whose text has been emptied, which is what the mutation run
   * demonstrated when it left twenty-three of this file's literals alive.
   */
  it('plays exactly the events the end-to-end suite and the demo are written against', () => {
    expect(script).toStrictEqual({
      'list files and create NOTES.md': [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'call-list',
              name: 'list_dir',
              arguments: '{"path":".","depth":1}',
            },
            { type: 'response.done', responseId: 'fake-call-list', usage: FAKE_USAGE },
          ],
        },
        {
          events: [
            {
              type: 'tool_call',
              callId: 'call-write',
              name: 'write_file',
              arguments:
                '{"path":"NOTES.md","content":"# Notes\\n\\nCreated by the Agent Hangar fake provider.\\n"}',
            },
            { type: 'response.done', responseId: 'fake-call-write', usage: FAKE_USAGE },
          ],
        },
        {
          events: [
            { type: 'text.delta', text: 'I listed the repository and created NOTES.md.' },
            { type: 'text.done', text: 'I listed the repository and created NOTES.md.' },
            { type: 'response.done', responseId: 'fake-created', usage: FAKE_USAGE },
          ],
        },
      ],
      'show NOTES.md': [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'call-read',
              name: 'read_file',
              arguments: '{"path":"NOTES.md","startLine":null,"endLine":null}',
            },
            { type: 'response.done', responseId: 'fake-call-read', usage: FAKE_USAGE },
          ],
        },
        {
          events: [
            { type: 'text.delta', text: 'Here is NOTES.md, as requested.' },
            { type: 'text.done', text: 'Here is NOTES.md, as requested.' },
            { type: 'response.done', responseId: 'fake-shown', usage: FAKE_USAGE },
          ],
        },
      ],
      'print date': [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'call-date',
              name: 'run_shell',
              arguments: '{"command":"date","cwd":null,"timeoutMs":null}',
            },
            { type: 'response.done', responseId: 'fake-call-date', usage: FAKE_USAGE },
          ],
        },
        {
          events: [
            { type: 'text.delta', text: 'I printed the current date.' },
            { type: 'text.done', text: 'I printed the current date.' },
            { type: 'response.done', responseId: 'fake-dated', usage: FAKE_USAGE },
          ],
        },
      ],
      'run a long command': [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'call-sleep',
              name: 'run_shell',
              arguments: '{"command":"sleep 60","cwd":null,"timeoutMs":null}',
            },
            { type: 'response.done', responseId: 'fake-call-sleep', usage: FAKE_USAGE },
          ],
        },
        {
          events: [
            { type: 'text.delta', text: 'The long command finished.' },
            { type: 'text.done', text: 'The long command finished.' },
            { type: 'response.done', responseId: 'fake-slept', usage: FAKE_USAGE },
          ],
        },
      ],
      default: [
        {
          events: [
            { type: 'text.delta', text: 'Done.' },
            { type: 'text.done', text: 'Done.' },
            { type: 'response.done', responseId: 'fake-default', usage: FAKE_USAGE },
          ],
        },
      ],
    });
  });
});
