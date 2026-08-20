/**
 * Unit tests for the fake provider's script: its shape, its coverage of every scripted prompt, and
 * the rule that no credential-shaped literal is written into the file.
 *
 * Layer: unit test.
 */
import { readFileSync } from 'node:fs';

import { assertNoCanary } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import { PROMPTS } from '../support/constants';

import { GITHUB_CANARY_PLACEHOLDER, loadProviderScript, scriptPath } from './script';

const script = loadProviderScript();
const raw = readFileSync(scriptPath(), 'utf8');

/** Every `tool_call` event of the script, flattened. */
function toolCalls(): { callId: string; name: string; arguments: string; prompt: string }[] {
  return Object.entries(script).flatMap(([prompt, steps]) =>
    steps.flatMap((step) =>
      step.events
        .filter((event) => event.type === 'tool_call')
        .map((event) => ({ ...event, prompt })),
    ),
  );
}

describe('the fake provider script', () => {
  /** A prompt with no script makes the provider answer with an error the spec cannot interpret. */
  it('scripts every prompt the specs send, plus a default', () => {
    for (const prompt of Object.values(PROMPTS)) {
      expect(Object.keys(script)).toContain(prompt);
    }
    expect(Object.keys(script)).toContain('default');
  });

  /** Every step must end in a completed response, or the worker's loop never advances. */
  it('ends every step with a completed response', () => {
    for (const steps of Object.values(script)) {
      for (const step of steps) {
        expect(step.events.at(-1)?.type).toBe('response.done');
      }
    }
  });

  /** Duplicate call ids would make two tool calls indistinguishable in the transcript. */
  it('gives every tool call a unique id', () => {
    const ids = toolCalls().map((call) => call.callId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /** The tool sequence is what each chat spec asserts on, in order. */
  it('scripts the tool sequence each chat spec expects', () => {
    const byPrompt = (prompt: string): string[] =>
      toolCalls()
        .filter((call) => call.prompt === prompt)
        .map((call) => call.name);
    expect(byPrompt(PROMPTS.createNotes)).toEqual(['list_dir', 'write_file']);
    expect(byPrompt(PROMPTS.printDate)).toEqual(['run_shell']);
    expect(byPrompt(PROMPTS.showNotes)).toEqual(['read_file']);
    expect(byPrompt(PROMPTS.sleepLong)).toEqual(['run_shell']);
    expect(byPrompt(PROMPTS.writeToken)).toEqual(['write_file']);
  });

  /** The final texts are what the chat specs wait for in the transcript. */
  it('scripts the final answer each chat spec waits for', () => {
    const finalText = (prompt: string): string | undefined => {
      const steps = script[prompt];
      const events = steps?.at(-1)?.events ?? [];
      return events.find((event) => event.type === 'text.done')?.text;
    };
    expect(finalText(PROMPTS.createNotes)).toBe('Created NOTES.md with the file list.');
    expect(finalText(PROMPTS.printDate)).toBe('The current date was printed above.');
    expect(finalText(PROMPTS.showNotes)).toBe('Here is NOTES.md.');
    expect(finalText('default')).toBe('Acknowledged.');
  });

  /**
   * The one step that must carry a credential carries a placeholder, and only that step does. A
   * literal canary in a committed file is exactly what the canary module exists to avoid.
   */
  it('carries the credential placeholder only where redaction is being proved', () => {
    assertNoCanary(raw);
    const carriers = toolCalls().filter((call) =>
      call.arguments.includes(GITHUB_CANARY_PLACEHOLDER),
    );
    expect(carriers.map((call) => call.prompt)).toEqual([PROMPTS.writeToken]);
  });

  /** A malformed script must fail here rather than inside the worker mid-run. */
  it('rejects a script that does not match the shape', () => {
    expect(() => loadProviderScript('/nonexistent/script.json')).toThrow();
  });
});
