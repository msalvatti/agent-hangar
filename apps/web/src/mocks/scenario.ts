/**
 * Selects which mock scenario the handlers behave as, so a specific behaviour (missing
 * credentials, infra down, a failing turn, an expired stream) can be exercised without a real
 * backend.
 *
 * Layer: mock (fixture data).
 */
import { store } from './store';

/** Every scenario the mock API can behave as. */
export type MockScenario =
  'default' | 'missing-settings' | 'infra-down' | 'failing-turn' | 'expired-stream';

const SCENARIO_STORAGE_KEY = 'ah-mock-scenario';

let currentScenario: MockScenario | null = null;

function isMockScenario(value: string): value is MockScenario {
  return (
    value === 'default' ||
    value === 'missing-settings' ||
    value === 'infra-down' ||
    value === 'failing-turn' ||
    value === 'expired-stream'
  );
}

function readLocalStorageScenario(): MockScenario | null {
  // `typeof` rather than `globalThis.localStorage === undefined`: the DOM lib types
  // `localStorage` as always present, so a direct equality check is flagged as provably false —
  // but it genuinely can be absent (this mock runs under Vitest's plain Node environment too).
  if (typeof globalThis.localStorage === 'undefined') {
    return null;
  }
  const value = globalThis.localStorage.getItem(SCENARIO_STORAGE_KEY);
  return value !== null && isMockScenario(value) ? value : null;
}

function applyScenarioEffects(scenario: MockScenario): void {
  if (scenario === 'missing-settings') {
    store.secrets = {};
    return;
  }
  if (scenario === 'infra-down') {
    store.health = {
      ...store.health,
      ok: false,
      checks: {
        ...store.health.checks,
        docker: { ok: false, detail: 'Cannot connect to the Docker daemon' },
        redis: { ok: false, detail: 'Connection refused' },
      },
    };
  }
}

/**
 * Reads the active scenario: an explicit {@link setScenario} call wins, then the
 * `NEXT_PUBLIC_API_MOCK_SCENARIO` environment variable, then `localStorage` (guarded — absent
 * outside the browser), defaulting to `'default'`.
 *
 * @returns The active scenario.
 */
export function getScenario(): MockScenario {
  if (currentScenario !== null) {
    return currentScenario;
  }
  const fromEnv = process.env.NEXT_PUBLIC_API_MOCK_SCENARIO;
  if (fromEnv !== undefined && isMockScenario(fromEnv)) {
    return fromEnv;
  }
  return readLocalStorageScenario() ?? 'default';
}

/**
 * Sets the active scenario (overrides env/localStorage) and applies its store-level effects.
 *
 * @param scenario - The scenario to activate.
 */
export function setScenario(scenario: MockScenario): void {
  currentScenario = scenario;
  applyScenarioEffects(scenario);
}

/** Clears the explicit override so {@link getScenario} falls back to env/localStorage/default. */
export function clearScenarioOverride(): void {
  currentScenario = null;
}
