/** @vitest-environment node */
/**
 * Unit tests for the repository host policy.
 *
 * Layer: unit.
 * Goal: a URL that reaches a clone command names an allowed host and carries no credential.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { ValidationError } from './errors';
import { allowedRepoHosts, assertRepoUrlAllowed, REPO_URL_NOT_ALLOWED } from './repo-url';

const HOSTS = ['github.com'];

describe('assertRepoUrlAllowed', () => {
  /**
   * The ordinary case the contracts already admit: an https GitHub URL with owner and repository.
   */
  it('accepts an allowed https repository URL', () => {
    expect(assertRepoUrlAllowed('https://github.com/acme/widgets', HOSTS).hostname).toBe(
      'github.com',
    );
  });

  /**
   * Host comparison is case-insensitive, because DNS is: `GitHub.com` and `github.com` are one
   * host, and treating them as two would reject a URL the user pasted from a browser bar.
   */
  it('compares hosts case-insensitively', () => {
    expect(() => assertRepoUrlAllowed('https://GitHub.com/acme/widgets', HOSTS)).not.toThrow();
  });

  /**
   * Plain http is allowed when the operator lists the host: the end-to-end harness clones from a
   * local git server, and forcing https there would mean the suite could not exercise the path.
   */
  it('accepts http for a host the operator listed', () => {
    const hosts = ['git.internal'];
    expect(assertRepoUrlAllowed('http://git.internal:8080/sample.git', hosts).port).toBe('8080');
  });

  /**
   * A host that is not on the list is refused whatever else the URL says: this is the operator's
   * switch, and it can only ever narrow what the request contracts already accept.
   */
  it('rejects a host that is not on the list', () => {
    expect(() => assertRepoUrlAllowed('https://evil.example/acme/widgets', HOSTS)).toThrow(
      ValidationError,
    );
  });

  /**
   * Userinfo is the classic place a token hides, and this URL ends up on a `git clone` command
   * line where it would be visible in the container's process list.
   */
  it('rejects a URL carrying credentials', () => {
    expect(() => assertRepoUrlAllowed('https://user:token@github.com/a/b', HOSTS)).toThrow(
      ValidationError,
    );
    expect(() => assertRepoUrlAllowed('https://user@github.com/a/b', HOSTS)).toThrow(
      ValidationError,
    );
  });

  /**
   * Anything git would treat as a different transport is refused: `file://` and `ssh://` reach
   * places the operator's host list does not describe.
   */
  it('rejects a non-http scheme and an unparseable URL', () => {
    expect(() => assertRepoUrlAllowed('ssh://github.com/a/b', HOSTS)).toThrow(ValidationError);
    expect(() => assertRepoUrlAllowed('not a url', HOSTS)).toThrow(ValidationError);
  });

  /**
   * A URL with no path names no repository, so it cannot be cloned; refusing it here beats a
   * confusing clone failure inside a container minutes later.
   */
  it('rejects a URL with no repository path', () => {
    expect(() => assertRepoUrlAllowed('https://github.com/', HOSTS)).toThrow(ValidationError);
  });

  /**
   * The code is stable so the UI can show a message about the allow-list rather than a generic
   * validation error.
   */
  it('reports a stable code', () => {
    const error = (() => {
      try {
        assertRepoUrlAllowed('https://evil.example/a/b', HOSTS);
      } catch (caught) {
        return caught as ValidationError;
      }
      throw new Error('expected a rejection');
    })();
    expect(error.code).toBe(REPO_URL_NOT_ALLOWED);
    expect(error.status).toBe(400);
  });
});

describe('allowedRepoHosts', () => {
  /**
   * The list is read from configuration on every call rather than cached, so a container built
   * with a different environment sees a different policy.
   */
  it('reads the configured hosts', () => {
    expect(allowedRepoHosts({ ALLOWED_REPO_HOSTS: 'github.com, Git.Internal' })).toEqual([
      'github.com',
      'git.internal',
    ]);
  });
});
