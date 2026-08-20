/**
 * Unit tests for the system prompt.
 *
 * Layer: unit.
 * Goal: the prompt names the repository and both branches, and it tells the agent the two rules
 * that keep the credentials out of the repository it is about to write to.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { buildTurnInstructions } from './instructions.js';

describe('buildTurnInstructions', () => {
  /**
   * The prompt states where the work is and which branch it belongs on, because nothing inside the
   * container is trusted to tell the model that.
   */
  it('names the repository and both branches', () => {
    const prompt = buildTurnInstructions({
      repoUrl: 'https://github.com/octocat/Hello-World',
      baseBranch: 'main',
      workBranch: 'agent/abc12345',
    });

    expect(prompt).toContain('https://github.com/octocat/Hello-World');
    expect(prompt).toContain('agent/abc12345');
    expect(prompt).toContain('main');
    expect(prompt).toContain('/workspace');
  });

  /**
   * Two rules are non-negotiable and are stated as such: no token anywhere the repository could
   * capture it, and no pushing over the branch the user works on.
   */
  it('states the credential and branch rules', () => {
    const prompt = buildTurnInstructions({
      repoUrl: 'https://github.com/octocat/Hello-World',
      baseBranch: 'main',
      workBranch: 'agent/abc12345',
    });

    expect(prompt).toContain('never force-push');
    expect(prompt).toContain('never put a token');
  });
});
