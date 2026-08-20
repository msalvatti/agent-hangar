/**
 * Unit tests for the selector contract.
 *
 * Layer: unit test.
 */
import { describe, expect, it } from 'vitest';

import { SECRET_LABELS, STATUS_LABEL, TEST_IDS, secretFieldId, secretMaskId } from './selectors';

describe('the selector contract', () => {
  /** The per-key ids the settings page renders are built from the key, not spelled twice. */
  it('builds the settings ids from the credential key', () => {
    expect(secretFieldId('GITHUB_PAT')).toBe(TEST_IDS.secretFieldGithubPat);
    expect(secretMaskId('GITHUB_PAT')).toBe(TEST_IDS.secretMaskGithubPat);
    expect(secretFieldId('OPENAI_API_KEY')).toBe(TEST_IDS.secretFieldOpenaiKey);
    expect(secretMaskId('OPENAI_API_KEY')).toBe(TEST_IDS.secretMaskOpenaiKey);
  });

  /** Two ids that collide would make two locators point at the same element. */
  it('keeps every test id distinct', () => {
    const ids = Object.values(TEST_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /** Both credentials have the label the settings page uses as their input's name. */
  it('names both credentials', () => {
    expect(Object.keys(SECRET_LABELS)).toEqual(['GITHUB_PAT', 'OPENAI_API_KEY']);
  });

  /** The status labels are the words the pill renders; a spec waits on exactly these. */
  it('spells the status label of every phase', () => {
    expect(Object.values(STATUS_LABEL)).toEqual([
      'Queued',
      'Preparing',
      'Running',
      'Done',
      'Failed',
      'Cancelled',
    ]);
  });
});
