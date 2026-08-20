/**
 * Tests for `repoLabel`: the `owner/name` label a repository URL is shown as, on any origin.
 */
import { describe, expect, it } from 'vitest';

import { repoLabel } from './repo-label';

describe('repoLabel', () => {
  /**
   * The common case: a GitHub URL is shown as its short form.
   */
  it('shortens a github repository URL', () => {
    expect(repoLabel('https://github.com/acme/api')).toBe('acme/api');
  });

  /**
   * Rule this protects: the label is a display concern, not forge policy. A repository on a forge
   * the operator configured must read the same as one on github.com — anything else would push a
   * copy of `ALLOWED_REPO_HOSTS` into a browser that cannot know it.
   */
  it('shortens a repository URL on any other origin, scheme and port', () => {
    expect(repoLabel('https://git.acme.test/acme/infra')).toBe('acme/infra');
    expect(repoLabel('http://127.0.0.1:3907/acme/sample')).toBe('acme/sample');
  });

  /**
   * The clone suffix is not part of the name.
   */
  it('drops a .git suffix', () => {
    expect(repoLabel('https://github.com/acme/api.git')).toBe('acme/api');
  });

  /**
   * Names a forge allows (dots, dashes, underscores) survive unchanged.
   */
  it('keeps dots, dashes and underscores in either segment', () => {
    expect(repoLabel('https://github.com/acme-labs/my_repo.js')).toBe('acme-labs/my_repo.js');
  });

  /**
   * A value that names anything other than one repository is shown as-is rather than dropped:
   * it is still the repository the chat or job runs against.
   */
  it.each([
    'not-a-url',
    'https://github.com/acme',
    'https://github.com/acme/api/tree/main',
    'https://github.com/acme/not a repo',
  ])('falls back to the raw value for %s', (input) => {
    expect(repoLabel(input)).toBe(input);
  });
});
