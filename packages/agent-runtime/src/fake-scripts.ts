/**
 * Built-in scripts for the fake model provider.
 *
 * Layer: test double (shipped).
 *
 * These ship inside the bundle on purpose: the end-to-end suite and the local demo run the whole
 * stack — real containers, real git, real Postgres — with `AGENT_MODEL_PROVIDER=fake`, so that
 * everything except the model is exercised without an API key or a network call. The keys are the
 * exact prompts those specs send.
 */
import type { ModelEvent } from '@agent-hangar/core';
import { FAKE_USAGE } from '@agent-hangar/core/testing';
import type { ProviderScript, ScriptedStep } from '@agent-hangar/core/testing';

/** Notes file the scripted agent writes, and later reads back. */
const NOTES_PATH = 'NOTES.md';

/** Contents the scripted agent writes into it. */
const NOTES_CONTENT = '# Notes\n\nCreated by the Agent Hangar fake provider.\n';

/**
 * Builds a step that calls one tool.
 *
 * @param callId - Identifier the tool result is matched by.
 * @param name - Tool to call.
 * @param args - Arguments, which must satisfy the tool's schema.
 * @returns The step.
 */
function toolStep(callId: string, name: string, args: Record<string, unknown>): ScriptedStep {
  return {
    events: [
      { type: 'tool_call', callId, name, arguments: JSON.stringify(args) },
      { type: 'response.done', responseId: `fake-${callId}`, usage: FAKE_USAGE },
    ],
  };
}

/**
 * Builds a step that answers with text.
 *
 * @param id - Identifier of the scripted response.
 * @param text - The answer.
 * @returns The step.
 */
function answerStep(id: string, text: string): ScriptedStep {
  const events: ModelEvent[] = [
    { type: 'text.delta', text },
    { type: 'text.done', text },
    { type: 'response.done', responseId: `fake-${id}`, usage: FAKE_USAGE },
  ];
  return { events };
}

/**
 * Returns the scripts the bundled fake provider plays.
 *
 * @returns Steps keyed by the exact text of the last user message, with a `default` fallback.
 */
export function builtInFakeScript(): ProviderScript {
  return {
    'list files and create NOTES.md': [
      toolStep('call-list', 'list_dir', { path: '.', depth: 1 }),
      toolStep('call-write', 'write_file', { path: NOTES_PATH, content: NOTES_CONTENT }),
      answerStep('created', `I listed the repository and created ${NOTES_PATH}.`),
    ],
    'show NOTES.md': [
      toolStep('call-read', 'read_file', { path: NOTES_PATH, startLine: null, endLine: null }),
      answerStep('shown', `Here is ${NOTES_PATH}, as requested.`),
    ],
    'print date': [
      toolStep('call-date', 'run_shell', { command: 'date', cwd: null, timeoutMs: null }),
      answerStep('dated', 'I printed the current date.'),
    ],
    'run a long command': [
      toolStep('call-sleep', 'run_shell', { command: 'sleep 60', cwd: null, timeoutMs: null }),
      answerStep('slept', 'The long command finished.'),
    ],
    default: [answerStep('default', 'Done.')],
  };
}
