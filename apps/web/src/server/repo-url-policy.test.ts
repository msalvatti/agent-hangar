/** @vitest-environment node */
/**
 * Policy test: every route that accepts a repository URL applies the configured allow-list.
 *
 * Layer: unit.
 * Goal: the request contracts describe the shape of a repository URL and deliberately leave the
 * forge to configuration, so a handler that parses one of those bodies and forgets the allow-list
 * would accept any host on earth and send the stored PAT there. That omission is invisible in a
 * diff and green in every other test; this is what makes it fail.
 * Mocks: none; the source tree is read from disk.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Request contracts whose body carries a repository URL. */
const REPO_URL_CONTRACTS = ['createChatRequest', 'jobUpsertRequest', 'jobPatchRequest'];

/** The check every such handler must also perform. */
const HOST_POLICY_CALL = 'assertRepoUrlAllowed(';

/** Root of the server layer, the only place a request body is parsed. */
const SERVER_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * Lists every shipped TypeScript file of the server layer.
 *
 * Test files are skipped: a test may name a contract while asserting a rejection, and the rule is
 * about shipped code.
 *
 * @returns Paths relative to the server root.
 */
function listServerSources(): string[] {
  return readdirSync(SERVER_ROOT, { recursive: true, encoding: 'utf8' }).filter(
    (entry) => /\.tsx?$/u.test(entry) && !entry.includes('.test.'),
  );
}

describe('repository host policy', () => {
  /**
   * Every module that parses a body carrying a repository URL is required to name the allow-list
   * check as well. Two do today; a third that appears without it fails here rather than in
   * production, where the failure would be a token delivered to an unconfigured forge.
   */
  it('applies the allow-list wherever a repository URL is accepted', () => {
    const parsers = listServerSources()
      .map((file) => ({ file, source: readFileSync(join(SERVER_ROOT, file), 'utf8') }))
      .filter(({ source }) => REPO_URL_CONTRACTS.some((contract) => source.includes(contract)));
    expect(parsers.map(({ file }) => file)).not.toEqual([]);
    expect(
      parsers.filter(({ source }) => !source.includes(HOST_POLICY_CALL)).map(({ file }) => file),
    ).toEqual([]);
  });
});
