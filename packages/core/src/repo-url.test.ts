/**
 * Tests for the repository-URL rules shared by every boundary a repository URL crosses.
 *
 * Layer: unit (pure).
 * Goal: a URL that could carry a credential is refused everywhere, so a PAT can never reach a
 * clone command or a container's process arguments instead of travelling via `GIT_ASKPASS`.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { credentialFreeUrl, isCredentialFreeUrl, isPlainRepoUrl, repoUrl } from './repo-url.js';
import { GITHUB_CANARY } from './testing/canaries.js';

describe('credentialFreeUrl', () => {
  /** The shape the product actually uses must keep working, on any host. */
  it.each([
    'https://github.com/acme/widgets',
    'https://github.com/acme/widgets.git',
    'https://git.example.test/team/project.git',
  ])('accepts the credential-free https URL %s', (value) => {
    expect(credentialFreeUrl.safeParse(value).success).toBe(true);
  });

  /** Each rejected shape is a place a token hides on its way into a clone command. */
  it.each([
    ['userinfo', `https://x-access-token:${GITHUB_CANARY}@github.com/acme/widgets`],
    ['a query string', `https://github.com/acme/widgets?token=${GITHUB_CANARY}`],
    ['a fragment', `https://github.com/acme/widgets#access_token=${GITHUB_CANARY}`],
    ['a bare question mark', 'https://github.com/acme/widgets?'],
    ['a bare hash', 'https://github.com/acme/widgets#'],
    ['a non-default port', 'https://github.com:8443/acme/widgets'],
    ['cleartext http', 'http://github.com/acme/widgets'],
    ['a non-URL', 'not a url'],
  ])('rejects %s', (_name, value) => {
    expect(credentialFreeUrl.safeParse(value).success).toBe(false);
  });

  /** The refusal must not quote the offending value, which is how a canary escapes in an error. */
  it('never echoes the rejected URL in its message', () => {
    const result = credentialFreeUrl.safeParse(
      `https://x-access-token:${GITHUB_CANARY}@github.com/acme/widgets`,
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('TESTCANARY');
  });
});

describe('repoUrl', () => {
  /** The API boundary adds forge and path policy on top of the credential-free rule. */
  it.each(['https://github.com/acme/widgets', 'https://github.com/acme/widgets.git'])(
    'accepts %s',
    (value) => {
      expect(repoUrl.safeParse(value).success).toBe(true);
    },
  );

  /** Host-suffix and extra-segment shapes are refused even though they carry no credential. */
  it.each([
    ['a host suffix attack', 'https://github.com.evil.test/acme/widgets'],
    ['another forge', 'https://git.example.test/acme/widgets'],
    ['an extra path segment', 'https://github.com/acme/widgets/tree/main'],
    ['a missing segment', 'https://github.com/acme'],
  ])('rejects %s', (_name, value) => {
    expect(repoUrl.safeParse(value).success).toBe(false);
  });
});

describe('the predicates', () => {
  /** Exported so a caller can reuse the rule without going through Zod. */
  it('agree with the schemas they back', () => {
    expect(isCredentialFreeUrl('https://github.com/acme/widgets')).toBe(true);
    expect(isCredentialFreeUrl(`https://u:${GITHUB_CANARY}@github.com/a/b`)).toBe(false);
    expect(isPlainRepoUrl('https://github.com/acme/widgets')).toBe(true);
    expect(isPlainRepoUrl('https://github.com/acme/widgets/extra')).toBe(false);
  });
});
