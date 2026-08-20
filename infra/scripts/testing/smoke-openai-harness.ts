/**
 * The stub instance the real-model smoke check's suites drive.
 *
 * Layer: test double.
 *
 * One `fetch` router over the API routes the check calls, plus the ready-made event stream of a
 * turn that did everything the check asks for. Two suites state rules over the same stub — one
 * about the check's verdicts, one about the HTTP steps around them — and keeping the router here
 * means a new suite adds cases rather than another copy of the plumbing.
 *
 * Held to the same 100% coverage gate as the rest of `infra/scripts/testing/**`, so it is written
 * without branches a test would have to contrive to reach.
 */
import type { AgentEvent } from '../../../packages/core/src/agent-protocol/types.js';
import type { SmokeDeps } from '../lib/smoke-openai-client.js';
import {
  DEFAULT_BRANCH,
  DEFAULT_REPO_URL,
  DEFAULT_TIMEOUT_SECONDS,
} from '../lib/smoke-openai-options.js';
import type { SmokeOptions } from '../lib/smoke-openai-options.js';
import { runSmoke } from '../lib/smoke-openai.js';

/** Base URL every test drives the check against. */
export const BASE_URL = 'http://127.0.0.1:3500';

/** An ISO timestamp the protocol schema accepts. */
export const AT = '2026-08-20T12:00:00.000Z';

/**
 * Options with every default resolved, for a test that is not about the command line.
 *
 * @param overrides - Fields to replace.
 * @returns Resolved options.
 */
export function options(overrides: Partial<SmokeOptions> = {}): SmokeOptions {
  return {
    baseUrl: BASE_URL,
    repoUrl: DEFAULT_REPO_URL,
    branch: DEFAULT_BRANCH,
    timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
    keep: false,
    ...overrides,
  };
}

/**
 * Builds a JSON response.
 *
 * @param body - Value to serialise.
 * @param status - HTTP status.
 * @returns The response.
 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Serialises one event the way the SSE route writes it.
 *
 * @param event - The event to frame.
 * @returns One complete `text/event-stream` frame.
 */
export function frame(event: AgentEvent): string {
  return `id: 1-0\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Builds an event-stream response from ready-made chunks.
 *
 * @param chunks - Text pieces, enqueued in order; a frame may straddle two of them.
 * @returns A `200` response whose body is those chunks.
 */
export function stream(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

/** The events of a turn that did everything the check asks for. */
export const HAPPY_EVENTS: readonly AgentEvent[] = [
  { type: 'turn.started', turnId: 'turn-1', at: AT },
  { type: 'prepare.done', headSha: '7fd1a60aaaa', branch: 'agent/abc' },
  { type: 'step.started', step: 1 },
  { type: 'tool.call', callId: 'c1', name: 'list_dir', args: { path: null, depth: null }, seq: 0 },
  { type: 'tool.result', callId: 'c1', exitCode: 0, bytes: 6, durationMs: 3, status: 'SUCCEEDED' },
  {
    type: 'tool.call',
    callId: 'c2',
    name: 'write_file',
    args: { path: 'SMOKE.md', content: '# smoke' },
    seq: 1,
  },
  { type: 'tool.result', callId: 'c2', exitCode: 0, bytes: 7, durationMs: 2, status: 'SUCCEEDED' },
  {
    type: 'turn.completed',
    usage: { inputTokens: 1200, outputTokens: 300 },
    steps: 2,
    finalMessage: 'Listed the files and wrote SMOKE.md.',
  },
];

/** Handlers a test may replace, one per route the check calls. */
export interface Stubs {
  health: () => Response;
  settings: () => Response;
  createChat: () => Response;
  events: () => Response;
  cancel: () => Response;
  deleteChat: () => Response;
}

/** One recorded request. */
export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Builds a `fetch` that answers each route, recording what it was asked.
 *
 * @param overrides - Handlers replacing the healthy defaults.
 * @returns The `fetch` implementation and the log of calls it saw.
 */
export function stubFetch(overrides: Partial<Stubs> = {}): {
  fetch: SmokeDeps['fetch'];
  calls: RecordedCall[];
} {
  const stubs: Stubs = {
    health: () =>
      json({
        ok: true,
        instance: 'local',
        checks: {
          db: { ok: true },
          redis: { ok: true },
          docker: { ok: true },
          image: { ok: true },
        },
      }),
    settings: () =>
      json({ githubPat: { set: true }, openaiKey: { set: true }, model: 'gpt-5.6-sol' }),
    createChat: () => json({ chatId: 'chat-1', turnId: 'turn-1' }),
    events: () => stream(HAPPY_EVENTS.map(frame)),
    cancel: () => json({ ok: true }, 202),
    deleteChat: () => new Response(null, { status: 204 }),
    ...overrides,
  };
  const calls: RecordedCall[] = [];
  const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url.endsWith('/api/health')) {
      return Promise.resolve(stubs.health());
    }
    if (url.endsWith('/api/settings')) {
      return Promise.resolve(stubs.settings());
    }
    if (url.endsWith('/api/chats')) {
      return Promise.resolve(stubs.createChat());
    }
    if (url.endsWith('/events')) {
      return Promise.resolve(stubs.events());
    }
    if (url.endsWith('/cancel')) {
      return Promise.resolve(stubs.cancel());
    }
    return Promise.resolve(stubs.deleteChat());
  };
  return { fetch: fetchImpl, calls };
}

/**
 * Runs the check against a stub, collecting its report.
 *
 * @param overrides - Route handlers replacing the healthy defaults.
 * @param extra - Options and dependency overrides.
 * @returns The result, the printed lines and the recorded calls.
 */
export async function runCheck(
  overrides: Partial<Stubs> = {},
  extra: { options?: Partial<SmokeOptions> } = {},
): Promise<{ exitCode: number; summary: string; lines: string[]; calls: RecordedCall[] }> {
  const { fetch: fetchImpl, calls } = stubFetch(overrides);
  const lines: string[] = [];
  let tick = 0;
  const result = await runSmoke(options(extra.options), {
    fetch: fetchImpl,
    now: (): number => {
      tick += 2500;
      return tick;
    },
    log: (line) => lines.push(line),
  });
  return { ...result, lines, calls };
}
