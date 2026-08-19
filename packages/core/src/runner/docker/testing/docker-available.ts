/**
 * Gate for the `@docker` integration suite.
 *
 * Layer: test double.
 *
 * The suite needs a real daemon and a built workspace image, neither of which a plain `pnpm test`
 * can assume. Locally it therefore skips with an instruction; in CI it refuses to skip at all,
 * because a silently green Docker suite is indistinguishable from one that never ran — and this
 * suite is the only place the container hardening is verified against a real daemon.
 */

/** Whether the `@docker` suite may run, and why not when it may not. */
export interface DockerGate {
  /** True when `DOCKER_AVAILABLE=1`. */
  run: boolean;
  /** Instruction printed when the suite is skipped; empty when it runs. */
  reason: string;
}

/**
 * Decides whether the `@docker` suite runs.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @returns The gate decision plus the instruction to print when skipping.
 * @throws Error when `CI` is set without `DOCKER_AVAILABLE=1`, so the pipeline fails loudly
 *   instead of reporting a suite that never ran as passing.
 */
export function dockerGate(env: NodeJS.ProcessEnv = process.env): DockerGate {
  if (env.DOCKER_AVAILABLE === '1') {
    return { run: true, reason: '' };
  }
  if (env.CI !== undefined && env.CI !== '') {
    throw new Error(
      'Integration suite requires DOCKER_AVAILABLE=1 in CI (Docker daemon + workspace image). Refusing to skip silently.',
    );
  }
  return {
    run: false,
    reason:
      'set DOCKER_AVAILABLE=1 (and build the image with pnpm infra:image) to run the @docker suite',
  };
}
