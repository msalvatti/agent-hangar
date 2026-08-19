/**
 * Unit tests for the runtime redactor.
 *
 * Layer: unit.
 * Goal: every shape pattern of the secrets contract is caught, exact environment values are
 * replaced wherever they sit (URLs, JSON, repeated), longer values win over the shorter ones they
 * contain, redaction is idempotent and stateless across calls, ordinary hex is left alone, and
 * every `AgentEvent` variant leaves the redactor with its text-carrying fields cleaned and its
 * machine-generated fields untouched.
 * Mocks: none.
 */
import { REDACTED_TOKEN, SECRET_SHAPE_PATTERNS } from '@agent-hangar/core';
import type { AgentEvent } from '@agent-hangar/core';
import { CANARY_MARKER, GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import { createRuntimeRedactor, REDACTED } from './redact.js';

/** Redactor with no registered values: only the shape patterns apply. */
const shapeOnly = createRuntimeRedactor();

/**
 * Fine-grained GitHub PAT canary, assembled at runtime like the shared ones so no
 * credential-shaped literal is written to a file for a secret scanner to flag.
 */
const GITHUB_FINE_GRAINED_CANARY = `github_pat_${CANARY_MARKER.padEnd(22, '0')}`;

/** OpenAI project key canary, assembled the same way. */
const OPENAI_PROJECT_CANARY = `sk-proj-${CANARY_MARKER.padEnd(20, '0')}`;

describe('createRuntimeRedactor / redactText', () => {
  it('uses the replacement token of the shared secrets contract', () => {
    // Host and container must agree on the marker so the UI can render it consistently.
    expect(REDACTED).toBe(REDACTED_TOKEN);
  });

  it.each([
    ['github classic PAT canary', GITHUB_CANARY],
    ['openai key canary', OPENAI_CANARY],
    ['fine-grained github PAT', GITHUB_FINE_GRAINED_CANARY],
    ['openai project key', OPENAI_PROJECT_CANARY],
  ])('replaces a %s found in free text', (_name, secret) => {
    // Shape patterns are the safety net for a credential the agent itself printed.
    expect(shapeOnly.redactText(`token=${secret} end`)).toBe(`token=${REDACTED} end`);
  });

  it('replaces an Authorization header including its scheme', () => {
    // The pattern consumes the whole header so nothing recognisable survives.
    expect(shapeOnly.redactText('Authorization: Bearer abc.def.ghi')).toBe(REDACTED);
  });

  it('exercises one sample per pattern published by the secrets contract', () => {
    // Fails when a pattern is added upstream, so a sample is added above with it.
    expect(SECRET_SHAPE_PATTERNS).toHaveLength(5);
  });

  it('leaves an ordinary 40-character hex sha alone', () => {
    // Commit shas travel in prepare and git events; redacting them would break the UI.
    const sha = 'a'.repeat(40);
    expect(shapeOnly.redactText(`HEAD is ${sha}`)).toBe(`HEAD is ${sha}`);
  });

  it('replaces an exact environment value embedded in a URL', () => {
    // A remote URL built by the agent is the classic accidental credential leak.
    const redactor = createRuntimeRedactor({ values: [GITHUB_CANARY] });
    expect(redactor.redactText(`https://x-access-token:${GITHUB_CANARY}@github.com/a/b.git`)).toBe(
      `https://x-access-token:${REDACTED}@github.com/a/b.git`,
    );
  });

  it('replaces every occurrence of an exact value inside JSON', () => {
    // `split`/`join` avoids escaping bugs a RegExp built from the value would introduce.
    const value = 'plain.secret.value';
    const redactor = createRuntimeRedactor({ values: [value] });
    expect(redactor.redactText(`{"a":"${value}","b":"${value}"}`)).toBe(
      `{"a":"${REDACTED}","b":"${REDACTED}"}`,
    );
  });

  it('replaces the longer value first when one value contains another', () => {
    // Shortest-first would leave the tail of the longer value in the output.
    const short = 'secret-value';
    const long = `${short}-extended`;
    const redactor = createRuntimeRedactor({ values: [short, long] });
    expect(redactor.redactText(`uses ${long} here`)).toBe(`uses ${REDACTED} here`);
  });

  it('ignores undefined and short values', () => {
    // An unset variable and a short one must not turn ordinary words into `[REDACTED]`.
    const redactor = createRuntimeRedactor({ values: [undefined, 'abc'] });
    expect(redactor.redactText('abc is a common word')).toBe('abc is a common word');
  });

  it('is idempotent', () => {
    // The worker redacts again; a second pass must not mangle already-redacted text.
    const redactor = createRuntimeRedactor({ values: [GITHUB_CANARY] });
    const once = redactor.redactText(`a ${GITHUB_CANARY} b ${OPENAI_CANARY} c`);
    expect(redactor.redactText(once)).toBe(once);
  });

  it('produces the same output when called twice with the same input', () => {
    // Proves no regex `lastIndex` state survives between calls of one redactor.
    const input = `${GITHUB_CANARY} and ${GITHUB_CANARY}`;
    expect(shapeOnly.redactText(input)).toBe(shapeOnly.redactText(input));
  });
});

describe('createRuntimeRedactor / redactEvent', () => {
  const redactor = createRuntimeRedactor({ values: [GITHUB_CANARY] });

  it.each([
    [
      'prepare.progress',
      { type: 'prepare.progress', message: `pushed with ${GITHUB_CANARY}` } as const,
      'message',
      `pushed with ${REDACTED}`,
    ],
    [
      'assistant.delta',
      { type: 'assistant.delta', text: `key ${OPENAI_CANARY}` } as const,
      'text',
      `key ${REDACTED}`,
    ],
    [
      'assistant.message',
      { type: 'assistant.message', text: `key ${OPENAI_CANARY}` } as const,
      'text',
      `key ${REDACTED}`,
    ],
    [
      'tool.output.delta',
      {
        type: 'tool.output.delta',
        callId: 'c1',
        stream: 'stdout',
        text: GITHUB_CANARY,
      } as const,
      'text',
      REDACTED,
    ],
    [
      'turn.completed',
      {
        type: 'turn.completed',
        usage: { inputTokens: 1, outputTokens: 2 },
        steps: 1,
        finalMessage: `done ${GITHUB_CANARY}`,
      } as const,
      'finalMessage',
      `done ${REDACTED}`,
    ],
  ])('redacts the %s text field', (_name, event, field, expected) => {
    // Each of these fields carries model or tool output and can contain a credential.
    const result = redactor.redactEvent(event) as unknown as Record<string, unknown>;
    expect(result[field]).toBe(expected);
  });

  it('redacts the message of a failed turn without touching its code', () => {
    // The code is machine-generated and is what the worker branches on.
    const event: AgentEvent = {
      type: 'turn.failed',
      error: { code: 'auth', message: `rejected ${OPENAI_CANARY}` },
    };
    expect(redactor.redactEvent(event)).toStrictEqual({
      type: 'turn.failed',
      error: { code: 'auth', message: `rejected ${REDACTED}` },
    });
  });

  it('redacts a secret nested inside tool-call arguments and keeps the structure', () => {
    // Arguments are model-authored JSON; the shape must survive so the UI can render the card.
    const event: AgentEvent = {
      type: 'tool.call',
      callId: 'c1',
      name: 'run_shell',
      args: { command: `curl -H "x: ${GITHUB_CANARY}"`, nested: [OPENAI_CANARY] },
      seq: 1,
    };
    const result = redactor.redactEvent(event);
    expect(result).toStrictEqual({
      ...event,
      args: { command: `curl -H "x: ${REDACTED}"`, nested: [REDACTED] },
    });
  });

  it('redacts tool-call arguments that are a plain string', () => {
    // Zod validation happens later; the redactor must cope with any JSON value.
    const event: AgentEvent = {
      type: 'tool.call',
      callId: 'c1',
      name: 'read_file',
      args: GITHUB_CANARY,
      seq: 2,
    };
    expect(redactor.redactEvent(event)).toStrictEqual({ ...event, args: REDACTED });
  });

  it('falls back to redacted text when redaction breaks the JSON structure', () => {
    // The Authorization pattern consumes the closing quote, so the reparse cannot succeed.
    const event: AgentEvent = {
      type: 'tool.call',
      callId: 'c1',
      name: 'run_shell',
      args: { header: 'Authorization: Bearer abcdefghij' },
      seq: 3,
    };
    const result = redactor.redactEvent(event) as Extract<AgentEvent, { type: 'tool.call' }>;
    expect(result.args).toBe(`{"header":"${REDACTED}`);
  });

  it('leaves tool-call arguments that have no JSON form untouched', () => {
    // `JSON.stringify(undefined)` yields no text, so there is nothing to redact.
    const event: AgentEvent = {
      type: 'tool.call',
      callId: 'c1',
      name: 'list_dir',
      args: undefined,
      seq: 4,
    };
    expect(redactor.redactEvent(event)).toStrictEqual(event);
  });

  it.each([
    { type: 'turn.started', turnId: 't1', at: '2026-08-19T10:00:00.000Z' },
    { type: 'prepare.done', headSha: 'abc1234', branch: 'main' },
    { type: 'step.started', step: 1 },
    {
      type: 'tool.result',
      callId: 'c1',
      exitCode: 0,
      bytes: 3,
      durationMs: 5,
      status: 'SUCCEEDED',
    },
    { type: 'git.pushed', branch: 'agent/x', sha: 'abc1234' },
    { type: 'heartbeat', at: '2026-08-19T10:00:10.000Z' },
    { type: 'turn.cancelled' },
    { type: 'protocol.error', reason: 'invalid-json', length: 12 },
  ] satisfies AgentEvent[])('returns $type unchanged', (event) => {
    // These variants carry only identifiers, counts, statuses and git object names.
    expect(redactor.redactEvent(event)).toStrictEqual(event);
  });
});
