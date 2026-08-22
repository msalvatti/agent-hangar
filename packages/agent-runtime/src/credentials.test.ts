/**
 * Unit tests for taking a turn's credentials off the filesystem.
 *
 * Layer: unit.
 * Goal: the document is read, the file is gone afterwards whatever the document turned out to be,
 * a failure to remove it fails the call rather than being swallowed, and no message ever quotes
 * what the file held.
 * Mocks: none; a real temporary directory holds the file so its removal — and a removal that
 * cannot happen — are observed rather than described.
 */
import { chmod, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CredentialsUnavailable, takeWorkspaceCredentials } from './credentials.js';
import { makeTempDir, removeTempDir } from './testing/temp-dir.js';

/** Permissions that let the owner read a directory but not unlink anything in it. */
const NO_UNLINK_MODE = 0o500;

/** The ordinary owner-only directory mode, restored so the temporary tree can be removed. */
const NORMAL_DIRECTORY_MODE = 0o700;

let directory: string;
let file: string;

beforeEach(async () => {
  directory = await makeTempDir('credentials');
  file = path.join(directory, 'credentials.json');
});

afterEach(async () => {
  await chmod(directory, NORMAL_DIRECTORY_MODE);
  await removeTempDir(directory);
});

/**
 * Places a credentials document for the call under test.
 *
 * @param content - Exactly what the file holds.
 */
async function place(content: string): Promise<void> {
  await writeFile(file, content, 'utf8');
}

describe('takeWorkspaceCredentials', () => {
  /** The one case that must work: both credentials come back, and the file does not survive it. */
  it('returns both credentials and unlinks the file', async () => {
    await place(JSON.stringify({ githubToken: GITHUB_CANARY, openaiApiKey: OPENAI_CANARY }));

    await expect(takeWorkspaceCredentials(file)).resolves.toStrictEqual({
      githubToken: GITHUB_CANARY,
      openaiApiKey: OPENAI_CANARY,
    });
    await expect(stat(file)).rejects.toThrow();
  });

  /** Extra keys are the host's business; what matters is that the two required ones are there. */
  it('ignores fields the document carries beyond the two credentials', async () => {
    await place(
      JSON.stringify({ githubToken: GITHUB_CANARY, openaiApiKey: OPENAI_CANARY, extra: 1 }),
    );

    await expect(takeWorkspaceCredentials(file)).resolves.toStrictEqual({
      githubToken: GITHUB_CANARY,
      openaiApiKey: OPENAI_CANARY,
    });
  });

  /**
   * A workspace nobody placed credentials for cannot run a turn, and the message has to name the
   * path so an operator can see which side of the handoff is missing.
   */
  it('reports a file that is not there, naming the path', async () => {
    const failure = await takeWorkspaceCredentials(file).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CredentialsUnavailable);
    // The whole message, not a fragment of it: with the read's own failure swallowed, execution
    // carries on to the unlink, which fails too because the file is not there, and the turn is
    // then told the credentials could not be *removed* — a different thing to go and look at.
    expect((failure as Error).message).toBe(`no workspace credentials at ${file}`);
    // Named so an operator can tell it apart from the model's own errors in a log.
    expect((failure as Error).name).toBe('CredentialsUnavailable');
    // Without the cause there is nothing left saying which syscall failed or why.
    expect((failure as Error).cause).toMatchObject({ code: 'ENOENT' });
  });

  /**
   * The value of the whole arrangement is the unlink, so a read that cannot be followed by one is
   * a failure and not a warning: succeeding here would leave the credentials readable inside the
   * container for as long as it stands, which is exactly the state this replaced.
   */
  it('fails when the file was read but could not be removed', async () => {
    await place(JSON.stringify({ githubToken: GITHUB_CANARY, openaiApiKey: OPENAI_CANARY }));
    await chmod(directory, NO_UNLINK_MODE);

    const failure = await takeWorkspaceCredentials(file).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CredentialsUnavailable);
    expect((failure as Error).message).toBe(
      `workspace credentials at ${file} could not be removed`,
    );
    expect((failure as Error).name).toBe('CredentialsUnavailable');
    // The unlink's own failure is the only thing that says why it could not be removed.
    expect((failure as Error).cause).toMatchObject({ code: 'EACCES' });
    // Still there, which is the state the failure is reporting.
    await expect(stat(file)).resolves.toBeTruthy();
  });

  /**
   * A document that cannot be understood is still a document holding two credentials: it is taken
   * away before it is judged, and what it held is never quoted back — a JSON parse error repeats a
   * prefix of its input, and a schema error repeats the offending value.
   */
  it.each([
    ['is not JSON', `{"githubToken": ${GITHUB_CANARY}`, 'not valid JSON'],
    ['is missing a credential', JSON.stringify({ githubToken: GITHUB_CANARY }), 'openaiApiKey'],
    [
      'carries an empty credential',
      JSON.stringify({ githubToken: GITHUB_CANARY, openaiApiKey: '' }),
      'openaiApiKey',
    ],
    ['is not an object at all', JSON.stringify(GITHUB_CANARY), 'incomplete'],
  ])('refuses a document that %s, without quoting it', async (_name, content, expected) => {
    await place(content);

    const failure = await takeWorkspaceCredentials(file).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CredentialsUnavailable);
    expect((failure as Error).message).toContain(expected);
    expect(() => {
      assertNoCanary((failure as Error).message);
    }).not.toThrow();
    await expect(stat(file)).rejects.toThrow();
  });

  /**
   * A document missing both credentials is the case that shows whether the field names are being
   * listed or merely concatenated: with one name the separator never appears, so a message that
   * would read `githubTokenopenaiApiKey` looks correct until the day two of them are wrong at once.
   */
  it('lists every field the document failed on, separated', async () => {
    await place(JSON.stringify({ unrelated: true }));

    const failure = await takeWorkspaceCredentials(file).catch((error: unknown) => error);

    expect((failure as Error).message).toBe(
      `workspace credentials at ${file} are incomplete (githubToken, openaiApiKey)`,
    );
  });
});
