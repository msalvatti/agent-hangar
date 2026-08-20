/**
 * Mock handlers for the secret-mutation routes of `/api/settings`.
 *
 * Layer: mock (handlers).
 *
 * `GET /api/settings` is not owned by this lane (it reads the same {@link store.secrets} and is
 * served by the shared mock foundation); this file only mutates it. Plaintext never touches the
 * store — only `last4` and `updatedAt` are kept, matching spec 04 (d).
 */
import { putSecretRequest, routes, settingsKeyParam } from '@agent-hangar/core';
import type { SecretKey } from '@agent-hangar/core';
import { HttpResponse, http } from 'msw';

import { nowIso, store } from './store';
import type { MockStore } from './store';

function isSecretKey(value: string): value is SecretKey {
  return settingsKeyParam.safeParse(value).success;
}

function badRequest(message: string) {
  return HttpResponse.json({ error: { code: 'VALIDATION', message } }, { status: 400 });
}

function notFound() {
  return HttpResponse.json(
    { error: { code: 'NOT_FOUND', message: 'Unknown secret key' } },
    { status: 404 },
  );
}

/** Mock handlers for `PUT /api/settings/:key` and `DELETE /api/settings/:key`. */
export const settingsHandlers = [
  http.put(routes.settingsKey, async ({ params, request }) => {
    const key = String(params.key);
    if (!isSecretKey(key)) {
      return notFound();
    }
    const parsed = putSecretRequest.safeParse(await request.json());
    if (!parsed.success) {
      return badRequest(parsed.error.message);
    }
    const trimmed = parsed.data.value.trim();
    if (trimmed.length === 0) {
      return badRequest('Value must not be empty');
    }
    store.secrets = {
      ...store.secrets,
      [key]: { last4: trimmed.slice(-4), updatedAt: nowIso() },
    };
    return HttpResponse.json({ set: true, last4: trimmed.slice(-4) });
  }),

  http.delete(routes.settingsKey, ({ params }) => {
    const key = String(params.key);
    if (!isSecretKey(key)) {
      return notFound();
    }
    // Rebuilt key by key: a computed-key rest destructure (`{ [key]: _, ...rest }`) widens a
    // union-typed key to `string`, which this record has no index signature for.
    const remaining: MockStore['secrets'] = {};
    for (const candidate of settingsKeyParam.options) {
      const status = store.secrets[candidate];
      if (candidate === key || status === undefined) {
        continue;
      }
      remaining[candidate] = status;
    }
    store.secrets = remaining;
    return new HttpResponse(null, { status: 204 });
  }),
];
