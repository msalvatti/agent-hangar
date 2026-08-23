/**
 * Settings routes: the masked status of the stored credentials, and writing or removing one.
 *
 * Layer: service (server).
 *
 * This module is the only place in the whole system where a credential exists in plaintext outside
 * the worker, and it exists there for the length of one function call. Request logging is disabled
 * here by construction: no handler passes the request, the URL or the body to the logger, and the
 * only thing ever logged is `{ key, action }`. A failing write is reported by the error's class
 * name alone, because a storage error routinely quotes what it was asked to store.
 *
 * Nothing here calls `reveal`. The status view is built from the masked `last4` the service keeps
 * beside the ciphertext, so a response cannot carry a value even by accident.
 */
import {
  putSecretRequestFor,
  putSecretResponse,
  SETTINGS_FIELD_BY_KEY,
  settingsKeyParam,
  settingsStatus,
} from '@agent-hangar/core';
import type { SecretKey, SecretStatus } from '@agent-hangar/core';
import type { z } from 'zod';

import type { ServerContainer } from '../container';
import { ApiHttpError, failureName, ResourceNotFoundError } from '../errors';
import { jsonResponse, noContent, parseJsonBody, withErrorHandling } from '../http';
import { assertKnownHost, assertSameOrigin } from '../same-origin';

/** Headers every settings response carries; a masked credential must never sit in a cache. */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** Path parameters of the per-key routes. */
export interface SettingsParams {
  key: string;
}

/**
 * Narrows a path segment to a known secret key.
 *
 * An unknown key is a missing resource rather than a bad request: `/api/settings/NOPE` names
 * something that does not exist, and answering `400` would suggest the value could be corrected.
 *
 * @param key - The `:key` path segment.
 * @returns The secret key.
 * @throws ResourceNotFoundError 404 when the segment names no stored secret.
 */
function requireSecretKey(key: string): SecretKey {
  const parsed = settingsKeyParam.safeParse(key);
  if (!parsed.success) {
    throw new ResourceNotFoundError('Unknown setting');
  }
  return parsed.data;
}

/**
 * Maps one stored secret onto its masked view.
 *
 * @param status - Status as the secrets service reports it.
 * @returns The view, with the timestamp serialised.
 */
function toStatusView(status: SecretStatus): z.input<typeof settingsStatus>['githubPat'] {
  return {
    set: status.set,
    // Spread conditionally because this project may not hand an optional property an explicit
    // `undefined` — and JSON drops such a key on the way out anyway, so no reader of this response
    // can tell the two spellings apart.
    // Stryker disable next-line ConditionalExpression
    ...(status.last4 === undefined ? {} : { last4: status.last4 }),
    ...(status.updatedAt === undefined ? {} : { updatedAt: status.updatedAt.toISOString() }),
  };
}

/**
 * `GET /api/settings` — which credentials are stored, masked to their last four characters.
 *
 * @param container - The server container.
 * @param request - The incoming request; only its addressed host is read.
 * @returns `200` with the masked status and the configured model.
 */
export function getSettings(container: ServerContainer, request: Request): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertKnownHost(request);
    const status = await container.secrets.status();
    return jsonResponse(
      settingsStatus,
      {
        [SETTINGS_FIELD_BY_KEY.GITHUB_PAT]: toStatusView(status.GITHUB_PAT),
        [SETTINGS_FIELD_BY_KEY.OPENAI_API_KEY]: toStatusView(status.OPENAI_API_KEY),
        model: container.config.OPENAI_MODEL,
      },
      { headers: NO_STORE },
    );
  });
}

/**
 * `PUT /api/settings/:key` — encrypts and stores one credential.
 *
 * @param container - The server container.
 * @param request - The incoming request; its body is the only plaintext this process ever sees.
 * @param params - Resolved path parameters.
 * @returns `200` with `{ set: true, last4 }`.
 */
export function putSetting(
  container: ServerContainer,
  request: Request,
  params: SettingsParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertSameOrigin(request);
    const key = requireSecretKey(params.key);
    const body = await parseJsonBody(request, putSecretRequestFor(key));
    const last4 = await store(container, key, body.value);
    container.logger.info({ key, action: 'set' }, 'secret updated');
    return jsonResponse(putSecretResponse, { set: true, last4 }, { headers: NO_STORE });
  });
}

/**
 * Stores one credential, reporting a failure without quoting anything about the value.
 *
 * @param container - The server container.
 * @param key - Which credential to store.
 * @param value - The plaintext.
 * @returns The masked tail the UI displays.
 * @throws ApiHttpError 500 `SECRET_WRITE_FAILED` when the value could not be stored.
 */
async function store(container: ServerContainer, key: SecretKey, value: string): Promise<string> {
  try {
    return (await container.secrets.set(key, value)).last4;
  } catch (error) {
    // Only the error's class name is logged. A storage failure — a rejected envelope, a key file
    // that could not be read — routinely quotes the value it was handed, and this handler is the
    // one place in the process where that value is plaintext.
    container.logger.error(
      { key, action: 'set', failure: failureName(error) },
      'secret write failed',
    );
    throw new ApiHttpError(500, 'SECRET_WRITE_FAILED', 'Could not store the credential');
  }
}

/**
 * `DELETE /api/settings/:key` — forgets one credential.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters.
 * @returns `204`.
 */
export function deleteSetting(
  container: ServerContainer,
  request: Request,
  params: SettingsParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertSameOrigin(request);
    const key = requireSecretKey(params.key);
    await container.secrets.remove(key);
    container.logger.info({ key, action: 'remove' }, 'secret removed');
    return noContent();
  });
}
