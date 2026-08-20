/**
 * MSW handler for `GET /api/settings` (masked secret status + model). `PUT`/`DELETE
 * /api/settings/:key` belong to lane W1-H's `settings.ts`.
 *
 * Layer: mock (handler).
 */
import { routes } from '@agent-hangar/core';
import type { SettingsStatus } from '@agent-hangar/core';
import { http, HttpResponse } from 'msw';

import { store } from './store';

/** `GET /api/settings` — masked secret status built from the store. */
const getSettings = http.get(routes.settings, () => {
  const body: SettingsStatus = {
    githubPat:
      store.secrets.GITHUB_PAT === undefined
        ? { set: false }
        : {
            set: true,
            last4: store.secrets.GITHUB_PAT.last4,
            updatedAt: store.secrets.GITHUB_PAT.updatedAt,
          },
    openaiKey:
      store.secrets.OPENAI_API_KEY === undefined
        ? { set: false }
        : {
            set: true,
            last4: store.secrets.OPENAI_API_KEY.last4,
            updatedAt: store.secrets.OPENAI_API_KEY.updatedAt,
          },
    model: store.model,
  };
  return HttpResponse.json(body);
});

/** Handlers for `GET /api/settings`. */
export const settingsStatusHandlers = [getSettings];
