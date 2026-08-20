/**
 * Shared setup for the `@redis` integration suites.
 *
 * Layer: test double (integration).
 *
 * The convention mirrors the `@db` suites, down to the shape: {@link shouldRunRedisSuite} decides
 * and {@link describeRedis} only registers, so the decision is reachable — and therefore testable —
 * without registering a suite. An unconfigured resource fails loudly in CI, where a silently
 * skipped suite is indistinguishable from a passing one, and prints an instruction locally, where
 * not everyone has the stack running.
 *
 * Security: `REDIS_URL` is a local, credential-free URL today, but a connection string is exactly
 * the kind of value that grows a password later, so every message here names host and port only
 * and never the URL itself.
 */
import { randomUUID } from 'node:crypto';

import { describe } from 'vitest';

/** Environment variable the suites read. */
export const REDIS_URL_ENV = 'REDIS_URL';

/** Environment variable that marks a continuous-integration run. */
export const CI_ENV = 'CI';

/** How long {@link pingOrFail} waits for a reply. */
export const PING_TIMEOUT_MS = 5000;

/** What {@link pingOrFail} needs from a client. */
export interface PingableConnection {
  ping(): Promise<string>;
}

/**
 * Reads the configured Redis URL.
 *
 * @returns The URL, or `null` when it is unset or empty.
 */
export function requireRedisUrl(): string | null {
  const url = process.env[REDIS_URL_ENV];
  return url === undefined || url.length === 0 ? null : url;
}

/**
 * Describes a Redis URL by host and port only.
 *
 * @param url - The configured URL.
 * @returns `host:port`, or `the configured Redis URL` when it cannot be parsed.
 */
export function describeRedisTarget(url: string): string {
  const parsed = URL.parse(url);
  return parsed === null ? 'the configured Redis URL' : parsed.host;
}

/**
 * Generates a BullMQ key prefix unique to one test file run.
 *
 * Without it two suites running against the same Redis would share queue keys and see each
 * other's jobs.
 *
 * @returns A prefix such as `ah-test-<uuid>`.
 */
export function uniquePrefix(): string {
  return `ah-test-${randomUUID()}`;
}

/**
 * Verifies that Redis answers, within a bounded wait.
 *
 * @param connection - Client to ping.
 * @param url - URL the client was built from; only its host and port are quoted.
 * @throws Error When Redis does not answer in {@link PING_TIMEOUT_MS}, naming how to start it.
 */
export async function pingOrFail(connection: PingableConnection, url: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Redis at ${describeRedisTarget(url)} did not answer PING within ${PING_TIMEOUT_MS} ms. ` +
            'Start it with "pnpm infra:up".',
        ),
      );
    }, PING_TIMEOUT_MS);
  });
  try {
    await Promise.race([connection.ping(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decision {@link describeRedis} reaches about whether to run its suite.
 *
 * A union rather than one shape with an optional field: a reason only exists when the suite is
 * skipped, and there is nothing for the running case to carry.
 */
export type RedisSuiteDecision =
  | { url: string }
  | {
      url: null;
      /** Skip notice naming the suite and how to start the stack. */
      reason: string;
    };

/**
 * Decides whether a `@redis` suite should run, without connecting to anything.
 *
 * `REDIS_URL` present → run against it. Absent in CI → the suite must not silently pass, so this
 * throws rather than returning a decision the caller could ignore: a skipped integration suite is
 * indistinguishable from a passing one, and a broken service would ship unnoticed. Absent locally
 * → skip, with a message telling the developer how to start the stack.
 *
 * @param name - Suite name, quoted in the skip notice.
 * @returns The URL to run against, or `null` plus the reason the suite is skipped.
 * @throws Error When `REDIS_URL` is unset while {@link CI_ENV} is set.
 */
export function shouldRunRedisSuite(name: string): RedisSuiteDecision {
  const url = requireRedisUrl();
  if (url !== null) {
    return { url };
  }
  if (process.env[CI_ENV] !== undefined) {
    throw new Error(
      `${REDIS_URL_ENV} is not set; CI must provide Redis (see the integration job in ` +
        '.github/workflows/ci.yml).',
    );
  }
  return {
    url: null,
    reason:
      `[skip] ${name}: set ${REDIS_URL_ENV} to run it. Start the instance stack with ` +
      '"pnpm infra:up" and export the URL that "infra/scripts/env.sh --print" reports.',
  };
}

/**
 * Declares a suite that needs Redis.
 *
 * The resolved URL is handed to the suite body, so a suite never has to re-read the environment
 * or carry a fallback for the case the wrapper already ruled out.
 *
 * @param name - Suite name; the `@redis` tag belongs at its start.
 * @param fn - Suite body, receiving the configured URL.
 * @throws Error When `REDIS_URL` is unset while {@link CI_ENV} is set.
 */
export function describeRedis(name: string, fn: (redisUrl: string) => void): void {
  const decision = shouldRunRedisSuite(name);
  if (decision.url === null) {
    // Deliberate, human-facing local skip notice — not an application log path.
    console.info(decision.reason);
    describe.skip(name, () => {
      fn('');
    });
    return;
  }
  const { url } = decision;
  describe(name, () => {
    fn(url);
  });
}
