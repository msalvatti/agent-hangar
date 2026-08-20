/**
 * Gate of the `@docker @db @redis` suite.
 *
 * Layer: test double (integration).
 *
 * This is the only place the worker is proved against a real daemon, a real database and a real
 * Redis, so it must never report green without having run. Locally it skips with the exact
 * environment it is missing; in CI it refuses to skip at all, because a suite that silently passes
 * is indistinguishable from one that never executed.
 */
import type { RawEnv } from '@agent-hangar/core';
import { describe } from 'vitest';

/** Whether the Docker suite may run, and what is missing when it may not. */
export interface DockerSuiteDecision {
  /** Whether the suite should execute against real infrastructure. */
  run: boolean;
  /** Instruction printed when the suite is skipped; empty when it runs. */
  reason: string;
}

/** Environment variable that opts into the suite. */
export const DOCKER_AVAILABLE_ENV = 'DOCKER_AVAILABLE';

/** The only value {@link DOCKER_AVAILABLE_ENV} accepts. */
export const DOCKER_AVAILABLE_OPT_IN = '1';

/** Variables the suite needs besides the opt-in. */
const REQUIRED_URLS = ['DATABASE_URL', 'REDIS_URL'] as const;

/** How to prepare a shell for the suite. */
const INSTRUCTION =
  'start the stack with AH_INSTANCE=w2b-test AH_PORT_BASE=3310, build the image with ' +
  'pnpm infra:image, then run pnpm --filter worker test:integration';

/**
 * Lists what the environment is missing.
 *
 * @param env - Environment to read.
 * @returns The names of the variables that are unset or empty.
 */
function missingFrom(env: RawEnv): string[] {
  const missing: string[] = [];
  if (env[DOCKER_AVAILABLE_ENV] !== DOCKER_AVAILABLE_OPT_IN) {
    missing.push(`${DOCKER_AVAILABLE_ENV}=${DOCKER_AVAILABLE_OPT_IN}`);
  }
  for (const name of REQUIRED_URLS) {
    const value = env[name];
    if (value === undefined || value.length === 0) {
      missing.push(name);
    }
  }
  return missing;
}

/**
 * Decides whether the Docker suite should run.
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @returns The decision plus the instruction to print when skipping.
 * @throws Error When something is missing while `CI` is set, so the pipeline fails loudly instead
 *   of reporting a suite that never ran as passing.
 */
export function shouldRunDockerSuite(env: RawEnv = process.env): DockerSuiteDecision {
  const missing = missingFrom(env);
  if (missing.length === 0) {
    return { run: true, reason: '' };
  }
  const ci = env.CI;
  if (ci !== undefined && ci.length > 0) {
    throw new Error(
      `@docker suite cannot run: ${missing.join(', ')} — CI must provide Docker, Postgres and Redis`,
    );
  }
  return { run: false, reason: `@docker suite skipped: ${missing.join(', ')} — ${INSTRUCTION}` };
}

/** Prefix every suite of this kind carries, so reporters and filters can find it. */
export const DOCKER_SUITE_PREFIX = '@docker @db @redis';

/**
 * Registers a suite under a decision that has already been made.
 *
 * Separate from {@link describeDocker} so both outcomes are exercised by the gate's own tests: a
 * suite that silently stopped registering anything would otherwise look exactly like one that
 * passed.
 *
 * @param decision - Whether the suite may run, and why not.
 * @param title - Suite title.
 * @param fn - The `describe` body.
 */
export function registerDockerSuite(
  decision: DockerSuiteDecision,
  title: string,
  fn: () => void,
): void {
  const fullTitle = `${DOCKER_SUITE_PREFIX} ${title}`;
  if (!decision.run) {
    // Deliberate, human-facing local skip notice — not an application log path.
    console.warn(decision.reason);
    describe.skip(fullTitle, fn);
    return;
  }
  describe(fullTitle, fn);
}

/**
 * Registers a `describe` block that only runs against real infrastructure.
 *
 * @param title - Suite title; prefixed so reporters and filters can find it.
 * @param fn - The `describe` body.
 */
export function describeDocker(title: string, fn: () => void): void {
  registerDockerSuite(shouldRunDockerSuite(), title, fn);
}
