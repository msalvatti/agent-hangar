/**
 * Tests for scenario selection precedence (explicit > env > localStorage > default) and its
 * store-level effects.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { clearScenarioOverride, getScenario, initializeScenario, setScenario } from './scenario';
import { resetStore, store } from './store';

// A beforeEach (not afterEach) guarantees a clean slate regardless of hook execution order: the
// global vitest.ts setup's own afterEach (setScenario('default')) runs as an outer/last hook
// around this file's afterEach, so relying on afterEach here to clear the override would still
// leave the global hook's 'default' override in place at the start of the next test.
beforeEach(() => {
  clearScenarioOverride();
  delete process.env.NEXT_PUBLIC_API_MOCK_SCENARIO;
  localStorage.clear();
  resetStore();
});

describe('getScenario', () => {
  // With nothing set anywhere, the default scenario applies.
  it('defaults to "default" when nothing is set', () => {
    expect(getScenario()).toBe('default');
  });

  // localStorage is read when no explicit override or env var is set.
  it('reads from localStorage when set', () => {
    localStorage.setItem('ah-mock-scenario', 'infra-down');
    expect(getScenario()).toBe('infra-down');
  });

  // An invalid localStorage value is ignored, falling back to default.
  it('ignores an invalid localStorage value', () => {
    localStorage.setItem('ah-mock-scenario', 'not-a-real-scenario');
    expect(getScenario()).toBe('default');
  });

  // Outside a browser (no `localStorage` global — the mock API can run under a plain Node
  // environment too), the lookup is guarded rather than throwing.
  it('falls back to default when localStorage is unavailable', () => {
    const globalWithOptionalStorage = globalThis as { localStorage?: Storage };
    const original = globalWithOptionalStorage.localStorage;
    delete globalWithOptionalStorage.localStorage;
    try {
      expect(getScenario()).toBe('default');
    } finally {
      if (original !== undefined) {
        globalWithOptionalStorage.localStorage = original;
      }
    }
  });

  // The environment variable takes precedence over localStorage.
  it('prefers the env var over localStorage', () => {
    localStorage.setItem('ah-mock-scenario', 'infra-down');
    process.env.NEXT_PUBLIC_API_MOCK_SCENARIO = 'failing-turn';
    expect(getScenario()).toBe('failing-turn');
  });

  // An invalid env var value is ignored, falling through to localStorage.
  it('ignores an invalid env var value', () => {
    localStorage.setItem('ah-mock-scenario', 'infra-down');
    process.env.NEXT_PUBLIC_API_MOCK_SCENARIO = 'not-a-real-scenario';
    expect(getScenario()).toBe('infra-down');
  });

  // An explicit setScenario() call takes precedence over both env and localStorage.
  it('prefers an explicit setScenario() over the env var', () => {
    process.env.NEXT_PUBLIC_API_MOCK_SCENARIO = 'failing-turn';
    setScenario('expired-stream');
    expect(getScenario()).toBe('expired-stream');
  });

  // clearScenarioOverride() removes the explicit override, falling back to env/localStorage.
  it('clearScenarioOverride() restores the env/localStorage precedence', () => {
    setScenario('expired-stream');
    clearScenarioOverride();
    process.env.NEXT_PUBLIC_API_MOCK_SCENARIO = 'failing-turn';
    expect(getScenario()).toBe('failing-turn');
  });
});

describe('initializeScenario', () => {
  // Reading a scenario back from localStorage after a reload has to shape the store the same way
  // choosing it did: without this the documented reload flow leaves the store at its defaults and
  // the scenario has no visible effect at all.
  it('applies the store effects of a scenario read from localStorage', () => {
    localStorage.setItem('ah-mock-scenario', 'missing-settings');
    expect(initializeScenario()).toBe('missing-settings');
    expect(store.secrets).toEqual({});
  });

  // The environment variable is the other reload-surviving source and behaves identically.
  it('applies the store effects of a scenario read from the env var', () => {
    process.env.NEXT_PUBLIC_API_MOCK_SCENARIO = 'infra-down';
    expect(initializeScenario()).toBe('infra-down');
    expect(store.health.checks.docker.ok).toBe(false);
  });

  // With nothing selected anywhere the store is left exactly as seeded.
  it('leaves the store untouched for the default scenario', () => {
    expect(initializeScenario()).toBe('default');
    expect(store.health.ok).toBe(true);
    expect(Object.keys(store.secrets)).toHaveLength(2);
  });
});

describe('setScenario effects', () => {
  // missing-settings clears every stored secret.
  it('missing-settings clears the store secrets', () => {
    setScenario('missing-settings');
    expect(store.secrets).toEqual({});
  });

  // infra-down marks docker and redis unhealthy.
  it('infra-down marks docker and redis unhealthy', () => {
    setScenario('infra-down');
    expect(store.health.ok).toBe(false);
    expect(store.health.checks.docker.ok).toBe(false);
    expect(store.health.checks.redis.ok).toBe(false);
    expect(store.health.checks.db.ok).toBe(true);
  });

  // default and the turn-scoped scenarios (failing-turn, expired-stream) do not mutate the store.
  it.each(['default', 'failing-turn', 'expired-stream'] as const)(
    '%s does not mutate the store',
    (scenario) => {
      setScenario(scenario);
      expect(store.health.ok).toBe(true);
      expect(Object.keys(store.secrets)).toHaveLength(2);
    },
  );
});
