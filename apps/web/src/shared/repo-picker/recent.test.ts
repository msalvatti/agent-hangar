/**
 * Tests for the recently-used-repos list: cap, dedupe, and the SSR (no localStorage) guard.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { getRecentRepos, pushRecentRepo } from './recent';

afterEach(() => {
  localStorage.clear();
});

describe('recent repos', () => {
  // Nothing recorded yet returns an empty list.
  it('returns an empty list when nothing was pushed', () => {
    expect(getRecentRepos()).toEqual([]);
  });

  // pushRecentRepo() puts the pushed repo first.
  it('records a pushed repo as most recent', () => {
    pushRecentRepo('acme/api');
    expect(getRecentRepos()).toEqual(['acme/api']);
  });

  // Pushing an already-recorded repo moves it to the front instead of duplicating it.
  it('dedupes: pushing an existing repo moves it to the front', () => {
    pushRecentRepo('acme/api');
    pushRecentRepo('acme/web');
    pushRecentRepo('acme/api');
    expect(getRecentRepos()).toEqual(['acme/api', 'acme/web']);
  });

  // The list is capped at 5 entries, dropping the oldest.
  it('caps the list at 5 entries', () => {
    for (const name of ['a/1', 'a/2', 'a/3', 'a/4', 'a/5', 'a/6']) {
      pushRecentRepo(name);
    }
    expect(getRecentRepos()).toEqual(['a/6', 'a/5', 'a/4', 'a/3', 'a/2']);
  });

  // A malformed stored value is ignored rather than thrown.
  it('ignores a malformed stored value', () => {
    localStorage.setItem('ah-recent-repos', 'not json');
    expect(getRecentRepos()).toEqual([]);
  });

  // A stored value that isn't an array of strings is ignored.
  it('ignores a stored value that is not a string array', () => {
    localStorage.setItem('ah-recent-repos', JSON.stringify({ not: 'an array' }));
    expect(getRecentRepos()).toEqual([]);
  });

  // Outside the browser (no localStorage), both functions are safe no-ops.
  it('is a safe no-op without localStorage (SSR guard)', () => {
    const original = globalThis.localStorage;
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(() => {
      pushRecentRepo('acme/api');
    }).not.toThrow();
    expect(getRecentRepos()).toEqual([]);
    globalThis.localStorage = original;
  });
});
