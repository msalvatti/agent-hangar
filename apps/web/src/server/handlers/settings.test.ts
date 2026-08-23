/** @vitest-environment node */
/**
 * Unit tests for the settings routes.
 *
 * Layer: unit.
 * Goal: a credential can be stored and masked without ever leaving the process — not in a
 * response, not in a log line, and never through `reveal`. Every assertion runs against the
 * canaries, so a leak fails the build rather than passing unnoticed.
 * Mocks: the `bullmq` module; the logger writes into an array the test reads back.
 */
import { putSecretResponse, settingsStatus } from '@agent-hangar/core';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerContainer } from '../container';
import { foreignRequest, readRequest } from '../testing/requests';
import { createTestContainer } from '../testing/test-container';
import type { TestContainer } from '../testing/test-container';

import { deleteSetting, getSettings, putSetting } from './settings';

vi.mock('bullmq', () => import('../testing/fake-queue'));

/** Every harness built in this file, checked after each test for a leaked credential. */
const built: TestContainer[] = [];

/**
 * Builds a harness and registers it for the leak check.
 *
 * @param options - Options of the test container.
 * @returns The harness.
 */
function harness(options: { secretsSet?: boolean } = {}): TestContainer {
  const created = createTestContainer(options);
  built.push(created);
  return created;
}

afterEach(() => {
  for (const created of built.splice(0)) {
    assertNoCanary(created.doubles.logOutput());
    expect(created.doubles.secrets.revealCalls).toEqual([]);
  }
});

/**
 * Builds a same-origin state-changing request.
 *
 * @param key - The `:key` path segment.
 * @param method - HTTP method.
 * @param body - JSON body, when the route takes one.
 * @returns The request.
 */
function write(key: string, method: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1:3000/api/settings/${key}`, {
    method,
    headers: {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('getSettings', () => {
  /**
   * A fresh install has neither credential; the model is still reported, because the settings
   * screen shows it whether or not a key is stored.
   */
  it('reports both credentials as unset and names the model', async () => {
    const { container } = harness({ secretsSet: false });
    const response = await getSettings(container, readRequest('/api/settings'));
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = settingsStatus.parse(await response.json());
    expect(body.githubPat).toEqual({ set: false });
    expect(body.openaiKey).toEqual({ set: false });
    expect(body.model).toBe(container.config.OPENAI_MODEL);
  });

  /**
   * Canary regression: with both credentials stored the response carries the masked tail and
   * nothing else. This is the assertion the whole settings design exists to satisfy.
   */
  it('masks stored credentials to their last four characters', async () => {
    const { container } = harness();
    const response = await getSettings(container, readRequest('/api/settings'));
    const text = await response.text();
    assertNoCanary(text);
    const body = settingsStatus.parse(JSON.parse(text));
    expect(body.githubPat).toMatchObject({ set: true, last4: GITHUB_CANARY.slice(-4) });
    expect(body.openaiKey).toMatchObject({ set: true, last4: OPENAI_CANARY.slice(-4) });
    expect(body.githubPat.updatedAt).toBeTypeOf('string');
    // A credential that is not stored carries no mask at all, rather than a key with nothing under
    // it: the settings page renders "•••• last4" from its presence.
    const { container: empty } = harness({ secretsSet: false });
    const unset = settingsStatus.parse(
      await (await getSettings(empty, readRequest('/api/settings'))).json(),
    );
    expect(unset.githubPat).toStrictEqual({ set: false });
  });
});

describe('what the settings routes refuse', () => {
  /**
   * Every export refuses a request addressed to a host this instance does not answer for — the
   * read included. This response carries the masks and the timestamps of the user's credentials,
   * and a rebound name is exactly the case in which the browser lets an attacking page read it.
   */
  it.each([
    [
      'GET /api/settings',
      (container: ServerContainer, request: Request) => getSettings(container, request),
    ],
    [
      'PUT /api/settings/:key',
      (container: ServerContainer, request: Request) =>
        putSetting(container, request, { key: 'GITHUB_PAT' }),
    ],
    [
      'DELETE /api/settings/:key',
      (container: ServerContainer, request: Request) =>
        deleteSetting(container, request, { key: 'GITHUB_PAT' }),
    ],
  ])('refuses %s addressed to a rebound host', async (_route, invoke) => {
    const { container, doubles } = harness();

    const response = await invoke(
      container,
      new Request('http://attacker.test/api/settings', { headers: { host: 'attacker.test' } }),
    );

    expect(response.status).toBe(403);
    assertNoCanary(await response.text());
    expect((await doubles.secrets.status()).GITHUB_PAT).toMatchObject({ set: true });
  });
});

describe('putSetting', () => {
  /**
   * The happy path stores the value and answers with the mask; the response is never cached,
   * because even a mask belongs to one user's session.
   */
  it('stores the credential and answers with the mask only', async () => {
    const { container, doubles } = harness({ secretsSet: false });
    const response = await putSetting(
      container,
      write('GITHUB_PAT', 'PUT', { value: GITHUB_CANARY }),
      {
        key: 'GITHUB_PAT',
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    assertNoCanary(text);
    expect(putSecretResponse.parse(JSON.parse(text))).toEqual({
      set: true,
      last4: GITHUB_CANARY.slice(-4),
    });
    expect((await doubles.secrets.status()).GITHUB_PAT.set).toBe(true);
  });

  /**
   * Canary regression on the log: the only line this handler writes names the key and the action.
   * A request logger that captured the body would put a credential on disk, so there is none.
   */
  it('logs the action without the value', async () => {
    const { container, doubles } = harness({ secretsSet: false });
    await putSetting(container, write('OPENAI_API_KEY', 'PUT', { value: OPENAI_CANARY }), {
      key: 'OPENAI_API_KEY',
    });
    const output = doubles.logOutput();
    assertNoCanary(output);
    // Which credential, and what was done to it: the two settings are written and removed through
    // the same route, and an audit line naming neither says only that something changed.
    expect(
      output
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    ).toContainEqual(
      expect.objectContaining({ msg: 'secret updated', key: 'OPENAI_API_KEY', action: 'set' }),
    );
    expect(output).not.toContain('"value"');
  });

  /**
   * A key the system does not store is a missing resource; answering `400` would suggest the
   * caller could correct the value.
   */
  it('reports an unknown key as missing', async () => {
    const { container } = harness();
    const response = await putSetting(container, write('NOPE', 'PUT', { value: GITHUB_CANARY }), {
      key: 'NOPE',
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { message: 'Unknown setting' } });
  });

  /**
   * The contract sets a minimum length, so an empty or trivially short value is refused before it
   * is encrypted and stored as if it were a credential.
   */
  it('rejects a value the contract refuses', async () => {
    const { container, doubles } = harness({ secretsSet: false });
    const response = await putSetting(container, write('GITHUB_PAT', 'PUT', { value: 'short' }), {
      key: 'GITHUB_PAT',
    });
    expect(response.status).toBe(400);
    expect((await doubles.secrets.status()).GITHUB_PAT.set).toBe(false);
  });

  /**
   * A credential is measured against the shape of the key the route addresses.
   *
   * Regression: `{"value":"not-a-token"}` was stored under `GITHUB_PAT` and answered `200`, because
   * the body contract only asked for eight characters. A value from the wrong clipboard therefore
   * replaced a working token silently, and the mistake surfaced later and somewhere else, as a
   * rejected repository listing. It is refused here now, and the stored credential is left alone —
   * that last part is the point: the previous behaviour overwrote it.
   */
  it('refuses a value that is not shaped like the addressed credential', async () => {
    const { container, doubles } = harness({ secretsSet: true });

    const garbage = await putSetting(
      container,
      write('GITHUB_PAT', 'PUT', { value: 'not-a-token' }),
      { key: 'GITHUB_PAT' },
    );
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const swapped = await putSetting(
      container,
      write('OPENAI_API_KEY', 'PUT', { value: GITHUB_CANARY }),
      { key: 'OPENAI_API_KEY' },
    );
    expect(swapped.status).toBe(400);
    assertNoCanary(await swapped.text());

    const status = await doubles.secrets.status();
    expect(status.GITHUB_PAT.set).toBe(true);
    expect(status.OPENAI_API_KEY.set).toBe(true);
  });

  /**
   * Canary regression on the failure path: a storage error quotes what it was asked to store, so
   * only its class name is logged and the response says nothing about the value.
   */
  it('reports a failed write without quoting the value', async () => {
    const { container, doubles } = harness({ secretsSet: false });
    doubles.secrets.setFailure = new Error(`could not encrypt ${GITHUB_CANARY}`);
    const response = await putSetting(
      container,
      write('GITHUB_PAT', 'PUT', { value: GITHUB_CANARY }),
      {
        key: 'GITHUB_PAT',
      },
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    assertNoCanary(text);
    expect(JSON.parse(text)).toMatchObject({
      error: { code: 'SECRET_WRITE_FAILED', message: 'Could not store the credential' },
    });
    // The class name and nothing else: a storage failure routinely quotes the value it was handed,
    // and this handler is the one place in the process where that value is plaintext.
    expect(
      doubles
        .logOutput()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    ).toContainEqual(
      expect.objectContaining({
        msg: 'secret write failed',
        key: 'GITHUB_PAT',
        action: 'set',
        failure: 'Error',
      }),
    );
  });

  /**
   * The attack this route is the prize of: a page on another origin issuing a `no-cors` PUT would
   * overwrite the user's token. The guard refuses it before the body is read, so the repository is
   * never touched.
   */
  it('rejects a cross-origin write without touching the store', async () => {
    const { container, doubles } = harness({ secretsSet: false });
    const request = foreignRequest('/api/settings/GITHUB_PAT', 'PUT', { value: GITHUB_CANARY });
    const response = await putSetting(container, request, { key: 'GITHUB_PAT' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN_ORIGIN' } });
    expect((await doubles.secrets.status()).GITHUB_PAT.set).toBe(false);
  });
});

describe('deleteSetting', () => {
  /**
   * Removing answers `204` with no body and leaves the key unset; the shared client rejects a body
   * on a no-content operation, so the empty response is part of the contract.
   */
  it('removes the credential', async () => {
    const { container, doubles } = harness();
    const response = await deleteSetting(container, write('GITHUB_PAT', 'DELETE'), {
      key: 'GITHUB_PAT',
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect((await doubles.secrets.status()).GITHUB_PAT).toStrictEqual({ set: false });
    expect(
      doubles
        .logOutput()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    ).toContainEqual(
      expect.objectContaining({ msg: 'secret removed', key: 'GITHUB_PAT', action: 'remove' }),
    );
  });

  /**
   * An unknown key is missing here too, and a cross-origin delete is refused like every other
   * state-changing request.
   */
  it('rejects an unknown key and a cross-origin delete', async () => {
    const { container } = harness();
    const unknown = await deleteSetting(container, write('NOPE', 'DELETE'), { key: 'NOPE' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { message: 'Unknown setting' } });

    const foreign = foreignRequest('/api/settings/GITHUB_PAT', 'DELETE', {});
    expect((await deleteSetting(container, foreign, { key: 'GITHUB_PAT' })).status).toBe(403);
  });
});
