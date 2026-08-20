/**
 * Tests for the repository-URL rules shared by every boundary a repository URL crosses.
 *
 * Layer: unit (pure).
 * Goal: a URL that could carry a credential is refused everywhere, so a PAT can never reach a
 * clone command or a container's process arguments instead of travelling via `GIT_ASKPASS`; and
 * the set of origins a clone may reach is exactly the one the operator configured.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import {
  credentialFreeUrl,
  isAllowedRepoUrl,
  isCredentialFreeUrl,
  isPlainRepoUrl,
  parseAllowedRepoOrigin,
  repoUrl,
  repoUrlForHosts,
} from './repo-url.ts';
import { GITHUB_CANARY } from './testing/canaries.ts';

describe('credentialFreeUrl', () => {
  /** The shape the product actually uses must keep working, on any host. */
  it.each([
    'https://github.com/acme/widgets',
    'https://github.com/acme/widgets.git',
    'https://git.example.test/team/project.git',
    // The end-to-end harness clones from a local git server over plain http on a chosen port.
    // Scheme, host and port are the host's policy (`ALLOWED_REPO_HOSTS`), not a credential.
    'http://127.0.0.1:3907/sample.git',
    'http://gitserver:8080/sample.git',
    // An `@` in the PATH is ordinary and must not be mistaken for userinfo.
    'https://git.example.test/acme/@scope.git',
  ])('accepts the credential-free URL %s', (value) => {
    expect(credentialFreeUrl.safeParse(value).success).toBe(true);
  });

  /** Each rejected shape is a place a token hides on its way into a clone command. */
  it.each([
    ['userinfo', `https://x-access-token:${GITHUB_CANARY}@github.com/acme/widgets`],
    // `URL` normalises an empty userinfo away, so these parse with empty username and password
    // while the stored string keeps the `@` that git still reads as a userinfo form.
    ['an empty userinfo', 'https://@github.com/acme/widgets'],
    ['an empty user and password', 'https://:@github.com/acme/widgets'],
    ['a username with no password', 'https://x-access-token@github.com/acme/widgets'],
    ['a query string', `https://github.com/acme/widgets?token=${GITHUB_CANARY}`],
    ['a fragment', `https://github.com/acme/widgets#access_token=${GITHUB_CANARY}`],
    ['a bare question mark', 'https://github.com/acme/widgets?'],
    ['a bare hash', 'https://github.com/acme/widgets#'],
    // Not credential-bearing, but not a scheme this product ever clones over either.
    ['an ssh URL', 'ssh://git@github.com/acme/widgets.git'],
    ['a file URL', 'file:///etc/passwd'],
    ['the unauthenticated git protocol', 'git://github.com/acme/widgets.git'],
    ['a non-URL', 'not a url'],
    // WHATWG parsing repairs these into a normal URL, but the ORIGINAL string is what reaches git,
    // which reads the colon form as an scp-style ssh target rather than HTTPS.
    ['a scheme with no slashes', 'https:github.com/acme/widgets'],
    ['a scheme with one slash', 'https:/github.com/acme/widgets'],
    ['a backslash variant', 'https:\\\\github.com/acme/widgets'],
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
  /** The shape a clone needs — one owner, one repository — on whatever origin was configured. */
  it.each([
    'https://github.com/acme/widgets',
    'https://github.com/acme/widgets.git',
    // A self-hosted forge, and the local git server the end-to-end suite clones from: the origin
    // is the operator's decision, so the shape rule must not pin one.
    'https://git.example.test/acme/widgets.git',
    'http://127.0.0.1:3907/acme/sample.git',
  ])('accepts %s', (value) => {
    expect(repoUrl.safeParse(value).success).toBe(true);
  });

  /** Everything the shape rule refuses is refused whatever origin the URL names. */
  it.each([
    ['an extra path segment', 'https://github.com/acme/widgets/tree/main'],
    ['a missing segment', 'https://github.com/acme'],
    ['no path at all', 'https://github.com/'],
    ['a path segment that is not a repository name', 'https://github.com/acme/wid gets'],
    ['userinfo', 'https://user:secret@github.com/acme/widgets'],
    ['a query string', 'https://github.com/acme/widgets?token=x'],
    ['a fragment', 'https://github.com/acme/widgets#x'],
    ['a scheme git would clone over some other transport', 'ssh://github.com/acme/widgets'],
  ])('rejects %s', (_name, value) => {
    expect(repoUrl.safeParse(value).success).toBe(false);
  });
});

describe('parseAllowedRepoOrigin', () => {
  /**
   * An entry names an origin, and both sides of the later comparison are normalised by the same
   * `URL` implementation: a bare host means https on the default port, and a forge reached over
   * plaintext or on another port has to say so.
   */
  it.each([
    ['github.com', 'https://github.com'],
    ['github.com:443', 'https://github.com'],
    ['https://github.com', 'https://github.com'],
    ['http://127.0.0.1:3907', 'http://127.0.0.1:3907'],
    ['http://[::1]:3907', 'http://[::1]:3907'],
    ['http://127.1', 'http://127.0.0.1'],
  ])('normalises %s to %s', (entry, origin) => {
    expect(parseAllowedRepoOrigin(entry)).toBe(origin);
  });

  /**
   * Cleartext to a host that is not loopback is authorised when the operator spells it out. The
   * local forge a workspace container clones from is published on the host gateway, which is a
   * remote address from inside the container, so a loopback-only rule would refuse the one
   * plaintext case the product needs. Unlike `GITHUB_API_BASE_URL` — which carries the PAT in an
   * `Authorization` header on every call and so admits `http` only to this machine — a repository
   * URL reaches `git`, whose askpass helper requires `https` before it releases anything.
   */
  it('authorises a plaintext origin that is not loopback when the entry says so', () => {
    expect(parseAllowedRepoOrigin('http://host.docker.internal:3907')).toBe(
      'http://host.docker.internal:3907',
    );
    expect(
      isAllowedRepoUrl('http://host.docker.internal:3907/acme/sample.git', [
        'http://host.docker.internal:3907',
      ]),
    ).toBe(true);
  });

  /**
   * An entry is a bare authority. Anything else is a typo the operator would otherwise never see
   * — it can never match a URL — and a userinfo entry would suggest the list is a place to put a
   * credential.
   */
  it.each([
    ['a path', 'github.com/acme'],
    ['a trailing slash', 'github.com/'],
    ['userinfo', 'user@github.com'],
    ['a query string', 'github.com?x=1'],
    ['a fragment', 'github.com#x'],
    ['a backslash', 'github.com\\acme'],
    ['nothing at all', ''],
    ['a scheme and nothing else', 'https://'],
    ['an unbracketed IPv6 literal', '::1'],
  ])('refuses an entry with %s', (_name, entry) => {
    expect(parseAllowedRepoOrigin(entry)).toBeNull();
  });
});

describe('isAllowedRepoUrl', () => {
  /** The configured forge, and only in the spelling the operator authorised. */
  it.each([
    ['the default forge', 'https://github.com/acme/widgets', ['github.com']],
    ['a `.git` suffix', 'https://github.com/acme/widgets.git', ['github.com']],
    [
      'a local git server on a chosen port over plaintext',
      'http://127.0.0.1:3907/acme/sample.git',
      ['github.com', 'http://127.0.0.1:3907'],
    ],
    ['a host written in another case', 'https://GitHub.com/acme/widgets', ['github.com']],
    // A single-label entry is an origin like any other: it authorises `https://com` itself and
    // nothing under that suffix, which is the whole-origin rule and not a special case.
    ['the exact origin a single-label entry names', 'https://com/acme/widgets', ['com']],
  ])('accepts %s', (_name, value, hosts) => {
    expect(isAllowedRepoUrl(value, hosts)).toBe(true);
  });

  /**
   * Each rejection is a way the allow-list could leak the PAT to an origin the operator never
   * named: a suffix that reads like the allowed host, an entry matched as a substring, a
   * cleartext or off-port clone of a host allowed over https, and an empty list.
   */
  it.each([
    ['a host suffix attack', 'https://github.com.evil.test/acme/widgets', ['github.com']],
    ['a substring of the entry', 'https://evil.com/acme/widgets', ['com']],
    ['a host that is a substring of the URL host', 'https://mygithub.com/a/b', ['github.com']],
    ['cleartext to a host allowed over https', 'http://github.com/acme/widgets', ['github.com']],
    ['another port on an allowed host', 'https://github.com:8443/acme/widgets', ['github.com']],
    ['a port the entry did not name', 'http://127.0.0.1:9/a/b', ['http://127.0.0.1:3907']],
    ['a forge that is not listed', 'https://git.example.test/a/b', ['github.com']],
    ['an unparseable entry', 'https://github.com/a/b', ['github.com/a']],
    ['an empty list', 'https://github.com/acme/widgets', []],
    ['userinfo on an allowed host', 'https://user:secret@github.com/a/b', ['github.com']],
    ['a path that is not one repository', 'https://github.com/a/b/tree/main', ['github.com']],
    ['a query string on an allowed host', 'https://github.com/a/b?token=x', ['github.com']],
  ])('rejects %s', (_name, value, hosts) => {
    expect(isAllowedRepoUrl(value, hosts)).toBe(false);
  });
});

describe('repoUrlForHosts', () => {
  /** The schema is the predicate, so a write boundary and a caller cannot drift apart. */
  it('accepts a repository on a configured origin and refuses one that is not', () => {
    const schema = repoUrlForHosts(['github.com', 'http://127.0.0.1:3907']);
    expect(schema.safeParse('https://github.com/acme/widgets').success).toBe(true);
    expect(schema.safeParse('http://127.0.0.1:3907/acme/sample.git').success).toBe(true);
    expect(schema.safeParse('https://git.example.test/acme/widgets').success).toBe(false);
    expect(schema.safeParse('not a url').success).toBe(false);
  });

  /**
   * The list is a parameter, so an empty one closes the door. A default forge appearing when the
   * operator configured none would send the PAT somewhere nobody asked for.
   */
  it('accepts nothing when the list is empty', () => {
    expect(repoUrlForHosts([]).safeParse('https://github.com/acme/widgets').success).toBe(false);
  });

  /** The refusal must not quote the offending value, which is how a canary escapes in an error. */
  it('never echoes the rejected URL in its message', () => {
    const result = repoUrlForHosts(['github.com']).safeParse(
      `https://x-access-token:${GITHUB_CANARY}@github.com/acme/widgets`,
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('TESTCANARY');
  });
});

describe('the predicates', () => {
  /** Exported so a caller can reuse the rule without going through Zod. */
  it('agree with the schemas they back', () => {
    expect(isCredentialFreeUrl('https://github.com/acme/widgets')).toBe(true);
    expect(isCredentialFreeUrl(`https://u:${GITHUB_CANARY}@github.com/a/b`)).toBe(false);
    expect(isPlainRepoUrl('https://github.com/acme/widgets')).toBe(true);
    expect(isPlainRepoUrl('https://github.com/acme/widgets/extra')).toBe(false);
    expect(isAllowedRepoUrl('https://github.com/acme/widgets', ['github.com'])).toBe(true);
    expect(isAllowedRepoUrl('https://github.com/acme/widgets', ['git.example.test'])).toBe(false);
  });
});
