/**
 * Unit tests for the built-in fake scripts.
 *
 * Layer: unit.
 * Goal: every scripted step is a well-formed model round-trip, every scripted tool call would pass
 * the real tool schemas, and the prompts the end-to-end suite sends are all covered — a script the
 * executor would reject turns those specs into a confusing tool failure.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { builtInFakeScript } from './fake-scripts.js';
import { TOOL_SCHEMAS } from './tools/schemas.js';

const script = builtInFakeScript();

describe('builtInFakeScript', () => {
  it('covers the prompts of the end-to-end suite and has a fallback', () => {
    // Each key is the exact text a spec sends; a typo makes the fake answer "Done." instead.
    expect(Object.keys(script).toSorted()).toStrictEqual([
      'default',
      'list files and create NOTES.md',
      'print date',
      'run a long command',
      'show NOTES.md',
    ]);
  });

  it('ends every step with a response, so the loop never sees a truncated stream', () => {
    // A stream without `response.done` is treated as an unknown provider failure.
    for (const steps of Object.values(script)) {
      for (const step of steps) {
        expect(step.events.at(-1)).toMatchObject({ type: 'response.done' });
      }
    }
  });

  it('reports usage on every response so the turn totals add up', () => {
    // `turn.completed` sums these; a missing usage silently under-reports the turn's cost.
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

  it('only calls tools with arguments the real schemas accept', () => {
    // The scripted calls go through the same executor as a real model's, schema and all.
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

  it('gives every response a distinct identifier', () => {
    // Duplicate response ids make a recorded transcript impossible to follow.
    const ids = Object.values(script)
      .flat()
      .flatMap((step) => step.events)
      .filter((event) => event.type === 'response.done')
      .map((event) => event.responseId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
