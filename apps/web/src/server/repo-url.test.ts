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
   * Plain http is allowed when the operator writes the origin out in full: the end-to-end harness
   * clones from a local git server, and forcing https there would mean the suite could not
   * exercise the path.
   */
  it('accepts http for an origin the operator listed', () => {
    const hosts = ['http://git.internal:8080'];
    expect(assertRepoUrlAllowed('http://git.internal:8080/acme/sample.git', hosts).port).toBe(
      '8080',
    );
  });

  /**
   * A bare entry authorises https on the default port and nothing else. The PAT is delivered to
   * whatever origin the URL names, so a cleartext or off-port clone of an allowed host is a
   * different destination and needs a different entry.
   */
  it('rejects a scheme or port the entry did not name', () => {
    expect(() => assertRepoUrlAllowed('http://github.com/acme/widgets', HOSTS)).toThrow(
      ValidationError,
    );
    expect(() => assertRepoUrlAllowed('https://github.com:8443/acme/widgets', HOSTS)).toThrow(
      ValidationError,
    );
  });

  /**
   * The list is matched whole, never as a substring: a host that merely ends with an allowed name
   * is a different machine and would receive the token.
   */
  it('rejects a host that only looks like an allowed one', () => {
    expect(() => assertRepoUrlAllowed('https://github.com.evil.test/a/b', HOSTS)).toThrow(
      ValidationError,
    );
    expect(() => assertRepoUrlAllowed('https://evil.com/a/b', ['com'])).toThrow(ValidationError);
  });

  /**
   * An empty list closes the door. A default forge appearing when the operator configured none
   * would send the token somewhere nobody asked for.
   */
  it('rejects everything when the list is empty', () => {
    expect(() => assertRepoUrlAllowed('https://github.com/acme/widgets', [])).toThrow(
      ValidationError,
    );
  });

  /**
   * A query string and a fragment are the other two places a token hides in a URL that is about
   * to become a clone command.
   */
  it('rejects a query string and a fragment', () => {
    expect(() => assertRepoUrlAllowed('https://github.com/a/b?token=x', HOSTS)).toThrow(
      ValidationError,
    );
    expect(() => assertRepoUrlAllowed('https://github.com/a/b#token=x', HOSTS)).toThrow(
      ValidationError,
    );
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
   * A URL that does not name exactly one owner and one repository cannot be cloned; refusing it
   * here beats a confusing clone failure inside a container minutes later.
   */
  it('rejects a URL that is not one owner and one repository', () => {
    expect(() => assertRepoUrlAllowed('https://github.com/', HOSTS)).toThrow(ValidationError);
    expect(() => assertRepoUrlAllowed('https://github.com/acme', HOSTS)).toThrow(ValidationError);
    expect(() => assertRepoUrlAllowed('https://github.com/a/b/tree/main', HOSTS)).toThrow(
      ValidationError,
    );
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
    expect(
      allowedRepoHosts({ ALLOWED_REPO_HOSTS: 'github.com, Git.Internal, HTTP://127.0.0.1:3907' }),
    ).toEqual(['github.com', 'git.internal', 'http://127.0.0.1:3907']);
  });
});
