/**
 * Unit tests for the per-execution credential hand-off.
 *
 * Layer: unit.
 * Goal: both credentials produce one file at the path the runtime reads and unlinks, either one
 * missing produces nothing at all, and the values are registered with the redactor so everything
 * the execution goes on to write is scrubbed against them.
 * Mocks: `createTestContainer`'s in-memory secrets service and its real redactor.
 */
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import { createTestContainer, FakeSecretsService } from '../testing/index.js';
import type { TestContainer } from '../testing/index.js';

import { CREDENTIALS_PATH } from './constants.js';
import { revealCredentialsFile } from './workspace-credentials.js';

/** A container whose secrets service holds exactly the credentials named. */
function withSecrets(seed: { GITHUB_PAT?: string; OPENAI_API_KEY?: string }): TestContainer {
  return createTestContainer({ secrets: new FakeSecretsService(seed) });
}

describe('revealCredentialsFile', () => {
  /**
   * The file the runner places: one path, one JSON object, both credentials under the names the
   * runtime reads them by. The runtime unlinks it as it reads it, so this file is the entire
   * window in which the values exist inside a workspace.
   */
  it('packs both credentials into the file the runtime reads', async () => {
    const container = withSecrets({ GITHUB_PAT: GITHUB_CANARY, OPENAI_API_KEY: OPENAI_CANARY });

    const file = await revealCredentialsFile(container);

    expect(file).toStrictEqual({
      path: CREDENTIALS_PATH,
      content: JSON.stringify({ githubToken: GITHUB_CANARY, openaiApiKey: OPENAI_CANARY }),
    });
  });

  /**
   * Either one missing means no file. A turn needs both — the PAT to clone and push, the key to
   * reach the model — so a file carrying only one would send an execution into a workspace that
   * cannot do the work, and the caller would have no way to tell it apart from a complete one.
   * Each credential is asked about on its own account: a check that only refused when *both* were
   * absent would hand over a half-filled file the moment one of them was configured.
   */
  it.each([
    ['the GitHub token is not configured', { OPENAI_API_KEY: OPENAI_CANARY }],
    ['the OpenAI key is not configured', { GITHUB_PAT: GITHUB_CANARY }],
    ['neither is configured', {}],
  ])('produces nothing when %s', async (_case, seed) => {
    expect(await revealCredentialsFile(withSecrets(seed))).toBeNull();
  });

  /**
   * The values are registered with the redactor here, where they exist, rather than by the caller.
   * Everything the execution then produces — including output from a container an earlier process
   * of this worker created — is scrubbed against them.
   */
  it('registers both credentials with the redactor', async () => {
    const container = withSecrets({ GITHUB_PAT: GITHUB_CANARY, OPENAI_API_KEY: OPENAI_CANARY });

    await revealCredentialsFile(container);

    const scrubbed = container.redactor.redact(
      `cloning with ${GITHUB_CANARY} and calling with ${OPENAI_CANARY}`,
    );
    expect(scrubbed).not.toContain(GITHUB_CANARY);
    expect(scrubbed).not.toContain(OPENAI_CANARY);
  });
});
