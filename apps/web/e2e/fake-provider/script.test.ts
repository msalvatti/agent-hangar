/**
 * Unit tests for the fake provider's script: its shape, its coverage of every scripted prompt, and
 * the rule that no credential-shaped literal is written into the file.
 *
 * Layer: unit test.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertNoCanary } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import { PROMPTS } from '../support/constants';

import { GITHUB_CANARY_PLACEHOLDER, loadProviderScript, scriptPath } from './script';
import type { ProviderScriptFile } from './script';

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

describe('the tool arguments a script may carry', () => {
  /**
   * Writes a one-step script calling one tool and reads it back.
   *
   * @param name - Tool name the step calls.
   * @param args - The call's arguments, as the JSON text the script would carry.
   * @returns Whatever loading that file does.
   */
  function loadWithCall(name: string, args: string): ProviderScriptFile {
    const file = join(mkdtempSync(join(tmpdir(), 'ah-script-')), 'script.json');
    writeFileSync(
      file,
      JSON.stringify({
        default: [
          {
            events: [
              { type: 'tool_call', callId: 'c1', name, arguments: args },
              {
                type: 'response.done',
                responseId: 'r1',
                usage: { inputTokens: 1, outputTokens: 1 },
              },
            ],
          },
        ],
      }),
      'utf8',
    );
    return loadProviderScript(file);
  }

  /**
   * The runtime is asked for strict function calling, so it requires every property to be present
   * and rejects a call that omits one before the tool runs — no exit code, no output, one or two
   * milliseconds. A script that drifts from that contract has to fail where it can be read.
   */
  it('rejects a call that omits a nullable property', () => {
    expect(() => loadWithCall('list_dir', '{"path":"."}')).toThrow(/depth/);
    expect(() => loadWithCall('run_shell', '{"command":"date"}')).toThrow(/cwd/);
    expect(() => loadWithCall('read_file', '{"path":"NOTES.md"}')).toThrow(/startLine/);
  });

  /** The tools forbid additional properties, so a call carrying one dies the same way. */
  it('rejects a call that carries a property the tool does not know', () => {
    expect(() =>
      loadWithCall('write_file', '{"path":"a.md","content":"x","mode":"append"}'),
    ).toThrow();
  });

  /** Arguments travel as text, and text that is not JSON reaches the tool as no arguments at all. */
  it('rejects a call whose arguments are not JSON', () => {
    expect(() => loadWithCall('write_file', 'path=a.md')).toThrow(/not valid JSON/);
  });

  /** A script is allowed to prove what an unknown tool does, so its arguments are not judged. */
  it('accepts a call to a tool no schema describes', () => {
    expect(Object.keys(loadWithCall('teleport', '{"to":"mars"}'))).toEqual(['default']);
  });

  /** The shipped script is the one that has to hold: every call in it must be complete. */
  it('accepts every call the shipped script makes', () => {
    expect(toolCalls().length).toBeGreaterThan(0);
  });
});
