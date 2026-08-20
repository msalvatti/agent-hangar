/** @vitest-environment node */
/**
 * Policy test: every route that accepts a repository URL applies the configured allow-list.
 *
 * Layer: unit.
 * Goal: the request contracts describe the shape of a repository URL and deliberately leave the
 * forge to configuration, so a handler that parses one of those bodies and forgets the allow-list
 * would accept any host on earth and send the stored PAT there. That omission is invisible in a
 * diff and green in every other test; this is what makes it fail. The rule is counted per route
 * rather than per file, because a module that guards one of its two routes still names the check.
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

/**
 * How a handler reads a request body; the second argument names the contract it is read with.
 *
 * A call with a nested parenthesis is not matched, so the count it feeds can only ever be too low
 * — the direction that under-reports rather than the one that would fail a compliant handler. The
 * per-file rule above is the backstop for such a call, because the module still names the contract.
 */
const BODY_PARSE_CALL = /parseJsonBody\([^)]*\)/gu;

/** Root of the server layer, the only place a request body is parsed. */
const SERVER_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * Counts the body parses that read a repository URL.
 *
 * @param source - A module's source text.
 * @returns How many parse sites in it carry a repository URL.
 */
function countRepoUrlParses(source: string): number {
  return [...source.matchAll(BODY_PARSE_CALL)].filter((match) =>
    REPO_URL_CONTRACTS.some((contract) => match[0].includes(contract)),
  ).length;
}

/**
 * Counts the allow-list checks a module performs.
 *
 * @param source - A module's source text.
 * @returns How many times it calls the host policy.
 */
function countHostPolicyCalls(source: string): number {
  return source.split(HOST_POLICY_CALL).length - 1;
}

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
   * Every module that names a contract carrying a repository URL is required to name the
   * allow-list check as well. A module that appears without it fails here rather than in
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

  /**
   * Presence per file is not the rule; the rule is one check per route. `handlers/jobs.ts` parses
   * two of these contracts, so a guard deleted from `createJob` would leave `updateJob`'s call
   * behind and the check above green while `POST /api/jobs` accepted any forge on earth. Counting
   * the parse sites against the checks is what makes that deletion visible.
   */
  it('applies the allow-list once per route, not once per file', () => {
    const short = listServerSources()
      .map((file) => ({ file, source: readFileSync(join(SERVER_ROOT, file), 'utf8') }))
      .filter(({ source }) => countHostPolicyCalls(source) < countRepoUrlParses(source))
      .map(({ file }) => file);
    expect(short).toEqual([]);
  });

  /**
   * The counter itself has to be able to fail, or the test above proves nothing: a rule that
   * cannot report a violation is indistinguishable from one that is never evaluated.
   */
  it('counts a route whose guard is missing as short of one', () => {
    const guarded = 'const body = await parseJsonBody(request, jobUpsertRequest);\n'.concat(
      'assertRepoUrlAllowed(body.repoUrl, hosts);\n',
    );
    expect(countRepoUrlParses(guarded)).toBe(1);
    expect(countHostPolicyCalls(guarded)).toBe(1);
    const unguarded = 'const body = await parseJsonBody(request, jobUpsertRequest);\n';
    expect(countRepoUrlParses(unguarded)).toBe(1);
    expect(countHostPolicyCalls(unguarded)).toBe(0);
  });
});
