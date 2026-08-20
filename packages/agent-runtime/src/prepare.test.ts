/**
 * Unit tests for workspace preparation.
 *
 * Layer: unit.
 * Goal: every repository URL that is not a credential-free repository on the workspace's own
 * origin is refused, whatever that origin is; the origin itself is read from the container
 * environment and a container that was never told one fails closed; cloning, refreshing and the
 * three work-branch cases each land on the right commit and announce themselves in order; a moved
 * branch warns without failing; and git never sees the credentials.
 * Mocks: none for git — real repositories on a `file://` remote stand in for GitHub.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ConfigError } from '@agent-hangar/core';
import type { AgentEvent, TurnRequest } from '@agent-hangar/core';
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createChildEnv } from './child-env.js';
import { createGitRunner } from './git.js';
import type { GitArgs, GitRunOptions, GitRunner } from './git.js';
import {
  ALLOWED_ORIGIN_FILE,
  assertBranchName,
  prepare,
  PrepareError,
  repositoryUrlPolicyFromFile,
  resolveRepoUrl,
} from './prepare.js';
import type { PrepareDeps, RepositoryUrlPolicy } from './prepare.js';
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
    urlPolicy: { allow: 'any' },
  };
});

afterEach(async () => {
  await repo.cleanup();
  await removeTempDir(root);
});

/** The policy a workspace created for a repository on the public forge runs under. */
const GITHUB: RepositoryUrlPolicy = { allow: 'origin', origin: 'https://github.com' };

/** The policy a workspace created for a local forge on a non-default port runs under. */
const LOCAL_FORGE: RepositoryUrlPolicy = {
  allow: 'origin',
  origin: 'http://host.docker.internal:3907',
};

describe('resolveRepoUrl', () => {
  it.each([
    ['a plain repository URL', 'https://github.com/acme/widgets'],
    ['a URL with the git suffix', 'https://github.com/acme/widgets.git'],
    ['a name with dots and dashes', 'https://github.com/acme-co/my.widgets-v2'],
  ])('accepts %s on the workspace origin', (_name, url) => {
    // These are the URLs the repository picker produces for the public forge.
    expect(resolveRepoUrl(url, GITHUB)).toBe(url);
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
    // Anything git is pointed at that is not the workspace's own repository is a way to get the
    // token sent somewhere it does not belong, or to work on something nobody asked for.
    expect(() => resolveRepoUrl(url, GITHUB)).toThrow(PrepareError);
  });

  it('accepts a repository on a local forge the operator configured', () => {
    // The origin decides the scheme and the port, so a forge listed as `http://host:port` is
    // clonable — anonymously, because the askpass helper still refuses to release a token over
    // cleartext. A rule fixed on the public forge refused this outright.
    expect(resolveRepoUrl('http://host.docker.internal:3907/acme/sample.git', LOCAL_FORGE)).toBe(
      'http://host.docker.internal:3907/acme/sample.git',
    );
  });

  it('refuses a repository on the public forge when the workspace is not for it', () => {
    // The narrowing that matters most: a workspace created for a local forge must not be talked
    // into cloning — and authenticating to — a repository on github.com.
    expect(() => resolveRepoUrl('https://github.com/acme/widgets', LOCAL_FORGE)).toThrow(
      PrepareError,
    );
  });

  it('still accepts a different repository on the same origin', () => {
    // The limit of what one origin can express, stated rather than left implied: this policy is a
    // transport policy. A workspace on github.com may still be pointed at another repository
    // there, which is why the loop's other guards — the branch names, the workspace root — are
    // not redundant with it.
    expect(resolveRepoUrl('https://github.com/other/repo', GITHUB)).toBe(
      'https://github.com/other/repo',
    );
  });

  it('names the origin and never the URL when it refuses', () => {
    // The refused URL is exactly the one that may be carrying a credential, and this message is
    // persisted and displayed.
    expect(() =>
      resolveRepoUrl(`https://x-access-token:${GITHUB_CANARY}@github.com/acme/widgets`, GITHUB),
    ).toThrow('repository URL must be https://github.com/<owner>/<repo> without credentials');
  });

  it('hands git the URL as it was parsed, not as it was written', () => {
    // Git echoes the remote into the credential prompt verbatim and the askpass helper compares
    // that prompt to an origin the host produced with the same normalisation, so a URL written
    // with a default port or a mixed-case host must be cloned in its canonical spelling or it
    // would fail authentication on a difference nobody can see.
    expect(resolveRepoUrl('https://GitHub.com:443/acme/widgets', GITHUB)).toBe(
      'https://github.com/acme/widgets',
    );
  });

  it('returns the URL untouched under the permissive policy the local suites use', () => {
    // `any` exists for the suites that clone a `file://` remote; nothing in the environment can
    // produce it.
    expect(resolveRepoUrl(repo.url, { allow: 'any' })).toBe(repo.url);
  });
});

describe('repositoryUrlPolicyFromFile', () => {
  /**
   * Writes a candidate origin file and reads the policy back from it.
   *
   * @param content - Exactly what the file holds, including any trailing newline.
   * @returns The resolved policy.
   */
  async function policyFrom(content: string): Promise<RepositoryUrlPolicy> {
    const file = path.join(root, 'allowed-origin');
    await writeFile(file, content, 'utf8');
    return repositoryUrlPolicyFromFile(file);
  }

  it('reads the origin the workspace was created for', async () => {
    // This is the file the worker writes from the repository URL it has just vetted, and the
    // trailing newline it writes must not become part of the origin.
    await expect(policyFrom('https://github.com\n')).resolves.toStrictEqual(GITHUB);
  });

  it('defaults to the path the runner writes to', () => {
    // The path is the contract between the worker, this module and the askpass helper. Production
    // passes nothing, and none of the three takes it from anything the workspace could name.
    expect(ALLOWED_ORIGIN_FILE).toBe('/opt/agent-runtime/allowed-origin');
  });

  it.each([
    ['empty', ''],
    ['blank', '  \n'],
    ['carrying a path', 'https://github.com/acme/widgets'],
    ['carrying a trailing slash', 'https://github.com/'],
    ['not a URL at all', 'github.com'],
    ['an opaque scheme with no origin', 'file:///srv/git'],
    ['carrying a second line', 'https://github.com\nhttps://evil.test\n'],
  ])('refuses a file that is %s', async (_name, content) => {
    // A container nobody prepared has no forge to fall back to: falling back to one would give a
    // workspace whose origin was never decided a policy from somewhere else.
    await expect(policyFrom(content)).rejects.toThrow(ConfigError);
  });

  it('refuses a file that is not there at all', async () => {
    // The failure direction of an unprepared container has to be refusal, never a default.
    await expect(repositoryUrlPolicyFromFile(path.join(root, 'nothing-here'))).rejects.toThrow(
      ConfigError,
    );
  });

  it('accepts an origin with a non-default port', async () => {
    // The local forge is reached on a port, and the port is part of the origin rather than a
    // separate rule.
    await expect(policyFrom('http://host.docker.internal:3907\n')).resolves.toStrictEqual(
      LOCAL_FORGE,
    );
  });
});

describe('branch names', () => {
  it.each([
    ['an ordinary branch', 'main'],
    ['a namespaced branch', 'agent/work-1.2_x'],
  ])('accepts %s', (_name, branch) => {
    // These are the shapes the host actually produces.
    expect(() => {
      assertBranchName(branch, 'workBranch');
    }).not.toThrow();
  });

  it.each([
    ['a name git would read as an option', '--upload-pack=/bin/sh'],
    ['a leading dash', '-f'],
    ['a shell metacharacter', 'main;rm -rf /'],
    ['an empty name', ''],
  ])('refuses %s', (_name, branch) => {
    // Two of the git invocations take a branch positionally, where a leading dash becomes an
    // option — `--upload-pack` is how that turns into command execution on a non-https remote.
    expect(() => {
      assertBranchName(branch, 'workBranch');
    }).toThrow(PrepareError);
  });

  it.each([
    ['the base branch', { baseBranch: '--upload-pack=/bin/sh' }],
    ['the work branch', { workBranch: '-f' }],
  ])('refuses %s before running any git command', async (_name, overrides) => {
    // The check runs ahead of the clone, so nothing reaches git at all.
    await expect(prepare(repoSection(overrides), { clone: true }, deps)).rejects.toThrow(
      PrepareError,
    );
    expect(seenEnvs).toHaveLength(0);
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
