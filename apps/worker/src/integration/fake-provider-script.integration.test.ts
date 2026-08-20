/**
 * The supplied scripted-provider script, exercised across the process boundary it has to cross.
 *
 * Layer: integration (`@docker @db @redis`).
 * Goal: a script file named to the worker becomes the answers a real workspace container gives.
 * The two sides of this are written in different processes — the worker composes the container's
 * environment, the runtime inside the container reads it — so only a run with a real container
 * proves they meet. The script used here answers text the runtime's built-in script never
 * produces, under a key it does not carry, and writes the workspace's own credential through a
 * placeholder, so a run that fell back to the built-in script fails every assertion below.
 * Mocks: the model, and nothing else.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JOB_NAMES } from '@agent-hangar/core';
import type { Chat } from '@agent-hangar/core';
import { assertNoCanary } from '@agent-hangar/core/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { describeDocker } from './describe-docker.js';
import {
  createIntegrationHarness,
  TEST_REPO_BRANCH,
  TEST_REPO_URL,
} from './harness.integration-helper.js';
import type { IntegrationHarness } from './harness.integration-helper.js';

/**
 * Text a scripted step writes where the workspace's GitHub credential belongs.
 *
 * Spelled out rather than imported: the module that substitutes it runs inside the container,
 * built from a package this one does not depend on. That the two spellings agree is what this
 * test measures — a mismatch leaves the literal in the arguments and fails the assertions below.
 */
const CREDENTIAL_PLACEHOLDER = '{{GITHUB_CANARY}}';

/** Prompt the supplied script is keyed to; the built-in script has no such key. */
const PROMPT = 'write the token to a file';

/** Answer only the supplied script can produce. */
const ANSWER = 'Wrote the token.';

/** File the scripted agent writes the credential into, inside its own workspace. */
const TOKEN_FILE = 'token.txt';

/** The script, exactly as a caller writes it on disk. */
const SCRIPT = {
  [PROMPT]: [
    {
      events: [
        {
          type: 'tool_call',
          callId: 'call-1',
          name: 'write_file',
          arguments: JSON.stringify({
            path: TOKEN_FILE,
            content: CREDENTIAL_PLACEHOLDER,
          }),
        },
        {
          type: 'response.done',
          responseId: 'fake-1',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      ],
    },
    {
      events: [
        { type: 'text.delta', text: ANSWER },
        { type: 'text.done', text: ANSWER },
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

describeDocker('a supplied provider script reaches the container', () => {
  let harness: IntegrationHarness;
  let directory: string;
  let chat: Chat;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ah-script-'));
    const scriptPath = join(directory, 'script.json');
    await writeFile(scriptPath, JSON.stringify(SCRIPT), 'utf8');
    harness = await createIntegrationHarness({
      masterKeyPath: join(directory, 'master.key'),
      fakeProviderScriptPath: scriptPath,
    });
    chat = await harness.container.repos.chats.create({
      title: 'Supplied script',
      repoUrl: TEST_REPO_URL,
      baseBranch: TEST_REPO_BRANCH,
    });
  });

  afterAll(async () => {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * The whole crossing in one run: the worker reads the file, composes it into the container's
   * environment, and the runtime inside that container answers from it — with the credential
   * placeholder filled in where the credential already lives, and the redactor removing it again
   * on the way to the rows. Every assertion distinguishes the supplied script from the built-in
   * one, which answers other text and carries no key for this prompt.
   */
  it('answers from the supplied script and redacts the credential it carried', async () => {
    const { repos, queues } = harness.container;
    await repos.messages.append(chat.id, 'USER', PROMPT);
    const turn = await repos.turns.create({ chatId: chat.id, model: harness.config.OPENAI_MODEL });
    await queues.chatTurns.add(JOB_NAMES.runTurn, { turnId: turn.id }, { jobId: turn.id });

    await harness.waitFor(`turn ${turn.id} to settle`, async () => {
      const current = await repos.turns.get(turn.id);
      return current?.finishedAt != null;
    });

    const finished = await repos.turns.get(turn.id);
    const stream = await harness.readStream(turn.id);
    if (finished?.status !== 'SUCCEEDED') {
      // Printed so a failing run is diagnosable from the CI log alone.
      console.error(
        'turn did not succeed',
        finished?.error,
        stream.map((entry) => entry.event.type),
      );
    }
    expect(finished?.status).toBe('SUCCEEDED');

    const toolCalls = await repos.toolCalls.listByTurn(turn.id);
    expect(toolCalls.map((call) => call.toolName)).toEqual(['write_file']);
    expect(JSON.stringify(toolCalls)).toContain('[REDACTED]');
    expect(JSON.stringify(toolCalls)).not.toContain(CREDENTIAL_PLACEHOLDER);

    const messages = await repos.messages.listByChat(chat.id);
    expect(messages.at(-1)?.role).toBe('ASSISTANT');
    expect(messages.at(-1)?.content).toContain(ANSWER);

    expect(() => {
      assertNoCanary(JSON.stringify([messages, toolCalls, finished, stream]));
    }).not.toThrow();
  });
});
