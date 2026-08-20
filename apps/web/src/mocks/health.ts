/**
 * MSW handler for the health-check route.
 *
 * Layer: mock (handler).
 */
import { routes } from '@agent-hangar/core';
import { http, HttpResponse } from 'msw';

import { store } from './store';

/** `GET /api/health` — DB/Redis/Docker/image reachability, shaped by the active scenario. */
const getHealth = http.get(routes.health, () => HttpResponse.json(store.health));

/** Handlers for `GET /api/health`. */
export const healthHandlers = [getHealth];
