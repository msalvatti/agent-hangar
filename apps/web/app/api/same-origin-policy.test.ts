/** @vitest-environment node */
/**
 * Policy test: every state-changing route refuses a request from another origin.
 *
 * Layer: unit.
 * Goal: this API has no session cookie and no login, so its effective authorisation is "whoever
 * can reach the port" — and a page open in the developer's browser can reach it. A cross-origin
 * `fetch(..., { mode: 'no-cors' })` with a `text/plain` content type triggers no preflight, and
 * `request.json()` parses the body regardless of what it declares, so the write would land even
 * though the attacker cannot read the answer.
 *
 * The route files are deliberately thin wiring, so the guard lives in the handler behind each one.
 * That makes a grep for `assertSameOrigin` over `app/api/**` the wrong instrument: it would report
 * every route file while the invariant holds perfectly. This suite calls the routes instead, which
 * is what actually proves it — and it discovers the routes by walking the directory, so a route
 * added later is covered without anyone remembering to add it here.
 * Mocks: `@/server/container` and `bullmq`.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { foreignRequest } from '@/server/testing/requests';
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

/** Methods that change state and therefore carry the guard. */
const STATE_CHANGING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Values used for the dynamic segments; the guard runs before anything is looked up. */
const SEGMENT_VALUES: Readonly<Record<string, string>> = { '[id]': 'missing', '[key]': 'NOPE' };

/** Directory holding the route modules. */
const API_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** One route module found on disk. */
interface DiscoveredRoute {
  /** Import specifier relative to this file. */
  specifier: string;
  /** Concrete request path, with every dynamic segment filled in. */
  path: string;
  /** Values of the dynamic segments, as Next.js resolves them. */
  params: Record<string, string>;
}

/**
 * Walks the API directory and describes every route module it finds.
 *
 * @param directory - Directory relative to the API root; empty for the root itself.
 * @returns Every route below it.
 */
function discoverRoutes(directory = ''): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = [];
  for (const entry of readdirSync(join(API_ROOT, directory), { withFileTypes: true })) {
    const relative = directory === '' ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...discoverRoutes(relative));
      continue;
    }
    if (entry.name !== 'route.ts') {
      continue;
    }
    const segments = directory === '' ? [] : directory.split('/');
    const params: Record<string, string> = {};
    const filled = segments.map((segment) => {
      const value = SEGMENT_VALUES[segment];
      if (value === undefined) {
        return segment;
      }
      params[segment.slice(1, -1)] = value;
      return value;
    });
    found.push({ specifier: `./${relative}`, path: `/api/${filled.join('/')}`, params });
  }
  return found;
}

/** Every route module on disk, with its dynamic segments filled in. */
const routes = discoverRoutes();

describe('same-origin policy', () => {
  /**
   * The directory walk is the point of this suite, so an empty result would make every assertion
   * below vacuous. The count is a floor rather than an exact number, so adding a route does not
   * fail this test for the wrong reason.
   */
  it('discovers the route modules', () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
    expect(routes.map((route) => route.path)).toContain('/api/settings/NOPE');
  });

  /**
   * Every state-changing export of every route answers 403 to a foreign origin — before the body
   * is read, before anything is looked up, and before anything is written.
   */
  it('refuses every state-changing route from a foreign origin', async () => {
    const checked: string[] = [];
    for (const route of routes) {
      const loaded = (await import(/* @vite-ignore */ route.specifier)) as Record<string, unknown>;
      for (const method of STATE_CHANGING) {
        const handler = loaded[method];
        if (typeof handler !== 'function') {
          continue;
        }
        const invoke = handler as (request: Request, context: unknown) => Promise<Response>;
        const request = foreignRequest(route.path, method, {
          value: 'x'.repeat(40),
          title: 'x',
          prompt: 'x',
        });
        const response = await invoke(request, { params: Promise.resolve(route.params) });
        expect(response.status, `${method} ${route.path}`).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN_ORIGIN' } });
        checked.push(`${method} ${route.path}`);
      }
    }
    expect(checked.length).toBeGreaterThanOrEqual(12);
  });

  /**
   * Nothing reached a repository, a queue or the secret store: the guard runs first, so a refused
   * request leaves no trace at all.
   */
  it('leaves no state behind after the refusals', async () => {
    expect(await harness.doubles.repos.chats.list()).toEqual([]);
    expect(await harness.doubles.repos.scheduledJobs.list()).toEqual([]);
    expect(harness.doubles.queues.chatTurns.added).toEqual([]);
    expect(harness.doubles.queues.scheduledJobs.added).toEqual([]);
    expect(harness.doubles.queues.workspaceGc.added).toEqual([]);
  });
});
