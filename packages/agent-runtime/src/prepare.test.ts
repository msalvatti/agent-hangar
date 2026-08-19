/**
 * Unit tests for workspace preparation.
 *
 * Layer: unit.
 * Goal: every shape of repository URL that is not a credential-free GitHub https URL is refused;
 * cloning, refreshing and the three work-branch cases each land on the right commit and announce
 * themselves in order; a moved branch warns without failing; and git never sees the credentials.
 * Mocks: none for git — real repositories on a `file://` remote stand in for GitHub.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentEvent, TurnRequest } from '@agent-hangar/core';
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createChildEnv } from './child-env.js';
import { createGitRunner } from './git.js';
import type { GitArgs, GitRunOptions, GitRunner } from './git.js';
import { assertGithubHttpsUrl, prepare, PrepareError } from './prepare.js';
import type { PrepareDeps } from './prepare.js';
import { createBareRepoWithSeed } from './testing/bare-repo.js';
import type { BareRepo } from './testing/bare-repo.js';
import { makeTempDir, removeTempDir } from './testing/temp-dir.js';

/** Child environment as the turn command builds it: no credentials, askpass wired. */
const childEnv = createChildEnv(
  {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GITHUB_TOKEN: GITHUB_CANARY,
    OPENAI_API_KEY: OPENAI_CANARY,
  },
  { tokenFile: '/tmp/ah-runtime/git-token' },
);

let repo: BareRepo;
let root: string;
let events: AgentEvent[];
let seenEnvs: Record<string, string>[];
let deps: PrepareDeps;

/** Wraps a runner so the tests can inspect the environment git was actually given. */
function recordingRunner(inner: GitRunner): GitRunner {
  return {
    run(args: GitArgs, options: GitRunOptions) {
      seenEnvs.push(options.env);
      return inner.run(args, options);
    },
  };
}

/**
 * Builds the repository section of a turn request.
 *
 * @param overrides - Fields to change.
 * @returns The repository section.
 */
function repoSection(overrides: Partial<TurnRequest['repo']> = {}): TurnRequest['repo'] {
  return { url: repo.url, baseBranch: 'main', workBranch: 'agent/work', ...overrides };
}

/**
 * Collects the messages of the emitted `prepare.progress` events.
 *
 * @returns One string per progress event, in order.
 */
function progressMessages(): string[] {
  return events.filter((event) => event.type === 'prepare.progress').map((event) => event.message);
}

beforeEach(async () => {
  repo = await createBareRepoWithSeed({ extraBranches: ['agent/existing'] });
  root = await makeTempDir('prepare-root');
  events = [];
  seenEnvs = [];
  deps = {
    workspaceRoot: root,
    git: recordingRunner(createGitRunner()),
    env: childEnv,
    emit: async (event) => {
      events.push(event);
      await Promise.resolve();
    },
    urlPolicy: 'any',
  };
});

afterEach(async () => {
  await repo.cleanup();
  await removeTempDir(root);
});

describe('assertGithubHttpsUrl', () => {
  it.each([
    ['a plain repository URL', 'https://github.com/acme/widgets'],
    ['a URL with the git suffix', 'https://github.com/acme/widgets.git'],
    ['a name with dots and dashes', 'https://github.com/acme-co/my.widgets-v2'],
  ])('accepts %s', (_name, url) => {
    // These are the URLs the repository picker produces.
    expect(() => {
      assertGithubHttpsUrl(url);
    }).not.toThrow();
  });

  it.each([
    ['embedded credentials', `https://x-access-token:${GITHUB_CANARY}@github.com/acme/widgets`],
    ['a plaintext scheme', 'http://github.com/acme/widgets'],
    ['another host', 'https://gitlab.com/acme/widgets'],
    ['a host that merely ends in the allowed one', 'https://github.com.evil.test/acme/widgets'],
    ['an explicit port', 'https://github.com:8443/acme/widgets'],
    ['an ssh remote', 'git@github.com:acme/widgets.git'],
    ['an ssh URL', 'ssh://git@github.com/acme/widgets.git'],
    ['a query string', 'https://github.com/acme/widgets?x=1'],
    ['a fragment', 'https://github.com/acme/widgets#frag'],
    ['a deeper path', 'https://github.com/acme/widgets/tree/main'],
    ['a missing repository name', 'https://github.com/acme'],
    ['text that is not a URL at all', 'not a url'],
  ])('refuses %s', (_name, url) => {
    // The askpass helper releases the PAT for github.com over https; anything else that git is
    // pointed at is a way to get the token sent somewhere it does not belong.
    expect(() => {
      assertGithubHttpsUrl(url);
    }).toThrow(PrepareError);
  });

  it('is applied by default, without a policy being asked for', async () => {
    // A caller that forgets the policy must get the strict one, not the permissive one.
    const { urlPolicy: _ignored, ...strict } = deps;
    await expect(prepare(repoSection(), { clone: true }, strict)).rejects.toThrow(PrepareError);
  });
});

describe('prepare with a fresh workspace', () => {
  it('clones the base branch and creates a work branch that does not exist yet', async () => {
    // The first turn of a chat: nothing exists locally and the branch is new.
    const result = await prepare(repoSection(), { clone: true }, deps);
    expect(result).toStrictEqual({ headSha: repo.headSha, branch: 'agent/work' });
    expect(progressMessages()).toStrictEqual([
      `Cloning ${repo.url} (branch main)…`,
      `Created agent/work from main at ${repo.headSha.slice(0, 7)}`,
    ]);
    expect(events.at(-1)).toStrictEqual({
      type: 'prepare.done',
      headSha: repo.headSha,
      branch: 'agent/work',
    });
  });

  it('checks out a work branch that already exists on the remote', async () => {
    // A restored chat continues on the branch its earlier turns pushed.
    const result = await prepare(
      repoSection({ workBranch: 'agent/existing' }),
      { clone: true },
      deps,
    );
    expect(result.branch).toBe('agent/existing');
    expect(result.headSha).not.toBe(repo.headSha);
    expect(progressMessages().at(-1)).toBe(
      `Checked out agent/existing at ${result.headSha.slice(0, 7)}`,
    );
  });

  it('stays on the base branch when the work branch is the same', async () => {
    // Some chats work directly on the default branch.
    const result = await prepare(repoSection({ workBranch: 'main' }), { clone: true }, deps);
    expect(result).toStrictEqual({ headSha: repo.headSha, branch: 'main' });
    expect(progressMessages().at(-1)).toBe(`On main at ${repo.headSha.slice(0, 7)}`);
  });

  it('gives git an environment with no credentials and an askpass helper', async () => {
    // Preparation is where the token would leak into a remote URL if it were in the environment.
    await prepare(repoSection(), { clone: true }, deps);
    expect(seenEnvs.length).toBeGreaterThan(0);
    for (const env of seenEnvs) {
      expect(env).not.toHaveProperty('GITHUB_TOKEN');
      expect(env).not.toHaveProperty('OPENAI_API_KEY');
      expect(env.GIT_ASKPASS).toBe('/opt/agent-runtime/askpass.sh');
      expect(env.AH_GIT_TOKEN_FILE).toBe('/tmp/ah-runtime/git-token');
    }
  });

  it('fails when the base branch does not exist on the remote', async () => {
    // A repository picker that offered a stale branch must not hang the turn.
    await expect(
      prepare(repoSection({ baseBranch: 'nope' }), { clone: true }, deps),
    ).rejects.toThrow('git clone failed');
  });

  it('fails when cloning was not requested and the workspace holds no repository', async () => {
    // The host promised a prepared workspace and it is not there; guessing would be worse.
    await expect(prepare(repoSection(), { clone: false }, deps)).rejects.toThrow(
      'the workspace holds no repository',
    );
  });
});

describe('prepare with a workspace that already holds the repository', () => {
  beforeEach(async () => {
    await prepare(repoSection({ workBranch: 'main' }), { clone: true }, deps);
    events = [];
    seenEnvs = [];
  });

  it('refreshes instead of cloning again when cloning is requested', async () => {
    // A live workspace that is asked to prepare again must not try to clone into itself.
    const result = await prepare(repoSection({ workBranch: 'main' }), { clone: true }, deps);
    expect(progressMessages()[0]).toBe('Refreshing the existing checkout…');
    expect(result.headSha).toBe(repo.headSha);
  });

  it('skips fetching entirely when cloning was not requested', async () => {
    // Later turns of a live chat reuse the checkout the first turn produced.
    await writeFile(path.join(root, 'scratch.txt'), 'work in progress\n', 'utf8');
    const result = await prepare(repoSection({ workBranch: 'main' }), { clone: false }, deps);
    expect(progressMessages()).toStrictEqual([`On main at ${repo.headSha.slice(0, 7)}`]);
    expect(result.headSha).toBe(repo.headSha);
  });
});

describe('prepare and the expected head', () => {
  it('warns when the branch moved since the host last saw it', async () => {
    // Restoring an archived chat is exactly when this happens, and it is not a failure.
    const result = await prepare(
      repoSection({ workBranch: 'main', expectedHeadSha: 'a'.repeat(40) }),
      { clone: true },
      deps,
    );
    expect(progressMessages().at(-1)).toBe(
      `Warning: expected HEAD aaaaaaa but found ${repo.headSha.slice(0, 7)}; the branch moved since the last snapshot`,
    );
    expect(events.at(-1)?.type).toBe('prepare.done');
    expect(result.headSha).toBe(repo.headSha);
  });

  it('says nothing when the branch is where the host expected', async () => {
    // The common restore: silence is the signal that nothing changed.
    await prepare(
      repoSection({ workBranch: 'main', expectedHeadSha: repo.headSha }),
      { clone: true },
      deps,
    );
    expect(progressMessages().some((message) => message.startsWith('Warning'))).toBe(false);
  });
});

describe('prepare and unexpected failures', () => {
  it('lets an error that is not a git failure through unchanged', async () => {
    // The turn command maps these to `turn.failed { code: 'runtime' }` and a non-zero exit.
    const broken: GitRunner = { run: () => Promise.reject(new Error('runner exploded')) };
    await expect(prepare(repoSection(), { clone: true }, { ...deps, git: broken })).rejects.toThrow(
      'runner exploded',
    );
  });
});
