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

describe('job and run routes', () => {
  /**
   * The job collection serves the table and the create form.
   */
  it('wires GET and POST on the job collection', async () => {
    const route = await import('./jobs/route');
    expect(route.dynamic).toBe('force-dynamic');
    expect((await route.GET(request(routes.jobs))).status).toBe(200);
    expect((await route.POST(request(routes.jobs, 'POST', {}))).status).toBe(400);
  });

  /**
   * The job item route hosts all three methods and resolves the `params` promise for each.
   */
  it('wires GET, PATCH and DELETE on the job item', async () => {
    const route = await import('./jobs/[id]/route');
    const ctx = context({ id: 'missing' });
    expect((await route.GET(request('/api/jobs/missing'), ctx)).status).toBe(404);
    expect((await route.PATCH(request('/api/jobs/missing', 'PATCH', {}), ctx)).status).toBe(404);
    expect((await route.DELETE(request('/api/jobs/missing', 'DELETE'), ctx)).status).toBe(404);
  });

  /**
   * The manual-run action and the two read routes each reach their own handler.
   */
  it('wires the manual run, the run history and the run detail', async () => {
    const ctx = context({ id: 'missing' });
    const run = await import('./jobs/[id]/run/route');
    expect((await run.POST(request('/api/jobs/missing/run', 'POST'), ctx)).status).toBe(404);

    const history = await import('./jobs/[id]/runs/route');
    expect((await history.GET(request('/api/jobs/missing/runs'), ctx)).status).toBe(404);

    const detail = await import('./runs/[id]/route');
    expect((await detail.GET(request('/api/runs/missing'), ctx)).status).toBe(404);
  });

  /**
   * Stopping a run is its own route under `/api/runs`, and it reaches the handler that decides
   * between removing a queued delivery and publishing a command — not the turn handler, which
   * would look this id up in the wrong table.
   */
  it('wires the run cancel action', async () => {
    const route = await import('./runs/[id]/cancel/route');
    expect(route.dynamic).toBe('force-dynamic');
    const response = await route.POST(
      request('/api/runs/missing/cancel', 'POST'),
      context({ id: 'missing' }),
    );
    expect(response.status).toBe(404);
  });
});

describe('repository routes', () => {
  /**
   * Both picker routes are reads that reach the GitHub client through the container.
   */
  it('wires the repository and branch pickers', async () => {
    const repos = await import('./repos/route');
    expect(repos.dynamic).toBe('force-dynamic');
    expect((await repos.GET(request(routes.repos))).status).toBe(200);

    const branches = await import('./repos/branches/route');
    expect((await branches.GET(request(routes.repoBranches))).status).toBe(400);
  });
});

describe('event stream routes', () => {
  /**
   * Both SSE routes answer `text/event-stream` and are dynamic; a cached event stream would be a
   * transcript frozen at whatever the first reader saw. Each stream is cancelled straight away so
   * no blocked reader outlives the test.
   */
  it('wires the chat and run event streams', async () => {
    const chats = await import('./chats/[id]/events/route');
    expect(chats.dynamic).toBe('force-dynamic');
    const missingChat = await chats.GET(
      request('/api/chats/missing/events'),
      context({ id: 'missing' }),
    );
    expect(missingChat.status).toBe(404);

    const runs = await import('./runs/[id]/events/route');
    const missingRun = await runs.GET(
      request('/api/runs/missing/events'),
      context({ id: 'missing' }),
    );
    expect(missingRun.status).toBe(404);
  });

  /**
   * A chat with a live turn opens a real stream, which is the wiring that matters: the route must
   * reach the factory rather than the JSON helpers.
   */
  it('opens a stream for a chat that has a turn', async () => {
    const chats = await import('./chats/[id]/events/route');
    const created = await (
      await import('./chats/route')
    ).POST(
      request(routes.chats, 'POST', {
        repoUrl: 'https://github.com/acme/widgets',
        baseBranch: 'main',
        prompt: 'work',
      }),
    );
    const { chatId } = (await created.json()) as { chatId: string };
    const response = await chats.GET(
      request(`/api/chats/${chatId}/events`),
      context({ id: chatId }),
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await response.body?.cancel();
  });
});

describe('settings and health routes', () => {
  /**
   * The settings collection is read-only; the per-key route hosts the write and the removal, and
   * both refuse a key the system does not store.
   */
  it('wires the settings status, write and removal', async () => {
    const collection = await import('./settings/route');
    expect(collection.dynamic).toBe('force-dynamic');
    expect((await collection.GET(request(routes.settings))).status).toBe(200);

    const item = await import('./settings/[key]/route');
    const ctx = context({ key: 'NOPE' });
    expect(
      (await item.PUT(request('/api/settings/NOPE', 'PUT', { value: 'x'.repeat(20) }), ctx)).status,
    ).toBe(404);
    expect((await item.DELETE(request('/api/settings/NOPE', 'DELETE'), ctx)).status).toBe(404);
  });

  /**
   * Health answers even when every dependency is unreachable, which is the whole point of it.
   */
  it('wires the health route', async () => {
    const route = await import('./health/route');
    expect(route.dynamic).toBe('force-dynamic');
    expect((await route.GET(request(routes.health))).status).toBe(200);
  });
});

describe('turn routes', () => {
  /**
   * Cancel reaches the handler that decides between removing a queued job and publishing a
   * command.
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

  /**
   * Retry is the second route under `/api/turns`, and it resolves its id through the same turn
   * repository the cancel does — so an id nothing owns is a 404 here too rather than a dispatch
   * of the wrong work.
   */
  it('wires the retry action', async () => {
    const route = await import('./turns/[id]/retry/route');
    expect(route.dynamic).toBe('force-dynamic');
    const response = await route.POST(
      request('/api/turns/missing/retry', 'POST'),
      context({ id: 'missing' }),
    );
    expect(response.status).toBe(404);
  });
});
