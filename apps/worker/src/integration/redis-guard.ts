/**
 * Refusing to empty a Redis that is not this instance's throwaway one.
 *
 * Layer: utility (integration support).
 *
 * The integration harness clears Redis between runs, and `FLUSHDB` cannot be narrowed after the
 * fact: it takes the whole database — every queue, every turn stream, every application key. The
 * database half of the harness already fails closed, because `truncateAll` demands the destructive
 * opt-in and a database named by the test convention. This is the same check for the other half.
 *
 * It is not redundant with that one. `REDIS_URL` is an independent variable: a shared Redis named
 * alongside a conventionally named test database passes every other guard the suite has, and the
 * only thing standing between it and a flush today is the order the two statements happen to run
 * in. Each instance gets its own Redis on its own port, so what is safe to empty is precisely the
 * one this instance's configuration derives — and an overridden `REDIS_URL` pointing anywhere else
 * is exactly the case worth refusing.
 *
 * Security: a connection URL can carry credentials in its userinfo, its query or its fragment, so
 * no refusal repeats it. The target is named through `describeUrl`, which keeps scheme, host and
 * path and nothing else.
 */
import { ConfigError } from '@agent-hangar/core';
import type { AppConfig, RawEnv } from '@agent-hangar/core';
import { DESTRUCTIVE_TESTS_ENV, DESTRUCTIVE_TESTS_OPT_IN } from '@agent-hangar/core/testing';

import { describeUrl } from '../boot.js';

/** Hosts that can only be this machine, which is where a compose instance publishes its Redis. */
const LOOPBACK_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/**
 * Reports whether a URL names this instance's own Redis.
 *
 * Both halves have to hold. The port is what separates one instance's Redis from another's, and
 * the loopback host is what separates a compose instance from a shared server that happens to
 * publish the same port number.
 *
 * @param url - Value of `REDIS_URL`.
 * @param port - `REDIS_PORT` of the resolved instance.
 * @returns `true` when the URL is the instance's own throwaway Redis.
 */
function isInstanceRedis(url: string, port: number): boolean {
  const parsed = URL.parse(url);
  if (parsed === null) {
    return false;
  }
  return LOOPBACK_HOSTNAMES.includes(parsed.hostname) && parsed.port === String(port);
}

/**
 * Throws unless the configured Redis may be emptied.
 *
 * @param config - Validated configuration of the instance under test.
 * @param env - Environment carrying the opt-in (defaults to `process.env`).
 * @throws ConfigError before anything is deleted, when the opt-in is missing or when `REDIS_URL`
 *   is not this instance's own Redis.
 */
export function assertRedisErasable(config: AppConfig, env: RawEnv = process.env): void {
  if (env[DESTRUCTIVE_TESTS_ENV] !== DESTRUCTIVE_TESTS_OPT_IN) {
    throw new ConfigError(
      `This harness empties Redis, so it needs ${DESTRUCTIVE_TESTS_ENV}=` +
        `${DESTRUCTIVE_TESTS_OPT_IN} and a throwaway instance. Create one with ` +
        `"AH_INSTANCE=test pnpm setup"; never point it at a Redis anything else uses.`,
    );
  }
  if (!isInstanceRedis(config.REDIS_URL, config.REDIS_PORT)) {
    throw new ConfigError(
      `Refusing to empty ${describeUrl(config.REDIS_URL)}: it is not the Redis of instance ` +
        `"${config.AH_INSTANCE}", which this configuration puts on port ${String(config.REDIS_PORT)} ` +
        `of the loopback interface. A REDIS_URL pointing anywhere else may be shared, and this ` +
        `harness would erase every key in it.`,
    );
  }
}
