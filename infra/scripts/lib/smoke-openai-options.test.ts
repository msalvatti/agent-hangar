/**
 * Unit tests for the smoke check's command line.
 *
 * Layer: unit.
 * Goal: the defaults make `pnpm smoke:openai` on its own the whole interface; every malformed or
 * under-specified command line is refused with the reason rather than guessed at; and the base URL
 * is reduced to its origin, which is what keeps user information an operator typed into it out of
 * everything downstream.
 * Mocks: none; the unit is pure.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BRANCH,
  DEFAULT_REPO_URL,
  DEFAULT_TIMEOUT_SECONDS,
  resolveOptions,
  SETTINGS_MISSING_MESSAGE,
  SMOKE_PROMPT,
  USAGE,
} from './smoke-openai-options.js';

/** Base URL the resolved options are compared against. */
const BASE_URL = 'http://127.0.0.1:3500';

describe('resolveOptions', () => {
  /**
   * With no flags the check runs against this checkout's instance and the pinned public
   * repository, so `pnpm smoke:openai` on its own is the whole interface.
   */
  it('derives the instance URL from the resolved web port', () => {
    expect(resolveOptions({}, { WEB_PORT: '3500' })).toEqual({
      baseUrl: BASE_URL,
      repoUrl: DEFAULT_REPO_URL,
      branch: DEFAULT_BRANCH,
      timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
      keep: false,
    });
  });

  /**
   * An environment that names no port is not a reason to refuse: the default port block is what a
   * checkout that never ran `pnpm setup` would serve on.
   */
  it('falls back to the default web port', () => {
    expect(resolveOptions({}, {}).baseUrl).toBe('http://127.0.0.1:3000');
  });

  /**
   * The base URL is reduced to its origin, which is what makes the promise "no credential reaches
   * the output" hold even for an operator who typed one into the URL: `URL.origin` drops user
   * information, path and query by construction rather than by a filter that could miss a spelling.
   */
  it('reduces the base URL to its origin', () => {
    expect(resolveOptions({ 'base-url': 'http://user:pw@127.0.0.1:3500/x?y=1' }, {}).baseUrl).toBe(
      BASE_URL,
    );
  });

  /**
   * Every way of getting the command line wrong is refused with the reason, because the
   * alternative is a check that runs against something other than what was asked for.
   */
  it.each([
    [
      'a base URL that is not a URL',
      { 'base-url': 'not a url' },
      '--base-url must be an absolute http(s) URL',
    ],
    [
      'a base URL on another scheme',
      { 'base-url': 'ftp://127.0.0.1' },
      '--base-url must be an absolute http(s) URL',
    ],
    ['a flag with no value', { 'base-url': true as const }, '--base-url needs a value'],
    [
      'a repository with no branch',
      { repo: 'https://github.com/o/r' },
      '--branch is required with --repo: the default branch cannot be discovered',
    ],
    [
      'a repository URL carrying credentials',
      { repo: 'https://u:t@github.com/o/r', branch: 'main' },
      '--repo must be <scheme>://<host>/<owner>/<repository>, with no credentials, query string or fragment',
    ],
    [
      'a repository URL that is not one',
      { repo: 'https://github.com/o', branch: 'main' },
      '--repo must be <scheme>://<host>/<owner>/<repository>, with no credentials, query string or fragment',
    ],
    [
      'a timeout that is not a number',
      { timeout: 'soon' },
      '--timeout must be a whole number of seconds greater than zero',
    ],
    [
      'a timeout of zero',
      { timeout: '0' },
      '--timeout must be a whole number of seconds greater than zero',
    ],
    [
      'a fractional timeout',
      { timeout: '1.5' },
      '--timeout must be a whole number of seconds greater than zero',
    ],
  ])('refuses %s', (_case, flags, message) => {
    // The message, not merely the throw: it is printed next to the usage line and is the whole of
    // what tells an operator which flag to correct. A refusal that says nothing sends them to read
    // the source of a script they were trying to run.
    expect(() => resolveOptions(flags, {})).toThrow(message);
  });

  /**
   * A base URL on either scheme is accepted. The instance is served over plain HTTP on the loopback
   * address, and a developer running it behind a TLS proxy is naming the same instance — refusing
   * `https:` would make the check unusable there while reporting it as a bad command line.
   */
  it.each(['http://127.0.0.1:3500', 'https://127.0.0.1:3500'])('accepts %s', (baseUrl) => {
    expect(resolveOptions({ 'base-url': baseUrl }, {}).baseUrl).toBe(baseUrl);
  });

  /**
   * The flags that are accepted, together: a named repository with its branch, a longer deadline,
   * and the switch that leaves the chat in place for inspection.
   */
  it('accepts a fully specified command line', () => {
    expect(
      resolveOptions(
        { repo: 'https://github.com/o/r', branch: 'main', timeout: '60', keep: true },
        { WEB_PORT: '3500' },
      ),
    ).toEqual({
      baseUrl: BASE_URL,
      repoUrl: 'https://github.com/o/r',
      branch: 'main',
      timeoutMs: 60_000,
      keep: true,
    });
  });

  /**
   * The repository is printed in the report, so a URL carrying user information has to be refused
   * before anything is printed — and the refusal itself must not echo what it refused. The shape is
   * checked with the product's own schema rather than a second, weaker copy of it.
   */
  it('refuses a repository URL with credentials without echoing it', () => {
    expect(() =>
      resolveOptions({ repo: 'https://user:sekret@github.com/o/r', branch: 'main' }, {}),
    ).toThrow(/no credentials/);
    try {
      resolveOptions({ repo: 'https://user:sekret@github.com/o/r', branch: 'main' }, {});
      expect.unreachable('the malformed repository URL should have been refused');
    } catch (error) {
      expect(String(error)).not.toContain('sekret');
    }
  });
});

describe('the fixed contract of the check', () => {
  /**
   * The parts an operator reads or types, written out. Each is a promise this script makes to
   * whoever runs it, and none of them is derivable from anything else here: the pinned repository
   * and its branch are a pair chosen because the repository is public, tiny and stable, so a check
   * that started resolving them live would be measuring GitHub rather than this product; the prompt
   * is what makes the turn do both halves of what the check then asserts, and one that stopped
   * asking for the file would turn every run into a reported defect; and the usage line is what a
   * refused command line is printed beside.
   */
  it('states its defaults, its prompt and its usage', () => {
    expect(DEFAULT_REPO_URL).toBe('https://github.com/octocat/Hello-World');
    expect(DEFAULT_BRANCH).toBe('master');
    expect(SMOKE_PROMPT).toBe(
      'List the files in this repository, then create a file SMOKE.md containing the current date ' +
        'and a one-line summary of the repo. Do not push.',
    );
    expect(SETTINGS_MISSING_MESSAGE).toBe('Enter your keys in Settings first');
    expect(USAGE).toBe(
      'usage: pnpm smoke:openai [--base-url URL] [--repo URL --branch NAME] [--timeout SECONDS] [--keep]',
    );
  });
});
