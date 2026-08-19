/**
 * Vitest setup for the MSW mock API: starts/stops the Node server, resets all mock state between
 * tests, and shims `fetch` so a relative URL (what `apiFetch` sends) resolves the same way it
 * does in a browser.
 *
 * Layer: mock (bootstrap). Excluded from coverage: pure test wiring.
 *
 * Node's native `fetch` rejects a relative URL outright ("Failed to parse URL"); a browser (and
 * jsdom, which stands in for one here) resolves it against `location.origin` first. This shim
 * makes the same `apiFetch('/api/…')` call work under both, instead of requiring every test to
 * pass an absolute URL.
 */
import { afterAll, afterEach, beforeAll } from 'vitest';

import { clearQueryRegistry } from '@/shared/api/use-api-query';

import { setScenario } from './scenario';
import { server } from './server';
import { resetStore } from './store';

const originalFetch = globalThis.fetch;

if (typeof globalThis.location !== 'undefined') {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch(new URL(input, globalThis.location.origin).toString(), init);
    }
    return originalFetch(input, init);
  };
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  resetStore();
  setScenario('default');
  clearQueryRegistry();
});

afterAll(() => {
  server.close();
});
