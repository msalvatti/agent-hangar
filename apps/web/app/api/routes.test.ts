/** @vitest-environment node */
/**
 * Wiring tests for the route modules.
 *
 * Layer: unit.
 * Goal: every `route.ts` exports the methods its path promises, resolves its `params` promise and
 * calls the handler behind it. The handlers themselves are covered by their own suites; this file
 * is about the wiring that Next.js loads, which no handler test would notice being wrong.
 * Mocks: `@/server/container`, so `getServerContainer` yields the test container; and `bullmq`.
 */
import { routes } from '@agent-hangar/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestContainer } from '@/server/testing/test-container';
import type { TestContainer } from '@/server/testing/test-container';

vi.mock('bullmq', () => import('@/server/testing/fake-queue'));
vi.mock('@/server/container', () => ({
  getServerContainer: () => harness.container,
}));

let harness: TestContainer;

beforeEach(() => {
  harness = createTestContainer();
});

/** Origin every request in this file is addressed to. */
const ORIGIN = 'http://127.0.0.1:3000';

/**
 * Builds a request the same-origin guard accepts.
 *
 * @param path - Path below the API root.
 * @param method - HTTP method.
 * @param body - JSON body, when the route takes one.
 * @returns The request.
 */
function request(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { host: '127.0.0.1:3000', origin: ORIGIN, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Wraps path parameters the way Next.js hands them to a route handler.
 *
 * @param params - Resolved parameters.
 * @returns A route context.
 */
function context<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

describe('chat routes', () => {
  /**
   * The collection route serves both the sidebar list and chat creation, and both are dynamic:
   * a cached `GET /api/chats` would show a stale sidebar after the first navigation.
   */
  it('wires GET and POST on the collection', async () => {
    const route = await import('./chats/route');
    expect(route.dynamic).toBe('force-dynamic');
    expect((await route.GET(request(routes.chats))).status).toBe(200);
    expect((await route.POST(request(routes.chats, 'POST', {}))).status).toBe(400);
  });

  /**
   * The item route hosts all three methods of `/api/chats/:id`, and each resolves the `params`
   * promise Next.js hands it.
   */
  it('wires GET, PATCH and DELETE on the item', async () => {
    const route = await import('./chats/[id]/route');
    const ctx = context({ id: 'missing' });
    expect((await route.GET(request('/api/chats/missing'), ctx)).status).toBe(404);
    expect(
      (await route.PATCH(request('/api/chats/missing', 'PATCH', { title: 'x' }), ctx)).status,
    ).toBe(404);
    expect((await route.DELETE(request('/api/chats/missing', 'DELETE'), ctx)).status).toBe(404);
  });

  /**
   * The three action routes each expose one method and reach the handler that owns it.
   */
  it('wires the message, archive and restore actions', async () => {
    const ctx = context({ id: 'missing' });
    const messages = await import('./chats/[id]/messages/route');
    expect(
      (await messages.POST(request('/api/chats/missing/messages', 'POST', { prompt: 'x' }), ctx))
        .status,
    ).toBe(404);

    const archive = await import('./chats/[id]/archive/route');
    expect((await archive.POST(request('/api/chats/missing/archive', 'POST'), ctx)).status).toBe(
      404,
    );

    const restore = await import('./chats/[id]/restore/route');
    expect((await restore.POST(request('/api/chats/missing/restore', 'POST'), ctx)).status).toBe(
      404,
    );
  });
});

describe('turn routes', () => {
  /**
   * Cancel is the one route under `/api/turns`, and it reaches the handler that decides between
   * removing a queued job and publishing a command.
   */
  it('wires the cancel action', async () => {
    const route = await import('./turns/[id]/cancel/route');
    expect(route.dynamic).toBe('force-dynamic');
    const response = await route.POST(
      request('/api/turns/missing/cancel', 'POST'),
      context({ id: 'missing' }),
    );
    expect(response.status).toBe(404);
  });
});
