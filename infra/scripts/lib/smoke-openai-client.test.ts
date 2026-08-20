/**
 * Unit tests for the HTTP steps around the turn: the preconditions, and the cleanup that gives the
 * workspace back.
 *
 * Layer: unit.
 * Goal: nothing is created against an instance that cannot run a turn or a Settings without both
 * credentials; the check never reads a credential, only whether each one is stored; and the chat
 * it creates is deleted whatever the turn did, including when the delete has to wait for the
 * worker or the turn has to be cancelled first.
 *
 * Driven through `runSmoke` rather than against each step directly, because each step is only
 * meaningful in the sequence: what matters about the cleanup is that it still runs after a turn
 * that failed, and what matters about the preflight is what it stops from being created.
 * Mocks: the stub instance in `../testing/smoke-openai-harness.ts`; fake timers for the retry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, options, runCheck, stubFetch } from '../testing/smoke-openai-harness.js';

import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_PRECONDITION,
  SETTINGS_MISSING_MESSAGE,
} from './smoke-openai-options.js';
import { runSmoke } from './smoke-openai.js';

/** Milliseconds between cleanup attempts, mirrored from the module under test. */
const CLEANUP_RETRY_MS = 500;

afterEach(() => {
  vi.useRealTimers();
});

describe('runSmoke, preconditions', () => {
  /**
   * Nothing is wrong with the request when the instance is not running; the operator has to start
   * it. That is a different answer from "the turn failed", and the exit code says so.
   */
  it('reports an instance that does not answer', async () => {
    const lines: string[] = [];
    const result = await runSmoke(options(), {
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      now: () => 0,
      log: (line) => lines.push(line),
    });
    expect(result.exitCode).toBe(EXIT_PRECONDITION);
    expect(lines[0]).toBe(
      'error cannot reach /api/health (TypeError) — start the instance with: pnpm dev',
    );
  });

  /**
   * A turn needs Docker and the workspace image as much as it needs the database, and the failing
   * rows are named so the operator knows which one to fix.
   */
  it('names the health rows that are not ready', async () => {
    const result = await runCheck({
      health: () =>
        json({
          ok: false,
          instance: 'local',
          checks: {
            db: { ok: true },
            redis: { ok: true },
            docker: { ok: false },
            image: { ok: false },
            worker: { ok: true },
          },
        }),
    });
    expect(result.exitCode).toBe(EXIT_PRECONDITION);
    expect(result.lines).toContain('error instance not ready: docker, image');
    // Nothing ran, so the report must not read as a verdict on the product.
    expect(result.lines).toContain('smoke NOT RUN');
    expect(result.lines).not.toContain('smoke FAIL');
  });

  /**
   * The check never reads a key: it only asks whether Settings holds them. A missing one is the
   * one precondition an operator fixes in the product rather than in a terminal, so the message is
   * the instruction.
   */
  it.each([
    ['the GitHub token', { githubPat: { set: false }, openaiKey: { set: true } }],
    ['the OpenAI key', { githubPat: { set: true }, openaiKey: { set: false } }],
  ])('refuses to run without %s', async (_case, secrets) => {
    const result = await runCheck({ settings: () => json({ ...secrets, model: 'gpt-5.6-sol' }) });
    expect(result.exitCode).toBe(EXIT_PRECONDITION);
    expect(result.lines).toContain(`error ${SETTINGS_MISSING_MESSAGE}`);
  });

  /**
   * Every shape a preflight route can answer wrongly is a precondition failure that names the
   * route, never an unhandled rejection: this runs before anything was created, so there is
   * nothing to clean up and nothing to misreport.
   */
  it.each([
    [
      'a non-2xx status',
      { health: () => json({ error: { code: 'X', message: 'y' } }, 503) },
      '/api/health answered HTTP 503',
    ],
    [
      'a body that is not JSON',
      { health: () => new Response('<html>', { status: 200 }) },
      '/api/health did not answer JSON (SyntaxError)',
    ],
    [
      'a body of the wrong shape',
      { health: () => json({ ok: true }) },
      '/api/health answered an unrecognised body',
    ],
    [
      'a settings body of the wrong shape',
      { settings: () => json({ model: 1 }) },
      '/api/settings answered an unrecognised body',
    ],
  ])('reports %s', async (_case, overrides, expected) => {
    const result = await runCheck(overrides);
    expect(result.exitCode).toBe(EXIT_PRECONDITION);
    expect(result.lines).toContain(`error ${expected}`);
  });
});

describe('runSmoke, cleanup', () => {
  /**
   * The delete is refused while the chat still carries a live turn, and the transcript reaches
   * `turn.completed` a moment before the worker writes that status. Retrying is what turns a race
   * this check would otherwise lose into a wait it wins.
   */
  it('retries a delete refused by a turn that has not yet been written as finished', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { fetch: fetchImpl } = stubFetch({
      deleteChat: () => {
        attempts += 1;
        return attempts === 1
          ? json({ error: { code: 'TURN_IN_PROGRESS', message: 'wait' } }, 409)
          : new Response(null, { status: 204 });
      },
    });
    const lines: string[] = [];
    const pending = runSmoke(options(), {
      fetch: fetchImpl,
      now: () => 0,
      log: (line) => lines.push(line),
    });
    await vi.advanceTimersByTimeAsync(CLEANUP_RETRY_MS);
    const result = await pending;
    expect(result.exitCode).toBe(EXIT_OK);
    expect(attempts).toBe(2);
    expect(lines).toContain('cleanup ok chat=chat-1 workspace teardown queued');
  });

  /**
   * A refusal that never lets up is a workspace this check may have left running, which is a
   * failure of the check itself however well the turn went. Saying so is the only way an operator
   * learns to go and look.
   */
  it('fails when the delete is refused for good', async () => {
    vi.useFakeTimers();
    const { fetch: fetchImpl } = stubFetch({
      deleteChat: () => json({ error: { code: 'TURN_IN_PROGRESS', message: 'wait' } }, 409),
    });
    const lines: string[] = [];
    const pending = runSmoke(options(), {
      fetch: fetchImpl,
      now: () => 0,
      log: (line) => lines.push(line),
    });
    await vi.advanceTimersByTimeAsync(CLEANUP_RETRY_MS * 25);
    const result = await pending;
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(lines).toContain('cleanup failed chat=chat-1 still HTTP 409 after 20 attempts');
    expect(lines).toContain(
      'problem the chat was not deleted, so its workspace may still be running',
    );
  });

  /**
   * Any other refusal is final on the first answer: retrying a 500 twenty times would only delay
   * the same report by ten seconds.
   */
  it('fails immediately on a delete that is not a conflict', async () => {
    const result = await runCheck({
      deleteChat: () => json({ error: { code: 'X', message: 'y' } }, 500),
    });
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.lines).toContain('cleanup failed chat=chat-1 HTTP 500');
  });

  /**
   * An instance that went away before the cleanup leaves the same residue as a refusal, and is
   * reported the same way rather than as an unhandled rejection over a result already in hand.
   */
  it('fails when the delete cannot be issued', async () => {
    const { fetch: fetchImpl } = stubFetch();
    const lines: string[] = [];
    const result = await runSmoke(options(), {
      fetch: (url, init) =>
        init?.method === 'DELETE' ? Promise.reject(new Error('down')) : fetchImpl(url, init),
      now: () => 0,
      log: (line) => lines.push(line),
    });
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(lines).toContain('cleanup failed chat=chat-1 unreachable');
  });
});

describe('runSmoke, unexpected failure', () => {
  /**
   * Nothing this module calls should throw anything but its own aborts, and if something does, the
   * report names the error's class and nothing else: an error message this module did not compose
   * is not something it can promise is free of credentials.
   */
  it('names an unexpected error by its class alone', async () => {
    const { fetch: fetchImpl } = stubFetch();
    const lines: string[] = [];
    let calls = 0;
    const result = await runSmoke(options(), {
      fetch: fetchImpl,
      now: () => {
        calls += 1;
        if (calls > 1) {
          throw new RangeError('clock exploded');
        }
        return 0;
      },
      log: (line) => lines.push(line),
    });
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(lines).toContain('error unexpected failure (RangeError)');
    expect(lines.join('\n')).not.toContain('clock exploded');
  });

  /**
   * The same rule for something thrown that is not an `Error` at all: it has no class name to
   * report, and its own contents must not be interpolated into the output either.
   */
  it('names a thrown non-error as unknown', async () => {
    const { fetch: fetchImpl } = stubFetch();
    const thrown: unknown = { message: 'not an error' };
    const lines: string[] = [];
    let calls = 0;
    const result = await runSmoke(options(), {
      fetch: fetchImpl,
      now: () => {
        calls += 1;
        if (calls > 1) {
          throw thrown;
        }
        return 0;
      },
      log: (line) => lines.push(line),
    });
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(lines).toContain('error unexpected failure (unknown)');
    expect(lines.join('\n')).not.toContain('not an error');
  });
});
