/**
 * Unit tests for the system prompt.
 *
 * Layer: unit.
 * Goal: the prompt names the repository and both branches, it tells the agent the two rules that
 * keep the credentials out of the repository it is about to write to, and its wording is fixed —
 * this text is the whole of what the model is told before it reads a repository nobody vetted, so
 * every sentence of it is written out here rather than derived from the module that builds it.
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

  /**
   * And the rest of it, verbatim. The prompt is assembled on the host precisely so that nothing in
   * the workspace can influence it, which makes its exact wording the contract: the tool names it
   * lists are the ones the runtime exposes, the confinement it promises is the one the runtime
   * enforces, and a line quietly dropped from it is a rule the model was never given. Sentences
   * checked one substring at a time leave the lines between them free to say anything at all.
   */
  it('is exactly this text', () => {
    const prompt = buildTurnInstructions({
      repoUrl: 'https://github.com/octocat/Hello-World',
      baseBranch: 'main',
      workBranch: 'agent/abc12345',
    });

    expect(prompt).toBe(
      [
        'You are a coding agent working inside a disposable Linux container.',
        '',
        'The repository https://github.com/octocat/Hello-World is checked out at /workspace, cloned from the branch',
        'main. Commit and push your work to the branch agent/abc12345; never push',
        'to main and never force-push.',
        '',
        'Tools: run_shell runs a command in the container, read_file and write_file work on paths',
        'inside /workspace, and list_dir enumerates a directory. Every path is confined to /workspace.',
        'Git is configured to authenticate on its own — never put a token in a URL, a command or a',
        'file, and never print environment variables.',
        '',
        'Work in small steps: inspect before you change, run the tests the repository already has, and',
        'stop as soon as the task is done. Finish with a short summary of what you changed and where.',
        'If the task cannot be completed, say what blocked you instead of inventing a result.',
      ].join('\n'),
    );
  });
});
