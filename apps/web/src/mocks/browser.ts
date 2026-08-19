/**
 * MSW browser worker: intercepts `fetch` in the page itself when
 * `NEXT_PUBLIC_API_MOCK=1` (started by {@link MockProvider}).
 *
 * Layer: mock (bootstrap). Excluded from coverage: pure wiring, exercised manually via
 * `pnpm --filter web dev`.
 */
import { setupWorker } from 'msw/browser';

import { handlers } from './handlers';

/** The browser mock worker. */
export const worker = setupWorker(...handlers);
