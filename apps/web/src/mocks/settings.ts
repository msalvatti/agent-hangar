/**
 * Mock handlers for the secret-mutation routes of `/api/settings`.
 *
 * Layer: mock (handlers).
 *
 * `GET /api/settings` is not owned by this lane (it reads the same {@link store.secrets} and is
 * served by the shared mock foundation); this file only mutates it. Plaintext never touches the
 * store — only `last4` and `updatedAt` are kept, matching spec 04 (d).
 */
import { putSecretRequest, settingsKeyParam } from '@agent-hangar/core';
import { HttpResponse, http } from 'msw';

import { nowIso, store } from './store';
import type { SecretKey } from './store';

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
  http.put('/api/settings/:key', async ({ params, request }) => {
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

  http.delete('/api/settings/:key', ({ params }) => {
    const key = String(params.key);
    if (!isSecretKey(key)) {
      return notFound();
    }
    const { [key]: _removed, ...rest } = store.secrets;
    store.secrets = rest;
    return new HttpResponse(null, { status: 204 });
  }),
];
