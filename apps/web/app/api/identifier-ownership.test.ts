/** @vitest-environment node */
/**
 * Policy test: every identifier a client sends is resolved by the repository that owns it.
 *
 * Layer: unit.
 * Goal: two halves of one rule. A client action reaches the route whose repository owns the id it
 * carries — checked by running the real service functions against the real route modules, with the
 * path resolved the way the server resolves it, rather than by calling a handler directly with an
 * id chosen by the test. And no route accepts an id from another table: each one answers 404 to
 * every identifier the other repositories own, which is what stops a "try this store, then that
 * one" fallback from being added to a cancel route later.
 *
 * The failure this exists for shipped: the scheduled Stop button called `POST /api/turns/:id/cancel`
 * with a `JobRun.id`, the handler behind it resolved that parameter through the turn repository,
 * and every test passed because the mock accepted both kinds of id. A test that calls a handler
 * directly cannot see that class of defect, because the route the client would have used is exactly
 * what it skips.
 * Mocks: `@/server/container`, so `getServerContainer` yields the test container; `bullmq`; and
 * `globalThis.fetch`, replaced by the in-process router below.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cancelTurn } from '@/features/chats/services/chats-api';
import { cancelRun } from '@/features/scheduled/services/scheduled-api';
import { createTestContainer } from '@/server/testing/test-container';
import type { TestContainer } from '@/server/testing/test-container';
import { apiFetch } from '@/shared/api/client';

vi.mock('bullmq', () => import('@/server/testing/fake-queue'));
vi.mock('@/server/container', () => ({
  getServerContainer: () => harness.container,
}));

let harness: TestContainer;
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  harness = createTestContainer();
  realFetch = globalThis.fetch;
  globalThis.fetch = dispatch as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Origin every request in this file is addressed to. */
const ORIGIN = 'http://127.0.0.1:3000';

/** Host header matching {@link ORIGIN}. */
const HOST = '127.0.0.1:3000';

/** Directory holding the route modules. */
const API_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** A repository URL the contracts accept. */
const REPO_URL = 'https://github.com/acme/widgets';

/** One route module found on disk. */
interface DiscoveredRoute {
  /** Import specifier relative to this file. */
  specifier: string;
  /** Path template as the directory names spell it, e.g. `/api/runs/[id]/cancel`. */
  template: string;
  /** Path segments, dynamic ones still in their `[name]` form. */
  segments: string[];
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
    found.push({
      specifier: `./${relative}`,
      template: `/api/${segments.join('/')}`,
      segments,
    });
  }
  return found;
}

/** Every route module on disk. */
const routeModules = discoverRoutes();

/** Whether a path segment is a dynamic one, as Next.js spells it in a directory name. */
function isDynamic(segment: string): boolean {
  return segment.startsWith('[') && segment.endsWith(']');
}

/** A route matched against a concrete request path. */
interface MatchedRoute {
  route: DiscoveredRoute;
  params: Record<string, string>;
}

/**
 * Finds the route module a request path belongs to, filling in its dynamic segments.
 *
 * This is the resolution step Next.js performs and that a direct handler call skips: the client
 * builds a path from the operation it named, and only this step decides which module — and
 * therefore which repository — sees the id inside it.
 *
 * @param pathname - Concrete request path.
 * @returns The route and its resolved parameters, or `null` when nothing serves the path.
 */
function matchRoute(pathname: string): MatchedRoute | null {
  const parts = pathname.replace(/^\/api\//, '').split('/');
  for (const route of routeModules) {
    if (route.segments.length !== parts.length) {
      continue;
    }
    const params: Record<string, string> = {};
    const matches = route.segments.every((segment, index) => {
      const value = parts[index] ?? '';
      if (!isDynamic(segment)) {
        return segment === value;
      }
      params[segment.slice(1, -1)] = decodeURIComponent(value);
      return true;
    });
    if (matches) {
      return { route, params };
    }
  }
  return null;
}

/**
 * Serves one request out of the route modules on disk, as the running server would.
 *
 * The headers a browser attaches to a same-origin request are added here, because the client under
 * test sends a relative URL and never sets them itself.
 *
 * @param input - Relative path the client asked for.
 * @param init - Method, headers and body the client set.
 * @returns The route's response.
 * @throws Error When no route serves the path, or the one that does exports no such method.
 */
async function dispatch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, ORIGIN);
  const matched = matchRoute(url.pathname);
  if (matched === null) {
    throw new Error(`No route module serves ${url.pathname}`);
  }
  const method = init.method ?? 'GET';
  const loaded = (await import(/* @vite-ignore */ matched.route.specifier)) as Record<
    string,
    unknown
  >;
  const handler = loaded[method];
  if (typeof handler !== 'function') {
    throw new Error(`${matched.route.template} exports no ${method}`);
  }
  const headers = new Headers(init.headers);
  headers.set('host', HOST);
  headers.set('origin', ORIGIN);
  const request = new Request(url, {
    method,
    headers,
    ...(init.body === undefined || init.body === null ? {} : { body: init.body }),
  });
  const invoke = handler as (request: Request, context: unknown) => Promise<Response>;
  return invoke(request, { params: Promise.resolve(matched.params) });
}

/**
 * Starts a manual run of a freshly created job, through the API the browser uses.
 *
 * @returns The run id the client is given.
 */
async function startRun(): Promise<string> {
  const job = await apiFetch('createJob', {
    body: {
      name: 'Nightly triage',
      cron: '0 3 * * *',
      timezone: 'UTC',
      prompt: 'Triage new issues',
      repoUrl: REPO_URL,
      branch: 'main',
      enabled: true,
    },
  });
  const { runId } = await apiFetch('triggerRun', { params: { id: job.id } });
  return runId;
}

/**
 * Starts a chat, whose first turn is queued with it.
 *
 * @returns The chat id and the turn id the client is given.
 */
async function startChat(): Promise<{ chatId: string; turnId: string }> {
  return apiFetch('createChat', {
    body: { repoUrl: REPO_URL, baseBranch: 'main', prompt: 'work' },
  });
}

describe('client actions resolve to the route that owns their identifier', () => {
  /**
   * The defect this file was written for. `cancelRun` carries a `JobRun.id`, and the only route
   * that resolves one is `/api/runs/:id/cancel`; sending it to the turn route answers 404 because
   * the handler behind that path looks its parameter up in the turn repository. Driven through the
   * service the Stop button calls, so the operation the client names is part of what is proven.
   */
  it('stops a scheduled run through the run cancel route', async () => {
    const runId = await startRun();

    await expect(cancelRun(runId)).resolves.toBeUndefined();

    expect(await harness.doubles.repos.jobRuns.get(runId)).toMatchObject({ status: 'CANCELLED' });
  });

  /**
   * The mirror case, which keeps the first one honest: the chat Stop button carries a `Turn.id`
   * and reaches the turn route, so the two actions are resolved by two repositories rather than
   * by one route guessing between them.
   */
  it('stops a chat turn through the turn cancel route', async () => {
    const { turnId } = await startChat();

    await expect(cancelTurn(turnId)).resolves.toEqual({ ok: true });

    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'CANCELLED' });
  });
});

/** Which repository owns the identifier each dynamic route takes. */
const OWNER_BY_ROUTE: Readonly<Record<string, string>> = {
  '/api/chats/[id]': 'chat',
  '/api/chats/[id]/messages': 'chat',
  '/api/chats/[id]/archive': 'chat',
  '/api/chats/[id]/restore': 'chat',
  '/api/chats/[id]/events': 'chat',
  '/api/turns/[id]/cancel': 'turn',
  '/api/turns/[id]/retry': 'turn',
  '/api/jobs/[id]': 'job',
  '/api/jobs/[id]/run': 'job',
  '/api/jobs/[id]/runs': 'job',
  '/api/runs/[id]': 'run',
  '/api/runs/[id]/events': 'run',
  '/api/runs/[id]/cancel': 'run',
  '/api/settings/[key]': 'secret',
};

/** Methods a route may export. */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** A body that satisfies every route's schema, so no request stops at validation. */
const BODY = { prompt: 'x', title: 'x', value: 'x'.repeat(40), enabled: true };

/**
 * Calls every method a route exports with an identifier it does not own, asserting each is refused.
 *
 * @param route - The route module under test.
 * @param kind - Which repository owns the identifier being sent.
 * @param value - The identifier itself.
 * @returns One entry per method that answered 404, for the caller's count.
 */
async function refusals(route: DiscoveredRoute, kind: string, value: string): Promise<string[]> {
  const loaded = (await import(/* @vite-ignore */ route.specifier)) as Record<string, unknown>;
  const path = route.segments.map((segment) => (isDynamic(segment) ? value : segment)).join('/');
  const checked: string[] = [];
  for (const method of METHODS.filter((name) => typeof loaded[name] === 'function')) {
    // A `GET` carries no body at all — the platform's `Request` refuses one — while every other
    // method is given one that satisfies its schema, so nothing stops at validation before the
    // lookup this test is about.
    const response = await dispatch(`/api/${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(BODY) }),
    });
    expect(response.status, `${method} ${route.template} with a ${kind} id`).toBe(404);
    checked.push(`${method} ${route.template} <- ${kind}`);
  }
  return checked;
}

describe('identifier ownership', () => {
  /**
   * The map above is the policy, so it has to describe every dynamic route there is. A route added
   * later fails here until somebody states which repository resolves the id it takes — which is
   * the moment to notice that the id comes from somewhere else.
   */
  it('declares an owner for every dynamic route', () => {
    const dynamicRoutes = routeModules
      .filter((route) => route.segments.some(isDynamic))
      .map((route) => route.template)
      .sort();
    expect(dynamicRoutes).toEqual(Object.keys(OWNER_BY_ROUTE).sort());
  });

  /**
   * Every route refuses the identifiers the other repositories own. Two things follow from it: a
   * client that names the wrong operation gets a 404 rather than an action against the wrong row,
   * and a handler cannot be "fixed" later by falling back to a second repository when the first
   * one misses — which would turn every unrelated lookup failure into a confusing success.
   */
  it('refuses every identifier owned by another repository', async () => {
    const { chatId, turnId } = await startChat();
    const runId = await startRun();
    const [job] = await harness.doubles.repos.scheduledJobs.list();
    const identifiers: Readonly<Record<string, string>> = {
      chat: chatId,
      turn: turnId,
      job: job?.id ?? '',
      run: runId,
      secret: 'GITHUB_PAT',
    };
    const refused: string[] = [];

    for (const route of routeModules.filter((candidate) => candidate.segments.some(isDynamic))) {
      const owner = OWNER_BY_ROUTE[route.template];
      for (const [kind, value] of Object.entries(identifiers).filter(([name]) => name !== owner)) {
        refused.push(...(await refusals(route, kind, value)));
      }
    }

    // The loop is the assertion, so an empty one would pass while proving nothing. Four foreign
    // identifiers over thirteen routes is the floor, not the exact count.
    expect(refused.length).toBeGreaterThanOrEqual(40);
  });
});
