/**
 * Unit tests for workspace preparation.
 *
 * Layer: unit.
 * Goal: every repository URL that is not a credential-free repository on the workspace's own
 * origin is refused, whatever that origin is; the origin itself is read from the container
 * environment and a container that was never told one fails closed; cloning, refreshing and the
 * three work-branch cases each land on the right commit and announce themselves in order; a moved
 * branch warns without failing; and git never sees the credentials.
 *
 * The second turn of a chat runs preparation again over the workspace the first turn left behind,
 * so the suite also drives that: the work branch is checked out where the previous turn left it,
 * its commits and its uncommitted edits survive, and a remote that holds different commits is
 * reported rather than merged over them.
 * Mocks: none for git — real repositories on a `file://` remote stand in for GitHub.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ConfigError } from '@agent-hangar/core';
import type { AgentEvent, TurnRequest } from '@agent-hangar/core';
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createChildEnv } from './child-env.js';
import { createGitRunner, gitOrThrow } from './git.js';
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

/** Identity for the commits the tests make; the git configuration is empty by design. */
const COMMITTER = [
  '-c',
  'user.name=Agent Hangar Test',
  '-c',
  'user.email=test@example.com',
] as const;

/** Runner for the git commands the tests themselves issue, outside the code under test. */
const plainGit = createGitRunner();

/**
 * Runs one git command in a directory, failing the test when it does not succeed.
 *
 * @param cwd - Where to run it.
 * @param args - Subcommand and its arguments.
 * @returns The trimmed standard output.
 */
async function runGit(cwd: string, args: GitArgs): Promise<string> {
  return gitOrThrow(plainGit, args, { cwd, env: childEnv });
}

/**
 * Commits a file in the workspace, as the previous turn's agent would have.
 *
 * @param name - Workspace-relative path.
 * @param content - File contents.
 * @returns The sha of the new commit.
 */
async function commitInWorkspace(name: string, content: string): Promise<string> {
  await writeFile(path.join(root, name), content, 'utf8');
  await runGit(root, ['add', '--', name]);
  await runGit(root, [...COMMITTER, 'commit', '-m', `work on ${name}`]);
  return runGit(root, ['rev-parse', 'HEAD']);
}

/**
 * Adds a commit to a branch of the remote from a clone of its own, as another workspace would.
 *
 * @param branch - Branch to advance.
 * @returns The sha the remote branch now points at.
 */
async function commitOnRemote(branch: string): Promise<string> {
  const dir = await makeTempDir('remote-work');
  await runGit(dir, ['clone', '--branch', branch, '--', repo.url, '.']);
  await runGit(dir, [...COMMITTER, 'commit', '--allow-empty', '-m', `remote work on ${branch}`]);
  await runGit(dir, ['push', 'origin', branch]);
  const sha = await runGit(dir, ['rev-parse', 'HEAD']);
  await removeTempDir(dir);
  return sha;
}

/**
 * Replaces the tip of a branch on the remote with an unrelated commit, as a force push does.
 *
 * @param branch - Branch to rewrite.
 * @returns The sha the remote branch now points at.
 */
async function rewriteOnRemote(branch: string): Promise<string> {
  const dir = await makeTempDir('remote-rewrite');
  await runGit(dir, ['clone', '--branch', branch, '--', repo.url, '.']);
  await runGit(dir, ['reset', '--hard', 'HEAD~1']);
  await runGit(dir, [...COMMITTER, 'commit', '--allow-empty', '-m', `rewritten ${branch}`]);
  await runGit(dir, ['push', '--force', 'origin', branch]);
  const sha = await runGit(dir, ['rev-parse', 'HEAD']);
  await removeTempDir(dir);
  return sha;
}

/**
 * Reads the sha a branch of the remote points at.
 *
 * @param branch - Branch to look up.
 * @returns The sha, or an empty string when the remote does not publish the branch.
 */
async function remoteTip(branch: string): Promise<string> {
  const line = await runGit(root, ['ls-remote', '--heads', repo.url, branch]);
  return line.split('\t')[0] ?? '';
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
  /** These are the URLs the repository picker produces for the public forge. */
  it.each([
    ['a plain repository URL', 'https://github.com/acme/widgets'],
    ['a URL with the git suffix', 'https://github.com/acme/widgets.git'],
    ['a name with dots and dashes', 'https://github.com/acme-co/my.widgets-v2'],
  ])('accepts %s on the workspace origin', (_name, url) => {
    expect(resolveRepoUrl(url, GITHUB)).toBe(url);
  });

  /**
   * Anything git is pointed at that is not the workspace's own repository is a way to get the token
   * sent somewhere it does not belong, or to work on something nobody asked for.
   */
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
    expect(() => resolveRepoUrl(url, GITHUB)).toThrow(PrepareError);
  });

  /**
   * The origin decides the scheme and the port, so a forge listed as `http://host:port` is clonable
   * — anonymously, because the askpass helper still refuses to release a token over cleartext. A
   * rule fixed on the public forge refused this outright.
   */
  it('accepts a repository on a local forge the operator configured', () => {
    expect(resolveRepoUrl('http://host.docker.internal:3907/acme/sample.git', LOCAL_FORGE)).toBe(
      'http://host.docker.internal:3907/acme/sample.git',
    );
  });

  /**
   * The narrowing that matters most: a workspace created for a local forge must not be talked into
   * cloning — and authenticating to — a repository on github.com.
   */
  it('refuses a repository on the public forge when the workspace is not for it', () => {
    expect(() => resolveRepoUrl('https://github.com/acme/widgets', LOCAL_FORGE)).toThrow(
      PrepareError,
    );
  });

  /**
   * The limit of what one origin can express, stated rather than left implied: this policy is a
   * transport policy. A workspace on github.com may still be pointed at another repository there,
   * which is why the loop's other guards — the branch names, the workspace root — are not redundant
   * with it.
   */
  it('still accepts a different repository on the same origin', () => {
    expect(resolveRepoUrl('https://github.com/other/repo', GITHUB)).toBe(
      'https://github.com/other/repo',
    );
  });

  /**
   * The refused URL is exactly the one that may be carrying a credential, and this message is
   * persisted and displayed.
   */
  it('names the origin and never the URL when it refuses', () => {
    expect(() =>
      resolveRepoUrl(`https://x-access-token:${GITHUB_CANARY}@github.com/acme/widgets`, GITHUB),
    ).toThrow('repository URL must be https://github.com/<owner>/<repo> without credentials');
  });

  /**
   * Git echoes the remote into the credential prompt verbatim and the askpass helper compares that
   * prompt to an origin the host produced with the same normalisation, so a URL written with a
   * default port or a mixed-case host must be cloned in its canonical spelling or it would fail
   * authentication on a difference nobody can see.
   */
  it('hands git the URL as it was parsed, not as it was written', () => {
    expect(resolveRepoUrl('https://GitHub.com:443/acme/widgets', GITHUB)).toBe(
      'https://github.com/acme/widgets',
    );
  });

  /**
   * `any` exists for the suites that clone a `file://` remote; nothing in the environment can
   * produce it.
   */
  it('returns the URL untouched under the permissive policy the local suites use', () => {
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

  /**
   * This is the file the worker writes from the repository URL it has just vetted, and the trailing
   * newline it writes must not become part of the origin.
   */
  it('reads the origin the workspace was created for', async () => {
    await expect(policyFrom('https://github.com\n')).resolves.toStrictEqual(GITHUB);
  });

  /**
   * The path is the contract between the worker, this module and the askpass helper. Production
   * passes nothing, and none of the three takes it from anything the workspace could name.
   */
  it('defaults to the path the runner writes to', () => {
    expect(ALLOWED_ORIGIN_FILE).toBe('/opt/agent-runtime/allowed-origin');
  });

  /**
   * A container nobody prepared has no forge to fall back to: falling back to one would give a
   * workspace whose origin was never decided a policy from somewhere else.
   */
  it.each([
    ['empty', ''],
    ['blank', '  \n'],
    ['carrying a path', 'https://github.com/acme/widgets'],
    ['carrying a trailing slash', 'https://github.com/'],
    ['not a URL at all', 'github.com'],
    ['an opaque scheme with no origin', 'file:///srv/git'],
    ['carrying a second line', 'https://github.com\nhttps://evil.test\n'],
  ])('refuses a file that is %s', async (_name, content) => {
    await expect(policyFrom(content)).rejects.toThrow(ConfigError);
  });

  /** The failure direction of an unprepared container has to be refusal, never a default. */
  it('refuses a file that is not there at all', async () => {
    await expect(repositoryUrlPolicyFromFile(path.join(root, 'nothing-here'))).rejects.toThrow(
      ConfigError,
    );
  });

  /**
   * The local forge is reached on a port, and the port is part of the origin rather than a separate
   * rule.
   */
  it('accepts an origin with a non-default port', async () => {
    await expect(policyFrom('http://host.docker.internal:3907\n')).resolves.toStrictEqual(
      LOCAL_FORGE,
    );
  });
});

describe('branch names', () => {
  /** These are the shapes the host actually produces. */
  it.each([
    ['an ordinary branch', 'main'],
    ['a namespaced branch', 'agent/work-1.2_x'],
  ])('accepts %s', (_name, branch) => {
    expect(() => {
      assertBranchName(branch, 'workBranch');
    }).not.toThrow();
  });

  /**
   * Two of the git invocations take a branch positionally, where a leading dash becomes an option —
   * `--upload-pack` is how that turns into command execution on a non-https remote.
   */
  it.each([
    ['a name git would read as an option', '--upload-pack=/bin/sh'],
    ['a leading dash', '-f'],
    ['a shell metacharacter', 'main;rm -rf /'],
    ['an empty name', ''],
  ])('refuses %s', (_name, branch) => {
    expect(() => {
      assertBranchName(branch, 'workBranch');
    }).toThrow(PrepareError);
  });

  /** The check runs ahead of the clone, so nothing reaches git at all. */
  it.each([
    ['the base branch', { baseBranch: '--upload-pack=/bin/sh' }],
    ['the work branch', { workBranch: '-f' }],
  ])('refuses %s before running any git command', async (_name, overrides) => {
    await expect(prepare(repoSection(overrides), { clone: true }, deps)).rejects.toThrow(
      PrepareError,
    );
    expect(seenEnvs).toHaveLength(0);
  });
});

describe('prepare with a fresh workspace', () => {
  /** The first turn of a chat: nothing exists locally and the branch is new. */
  it('clones the base branch and creates a work branch that does not exist yet', async () => {
    const result = await prepare(repoSection(), { clone: true }, deps);
    expect(result).toStrictEqual({ headSha: repo.headSha, branch: 'agent/work', notes: [] });
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

  /** A restored chat continues on the branch its earlier turns pushed. */
  it('checks out a work branch that already exists on the remote', async () => {
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

  /** Some chats work directly on the default branch. */
  it('stays on the base branch when the work branch is the same', async () => {
    const result = await prepare(repoSection({ workBranch: 'main' }), { clone: true }, deps);
    expect(result).toStrictEqual({ headSha: repo.headSha, branch: 'main', notes: [] });
    expect(progressMessages().at(-1)).toBe(`On main at ${repo.headSha.slice(0, 7)}`);
  });

  /** Preparation is where the token would leak into a remote URL if it were in the environment. */
  it('gives git an environment with no credentials and an askpass helper', async () => {
    await prepare(repoSection(), { clone: true }, deps);
    expect(seenEnvs.length).toBeGreaterThan(0);
    for (const env of seenEnvs) {
      expect(env).not.toHaveProperty('GITHUB_TOKEN');
      expect(env).not.toHaveProperty('OPENAI_API_KEY');
      expect(env.GIT_ASKPASS).toBe('/opt/agent-runtime/askpass.sh');
      expect(env.AH_GIT_TOKEN_FILE).toBe('/tmp/ah-runtime/git-token');
    }
  });

  /** A repository picker that offered a stale branch must not hang the turn. */
  it('fails when the base branch does not exist on the remote', async () => {
    await expect(
      prepare(repoSection({ baseBranch: 'nope' }), { clone: true }, deps),
    ).rejects.toThrow('git clone failed');
  });

  /** The host promised a prepared workspace and it is not there; guessing would be worse. */
  it('fails when cloning was not requested and the workspace holds no repository', async () => {
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

  /** A live workspace that is asked to prepare again must not try to clone into itself. */
  it('refreshes instead of cloning again when cloning is requested', async () => {
    const result = await prepare(repoSection({ workBranch: 'main' }), { clone: true }, deps);
    expect(progressMessages()[0]).toBe('Refreshing the existing checkout…');
    expect(result.headSha).toBe(repo.headSha);
  });

  /** Later turns of a live chat reuse the checkout the first turn produced. */
  it('skips fetching entirely when cloning was not requested', async () => {
    await writeFile(path.join(root, 'scratch.txt'), 'work in progress\n', 'utf8');
    const result = await prepare(repoSection({ workBranch: 'main' }), { clone: false }, deps);
    expect(progressMessages()).toStrictEqual([`On main at ${repo.headSha.slice(0, 7)}`]);
    expect(result.headSha).toBe(repo.headSha);
  });
});

describe('prepare and the expected head', () => {
  /** Restoring an archived chat is exactly when this happens, and it is not a failure. */
  it('warns when the branch moved since the host last saw it', async () => {
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
    expect(result.notes).toStrictEqual([
      `Warning: expected HEAD aaaaaaa but found ${repo.headSha.slice(0, 7)}; the branch moved since the last snapshot`,
    ]);
  });

  /** The common restore: silence is the signal that nothing changed. */
  it('says nothing when the branch is where the host expected', async () => {
    await prepare(
      repoSection({ workBranch: 'main', expectedHeadSha: repo.headSha }),
      { clone: true },
      deps,
    );
    expect(progressMessages().some((message) => message.startsWith('Warning'))).toBe(false);
  });
});

describe('prepare on a second turn of the same chat', () => {
  beforeEach(async () => {
    // The first turn: a fresh workspace, cloned, with the work branch created and never pushed.
    await prepare(repoSection(), { clone: true }, deps);
    events = [];
    seenEnvs = [];
  });

  /**
   * The reported defect: the container and its checkout outlive the turn, so the second preparation
   * of a chat finds the branch already there while the remote still has nothing. Creating it again
   * is what failed with "a branch named 'agent/work' already exists".
   */
  it('resumes a work branch that exists in the workspace and not on the remote', async () => {
    const result = await prepare(repoSection(), { clone: false }, deps);
    expect(result).toStrictEqual({ headSha: repo.headSha, branch: 'agent/work', notes: [] });
    expect(progressMessages()).toStrictEqual([`Resumed agent/work at ${repo.headSha.slice(0, 7)}`]);
  });

  /**
   * The whole point of resuming: the second turn builds on the first turn's work, so the commit it
   * made is the commit preparation reports and the one the branch still names.
   */
  it('starts from the commit the previous turn made instead of rewinding the branch', async () => {
    const committed = await commitInWorkspace('answer.md', 'first turn\n');
    const result = await prepare(repoSection(), { clone: false }, deps);
    expect(result.headSha).toBe(committed);
    expect(committed).not.toBe(repo.headSha);
    await expect(runGit(root, ['rev-parse', 'refs/heads/agent/work'])).resolves.toBe(committed);
    await expect(readFile(path.join(root, 'answer.md'), 'utf8')).resolves.toBe('first turn\n');
  });

  /**
   * A turn ends whenever the model stops, not when the work tree is clean, so the next one starts
   * on top of uncommitted edits. Preparation switches HEAD and touches nothing else: it never
   * stashes, resets or checks out over them.
   */
  it('leaves a dirty work tree exactly as the previous turn left it', async () => {
    const committed = await commitInWorkspace('answer.md', 'first turn\n');
    await writeFile(path.join(root, 'answer.md'), 'edited, not committed\n', 'utf8');
    await writeFile(path.join(root, 'scratch.txt'), 'work in progress\n', 'utf8');
    const result = await prepare(repoSection(), { clone: false }, deps);
    expect(result.headSha).toBe(committed);
    await expect(readFile(path.join(root, 'answer.md'), 'utf8')).resolves.toBe(
      'edited, not committed\n',
    );
    await expect(readFile(path.join(root, 'scratch.txt'), 'utf8')).resolves.toBe(
      'work in progress\n',
    );
    await expect(runGit(root, ['status', '--porcelain'])).resolves.toContain('answer.md');
  });
});

describe('prepare when the work branch is on the remote', () => {
  /**
   * A workspace rebuilt from the persisted history has no local branch, so the remote is the only
   * copy of the chat's work and preparation lands exactly on it.
   */
  it('takes the remote tip when the workspace does not have the branch yet', async () => {
    const tip = await remoteTip('agent/existing');
    const result = await prepare(
      repoSection({ workBranch: 'agent/existing' }),
      { clone: true },
      deps,
    );
    expect(result).toStrictEqual({ headSha: tip, branch: 'agent/existing', notes: [] });
    expect(progressMessages().at(-1)).toBe(`Checked out agent/existing at ${tip.slice(0, 7)}`);
  });

  describe('and in the workspace as well', () => {
    beforeEach(async () => {
      // The first turn of a chat that pushed: the branch now exists on both sides.
      await prepare(repoSection(), { clone: true }, deps);
      await commitInWorkspace('answer.md', 'first turn\n');
      await runGit(root, ['push', 'origin', 'agent/work']);
      events = [];
      seenEnvs = [];
    });

    /** Nothing happened between the turns; silence is the signal that the branch is in sync. */
    it('says nothing extra when the two tips agree', async () => {
      const pushed = await remoteTip('agent/work');
      const result = await prepare(repoSection(), { clone: false }, deps);
      expect(result.headSha).toBe(pushed);
      expect(progressMessages()).toStrictEqual([`Resumed agent/work at ${pushed.slice(0, 7)}`]);
    });

    /**
     * The common case after a failed push: the local branch is ahead, preparation keeps it there
     * and names what the remote is missing.
     */
    it('reports commits the previous turn made and never pushed', async () => {
      const unpushed = await commitInWorkspace('notes.md', 'not pushed\n');
      const result = await prepare(repoSection(), { clone: false }, deps);
      expect(result.headSha).toBe(unpushed);
      expect(progressMessages()).toStrictEqual([
        `Resumed agent/work at ${unpushed.slice(0, 7)}`,
        '1 commit on agent/work not yet pushed to origin/agent/work.',
      ]);
    });

    /**
     * Someone else advanced the branch. Merging it here would rewrite a work tree the agent may
     * have left dirty, so the turn starts where the workspace stands and is told why.
     */
    it('warns instead of merging when the remote moved ahead', async () => {
      const local = await runGit(root, ['rev-parse', 'HEAD']);
      const moved = await commitOnRemote('agent/work');
      const result = await prepare(repoSection(), { clone: false }, deps);
      expect(result.headSha).toBe(local);
      expect(result.headSha).not.toBe(moved);
      expect(progressMessages()).toStrictEqual([
        `Resumed agent/work at ${local.slice(0, 7)}`,
        'Warning: origin/agent/work is 1 commit ahead of agent/work; preparation did not merge it.',
      ]);
    });

    /**
     * The warning has a second consumer and it is the one that can do something about it. It used
     * to reach only the event stream, where the transcript folded it into the collapsing progress
     * line and `prepare.done` overwrote it — so the divergence was told to nobody who could act on
     * it, while the model planned against a branch it had not been told had moved.
     */
    it('returns the divergence warning to the caller, not only to the event stream', async () => {
      await commitInWorkspace('notes.md', 'not pushed\n');
      await commitOnRemote('agent/work');
      const result = await prepare(repoSection(), { clone: false }, deps);

      expect(result.notes).toStrictEqual([
        'Warning: agent/work and origin/agent/work have diverged (1 commit here, 1 commit on the remote); preparation merged neither into the other.',
      ]);
    });

    /** A branch in sync produces nothing to carry, so a clean turn costs the model no context. */
    it('returns no note when the two tips agree', async () => {
      const result = await prepare(repoSection(), { clone: false }, deps);

      expect(result.notes).toStrictEqual([]);
    });

    /**
     * The state that a reset to the remote tip would destroy: commits exist on both sides and only
     * the workspace holds its own. Preparation reports the divergence and loses nothing.
     */
    it('warns and keeps the local commits when the two have diverged', async () => {
      const first = await commitInWorkspace('notes.md', 'not pushed\n');
      const second = await commitInWorkspace('more.md', 'also not pushed\n');
      const moved = await commitOnRemote('agent/work');
      const result = await prepare(repoSection(), { clone: false }, deps);
      expect(result.headSha).toBe(second);
      expect(result.headSha).not.toBe(moved);
      await expect(runGit(root, ['rev-list', '--count', `${first}..${second}`])).resolves.toBe('1');
      expect(progressMessages()).toStrictEqual([
        `Resumed agent/work at ${second.slice(0, 7)}`,
        'Warning: agent/work and origin/agent/work have diverged (2 commits here, 1 commit on the remote); preparation merged neither into the other.',
      ]);
    });

    /**
     * A force push makes the remote-tracking ref a non-fast-forward update. Refusing it would fail
     * every later turn of the chat over a ref that only mirrors what the remote says.
     */
    it('survives a work branch that was rewritten on the remote', async () => {
      const local = await runGit(root, ['rev-parse', 'HEAD']);
      const rewritten = await rewriteOnRemote('agent/work');
      const result = await prepare(repoSection(), { clone: false }, deps);
      expect(result.headSha).toBe(local);
      await expect(runGit(root, ['rev-parse', 'refs/remotes/origin/agent/work'])).resolves.toBe(
        rewritten,
      );
      expect(progressMessages().at(-1)).toBe(
        'Warning: agent/work and origin/agent/work have diverged (1 commit here, 1 commit on the remote); preparation merged neither into the other.',
      );
    });
  });
});

describe('prepare and unexpected failures', () => {
  /** The turn command maps these to `turn.failed { code: 'runtime' }` and a non-zero exit. */
  it('lets an error that is not a git failure through unchanged', async () => {
    const broken: GitRunner = { run: () => Promise.reject(new Error('runner exploded')) };
    await expect(prepare(repoSection(), { clone: true }, { ...deps, git: broken })).rejects.toThrow(
      'runner exploded',
    );
  });
});
