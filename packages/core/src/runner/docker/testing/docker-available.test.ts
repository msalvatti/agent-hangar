/**
 * Unit tests for the `@docker` suite gate.
 *
 * Layer: unit.
 * Goal: the three outcomes are exactly as the testing policy requires — run when Docker was
 * declared available, refuse loudly in CI when it was not, and skip locally with an instruction.
 * The CI branch is the one that matters: a Docker suite that skips silently in the pipeline looks
 * identical to one that passed.
 * Mocks: the environment is injected.
 */
import { describe, expect, it } from 'vitest';

import { dockerGate } from './docker-available.ts';

describe('dockerGate', () => {
  /**
   * The explicit opt-in is the only thing that enables the suite; nothing is probed, so a running
   * daemon alone never turns it on by accident.
   */
  it('runs when DOCKER_AVAILABLE is 1', () => {
    expect(dockerGate({ DOCKER_AVAILABLE: '1', CI: 'true' })).toEqual({ run: true, reason: '' });
  });

  /**
   * In CI a missing daemon is a broken pipeline, not a reason to skip: reporting green for a suite
   * that never ran would hide every container-hardening regression this suite exists to catch.
   */
  it.each([
    ['CI is truthy', { CI: 'true' }],
    ['CI is set to 1', { CI: '1' }],
  ])('refuses to skip when %s', (_case, env) => {
    expect(() => dockerGate(env)).toThrow(/Refusing to skip silently/);
  });

  /**
   * Locally the suite skips, but it prints what to do about it — an unexplained skip is how a
   * suite quietly stops being run at all.
   */
  it.each([
    ['CI is absent', {}],
    ['CI is set but empty', { CI: '' }],
    ['DOCKER_AVAILABLE has another value', { DOCKER_AVAILABLE: '0' }],
  ])('skips with an instruction when %s', (_case, env) => {
    const gate = dockerGate(env);

    expect(gate.run).toBe(false);
    expect(gate.reason).toContain('DOCKER_AVAILABLE=1');
    expect(gate.reason).toContain('pnpm infra:image');
  });

  /**
   * Called with no argument the gate must read the real environment; only the shape is asserted
   * because the result legitimately differs between a developer's shell and the pipeline.
   */
  it('reads the process environment by default', () => {
    const previous = process.env.DOCKER_AVAILABLE;
    process.env.DOCKER_AVAILABLE = '1';
    try {
      expect(dockerGate()).toEqual({ run: true, reason: '' });
    } finally {
      if (previous === undefined) {
        delete process.env.DOCKER_AVAILABLE;
      } else {
        process.env.DOCKER_AVAILABLE = previous;
      }
    }
  });
});
