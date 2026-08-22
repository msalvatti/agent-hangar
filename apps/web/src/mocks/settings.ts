/**
 * Mock handlers for the secret-mutation routes of `/api/settings`.
 *
 * Layer: mock (handlers).
 *
 * `GET /api/settings` lives in `settings-status.ts` and reads the same {@link store.secrets};
 * this file only mutates it. Plaintext never touches the store — only `last4` and `updatedAt`
 * are kept, matching spec 04 (d).
 */
import { putSecretRequestFor, routes, settingsKeyParam } from '@agent-hangar/core';
import type { SecretKey } from '@agent-hangar/core';
import { HttpResponse, http } from 'msw';

import { nowIso, store } from './store';
import type { MockStore } from './store';

/** Number of trailing characters kept of a saved secret, as the contract's `last4` states. */
const MASK_LENGTH = 4;

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
    const parsed = putSecretRequestFor(key).safeParse(await request.json());
    if (!parsed.success) {
      return badRequest(parsed.error.message);
    }
    // No empty-value guard: the body schema is the credential's own shape, and no shape it accepts
    // is blank or surrounded by whitespace, so a separate emptiness check here could never fire.
    const last4 = parsed.data.value.slice(-MASK_LENGTH);
    store.secrets = { ...store.secrets, [key]: { last4, updatedAt: nowIso() } };
    return HttpResponse.json({ set: true, last4 });
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
