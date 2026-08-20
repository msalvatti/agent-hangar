/**
 * Unit tests for forwarding a scripted-provider script into the workspace container.
 *
 * Layer: unit.
 * Goal: a script named on disk becomes the container variable the scripted provider reads, only
 * ever for the scripted provider, carrying nothing the schema does not declare; and every way the
 * file can be wrong stops the process with a message that names the variable and repeats none of
 * the file's content.
 * Mocks: the files are real, written into a temporary directory; only the read that has to fail
 * for a reason a real file system will not reproduce goes through an injected reader.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError } from '@agent-hangar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FAKE_SCRIPT_ENV_KEY,
  fakeProviderScriptEnv,
  readFakeProviderScript,
} from './fake-provider-script.js';
import type { ScriptFileSystem } from './fake-provider-script.js';

/** A script in the shape a caller supplies: one key, one step, one answer. */
const SCRIPT = {
  'print date': [
    {
      events: [
        { type: 'tool_call.arguments.delta', callId: 'call-1', delta: '{"command":"date"}' },
        { type: 'tool_call', callId: 'call-1', name: 'run_shell', arguments: '{"command":"date"}' },
        {
          type: 'response.done',
          responseId: 'fake-1',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      ],
    },
    {
      events: [
        { type: 'text.delta', text: 'The current date was printed above.' },
        { type: 'text.done', text: 'The current date was printed above.' },
        {
          type: 'response.done',
          responseId: 'fake-2',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      ],
    },
  ],
  default: [
    {
      events: [
        { type: 'text.delta', text: 'Acknowledged.' },
        { type: 'text.done', text: 'Acknowledged.' },
        {
          type: 'response.done',
          responseId: 'fake-3',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      ],
    },
  ],
};

let directory: string;

/**
 * Writes a file into the temporary directory.
 *
 * @param name - File name.
 * @param content - Exact text to write.
 * @returns The absolute path.
 */
function write(name: string, content: string): string {
  const path = join(directory, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ah-fake-script-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/**
 * Forwards a script and returns the raw variable value.
 *
 * @param path - Path of the script file.
 * @returns The value of the container variable.
 */
function env(path: string): string {
  return fakeProviderScriptEnv('fake', path)[FAKE_SCRIPT_ENV_KEY] ?? '';
}

describe('fakeProviderScriptEnv', () => {
  /**
   * A script decides what the agent says and which tools it calls with which arguments, so it is
   * reachable through the scripted provider and nothing else. A deployment running the real
   * provider gets no forwarding even when the variable is set, which is what keeps the variable
   * from being a way of driving a real agent.
   */
  it('forwards nothing when the configured provider is not the scripted one', () => {
    const path = write('openai.json', JSON.stringify(SCRIPT));

    expect(fakeProviderScriptEnv('openai', path)).toEqual({});
  });

  /**
   * The scripted provider without a supplied script keeps the one built into the runtime; the
   * worker adds no variable, so the container's environment stays exactly what it was.
   */
  it('forwards nothing when the scripted provider was given no script', () => {
    expect(fakeProviderScriptEnv('fake', undefined)).toEqual({});
  });

  /**
   * The join this module exists for: a path on the worker's side becomes the script itself, under
   * the name the provider inside the container reads.
   */
  it('carries the script under the variable the container provider reads', () => {
    const path = write('script.json', JSON.stringify(SCRIPT));

    const block = fakeProviderScriptEnv('fake', path);

    expect(Object.keys(block)).toEqual([FAKE_SCRIPT_ENV_KEY]);
    expect(JSON.parse(block[FAKE_SCRIPT_ENV_KEY] ?? '')).toEqual(SCRIPT);
  });

  /**
   * The forwarded value is the validated script reserialised, not the file's bytes: a key the
   * schema does not declare is dropped rather than travelling into the container environment
   * alongside the credentials.
   */
  it('carries only what the schema declares', () => {
    const path = write(
      'extra.json',
      JSON.stringify({
        default: [
          {
            events: [{ type: 'text.done', text: 'Acknowledged.', smuggled: 'value' }],
            smuggled: 'value',
          },
        ],
      }),
    );

    const forwarded = env(path);

    expect(forwarded).not.toContain('smuggled');
    expect(JSON.parse(forwarded)).toEqual({
      default: [{ events: [{ type: 'text.done', text: 'Acknowledged.' }] }],
    });
  });

  /**
   * A delay is part of the script's shape, so a step that carries one survives the round trip
   * rather than being dropped as undeclared.
   */
  it('keeps the optional delay of a step', () => {
    const path = write(
      'delay.json',
      JSON.stringify({ default: [{ events: [{ type: 'text.done', text: 'x' }], delayMs: 25 }] }),
    );

    expect(JSON.parse(env(path))).toEqual({
      default: [{ events: [{ type: 'text.done', text: 'x' }], delayMs: 25 }],
    });
  });
});

describe('readFakeProviderScript', () => {
  /**
   * A path that names nothing stops the process with the variable to fix, and does not repeat the
   * reason the read failed — the path is already in the message and the rest is noise.
   */
  it('refuses a file it cannot read, naming the variable', () => {
    const missing = join(directory, 'absent.json');

    expect(() => readFakeProviderScript(missing)).toThrow(ConfigError);
    expect(() => readFakeProviderScript(missing)).toThrow(
      `FAKE_PROVIDER_SCRIPT_PATH: cannot read ${missing}`,
    );
  });

  /**
   * A path can be unreadable for reasons a test cannot arrange on a real file system — a
   * permission the runner happens to hold, a device that answers slowly — so the reader is
   * injectable and the refusal is proved against a reader that simply fails.
   */
  it('refuses a file whose read fails for any reason', () => {
    const fileSystem: ScriptFileSystem = {
      readFileSync: () => {
        throw new Error('EACCES');
      },
    };

    expect(() => readFakeProviderScript('/scripts/script.json', fileSystem)).toThrow(
      'FAKE_PROVIDER_SCRIPT_PATH: cannot read /scripts/script.json',
    );
  });

  /**
   * A JSON parse error quotes a prefix of its input, so the file's own content must not reach the
   * message: the file is operator-supplied and the failure is written to the log.
   */
  it('refuses a file that is not JSON without repeating its content', () => {
    const path = write('broken.json', '{oops secret-looking-content');

    expect(() => readFakeProviderScript(path)).toThrow(ConfigError);
    expect(() => readFakeProviderScript(path)).toThrow(/is not valid JSON/u);
    expect(() => readFakeProviderScript(path)).not.toThrow(/secret-looking-content/u);
  });

  /**
   * A script whose events the container could not replay is refused where the operator can still
   * read the message, rather than half-played inside a container; the report names the path
   * through the file that is wrong.
   */
  it('refuses a script the container could not replay', () => {
    const path = write(
      'invalid.json',
      JSON.stringify({ default: [{ events: [{ type: 'nope' }] }] }),
    );

    expect(() => readFakeProviderScript(path)).toThrow(ConfigError);
    expect(() => readFakeProviderScript(path)).toThrow(/default\.0\.events\.0/u);
  });

  /**
   * An empty step list would select a script that can never answer, so it is rejected with the
   * rest rather than accepted and discovered as an exhausted script mid-turn.
   */
  it('refuses a key with no steps', () => {
    const path = write('empty.json', JSON.stringify({ default: [] }));

    expect(() => readFakeProviderScript(path)).toThrow(/is not a provider script/u);
  });

  /**
   * The parsed script is returned as data, which is what the forwarding reserialises.
   */
  it('returns the validated script', () => {
    const path = write('valid.json', JSON.stringify(SCRIPT));

    expect(readFakeProviderScript(path)).toEqual(SCRIPT);
  });
});
