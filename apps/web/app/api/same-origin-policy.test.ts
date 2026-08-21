/** @vitest-environment node */
/**
 * Policy test: no route serves a request that did not come from this application, and no route at
 * all serves one addressed to a host this machine does not answer to.
 *
 * Layer: unit.
 * Goal: this API has no session cookie and no login, so its effective authorisation is "whoever
 * can reach the port" — and a page open in the developer's browser can reach it. Two shapes get
 * there. A cross-origin `fetch(..., { mode: 'no-cors' })` with a `text/plain` content type
 * triggers no preflight, and `request.json()` parses the body regardless of what it declares, so
 * the write would land even though the attacker cannot read the answer. And a DNS-rebinding page,
 * whose own hostname the attacker points at the loopback address, produces a request in which
 * `Origin`, `Host` and `Sec-Fetch-Site` all agree — so every check that compares the request
 * against itself passes, and the browser hands the response body back too, which puts the reads in
 * scope as well as the writes.
 *
 * The route files are deliberately thin wiring, so the guards live in the handler behind each one.
 * That makes a grep for `assertSameOrigin` over `app/api/**` the wrong instrument: it would report
 * every route file while the invariant holds perfectly. This suite calls the routes instead, which
 * is what actually proves it — and it discovers the routes by walking the directory, so a route
 * added later is covered without anyone remembering to add it here.
 * Mocks: `@/server/container` and `bullmq`.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { foreignRequest, reboundRequest } from '@/server/testing/requests';
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

/** Methods that change state and therefore carry the same-origin guard. */
const STATE_CHANGING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Every method a route module may export; all of them carry the host guard. */
const EVERY_METHOD = ['GET', ...STATE_CHANGING] as const;

/** Body the hostile requests carry; wide enough to satisfy every write contract on the way in. */
const HOSTILE_BODY = { value: 'x'.repeat(40), title: 'x', prompt: 'x' };

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
   *
   * The state assertions belong in this test rather than in one of their own. `beforeEach` builds a
   * fresh harness per test, so a separate test would inspect a container the refusals never
   * touched, and would pass just as happily if every route wrote its row and *then* answered 403.
   * Checked here, the state that is inspected is the state the refusals ran against.
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
        const request = foreignRequest(route.path, method, HOSTILE_BODY);
        const response = await invoke(request, { params: Promise.resolve(route.params) });
        expect(response.status, `${method} ${route.path}`).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN_ORIGIN' } });
        checked.push(`${method} ${route.path}`);
      }
    }
    expect(checked.length).toBeGreaterThanOrEqual(12);

    // Nothing reached a repository, a queue or the secret store: the guard runs before the body is
    // read and before anything is looked up, so a refused request leaves no trace at all.
    expect(await harness.doubles.repos.chats.list()).toEqual([]);
    expect(await harness.doubles.repos.scheduledJobs.list()).toEqual([]);
    expect(await harness.doubles.secrets.status()).toMatchObject({
      GITHUB_PAT: { set: true, last4: GITHUB_CANARY.slice(-4) },
      OPENAI_API_KEY: { set: true, last4: OPENAI_CANARY.slice(-4) },
    });
    expect(harness.doubles.queues.chatTurns.added).toEqual([]);
    expect(harness.doubles.queues.scheduledJobs.added).toEqual([]);
    expect(harness.doubles.queues.workspaceGc.added).toEqual([]);
  });

  /**
   * Every export of every route — reads, streams and writes alike — answers 403 to a request
   * addressed to a hostname this machine does not answer to.
   *
   * This is the DNS-rebinding case, and it is the one the origin checks cannot see: the request is
   * internally consistent, so a guard that compares `Origin` against `Host` waves it through. It
   * covers `GET` as well, because rebinding is the situation in which the browser considers the
   * response same-origin and lets the attacking page read it — the confidentiality argument that
   * excuses the reads from the origin guard is exactly what fails here.
   *
   * The doubles are inspected in this test rather than in one of their own for the same reason as
   * above: `beforeEach` gives each test its own harness, so a separate one would inspect a
   * container these refusals never touched.
   */
  it('refuses every route export addressed to a rebound host', async () => {
    const checked: string[] = [];
    for (const route of routes) {
      const loaded = (await import(/* @vite-ignore */ route.specifier)) as Record<string, unknown>;
      for (const method of EVERY_METHOD) {
        const handler = loaded[method];
        if (typeof handler !== 'function') {
          continue;
        }
        const invoke = handler as (request: Request, context: unknown) => Promise<Response>;
        const request =
          method === 'GET'
            ? reboundRequest(route.path, method)
            : reboundRequest(route.path, method, HOSTILE_BODY);
        const response = await invoke(request, { params: Promise.resolve(route.params) });
        expect(response.status, `${method} ${route.path}`).toBe(403);
        expect(await response.json(), `${method} ${route.path}`).toMatchObject({
          error: { code: 'FORBIDDEN_ORIGIN' },
        });
        checked.push(`${method} ${route.path}`);
      }
    }
    expect(checked.length).toBeGreaterThanOrEqual(24);

    // Nothing was read and nothing was written: the host guard runs before the query string is
    // parsed, before the row is looked up and before a stream is opened.
    expect(await harness.doubles.repos.chats.list()).toEqual([]);
    expect(await harness.doubles.repos.scheduledJobs.list()).toEqual([]);
    expect(harness.doubles.queues.chatTurns.added).toEqual([]);
    expect(harness.doubles.queues.scheduledJobs.added).toEqual([]);
    expect(harness.doubles.queues.workspaceGc.added).toEqual([]);
  });
});
