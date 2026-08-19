/**
 * MSW Node server: intercepts `fetch` in Vitest (jsdom) so every unit test runs against the same
 * mock API the browser worker serves.
 *
 * Layer: mock (bootstrap). Excluded from coverage: pure wiring, exercised through every test that
 * uses it.
 */
import { setupServer } from 'msw/node';

import { handlers } from './handlers';

/** The Node mock server, started by `src/mocks/vitest.ts`. */
export const server = setupServer(...handlers);
