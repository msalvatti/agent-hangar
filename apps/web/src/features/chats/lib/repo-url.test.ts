/**
 * Tests for the repository URL helpers: the `owner/name` ⇄ clone-URL round trip and the shapes
 * both sides refuse.
 */
import { describe, expect, it } from 'vitest';

import { parseRepoUrl, toRepoUrl } from './repo-url';

describe('toRepoUrl', () => {
  // The happy path produces the credential-free clone URL the contract accepts.
  it('builds a github clone URL from owner/name', () => {
    expect(toRepoUrl('acme/api')).toBe('https://github.com/acme/api.git');
  });

  // Names GitHub allows (dots, dashes, underscores) survive unchanged.
  it('keeps dots, dashes and underscores in either segment', () => {
    expect(toRepoUrl('acme-labs/my_repo.js')).toBe('https://github.com/acme-labs/my_repo.js.git');
  });

  // A missing or extra segment is a programming error, not a value to pass on to the API.
  it.each(['acme', 'acme/api/extra', '/api', 'acme/'])('rejects %s', (input) => {
    expect(() => toRepoUrl(input)).toThrow(/owner\/name/);
  });
});

describe('parseRepoUrl', () => {
  // The round trip closes: what `toRepoUrl` builds parses back to the same short name.
  it('round-trips a URL built by toRepoUrl', () => {
    expect(parseRepoUrl(toRepoUrl('acme/api'))).toEqual({ fullName: 'acme/api' });
  });

  // Stored chats may carry the suffix-free form, which parses the same way.
  it('parses a URL without the .git suffix', () => {
    expect(parseRepoUrl('https://github.com/acme/web')).toEqual({ fullName: 'acme/web' });
  });

  // Anything that is not a plain github.com repository URL yields null rather than a guess.
  it.each([
    'not-a-url',
    'https://gitlab.com/acme/api',
    'http://github.com/acme/api',
    'https://github.com/acme',
    'https://github.com/acme/api/tree/main',
  ])('returns null for %s', (input) => {
    expect(parseRepoUrl(input)).toBeNull();
  });
});
