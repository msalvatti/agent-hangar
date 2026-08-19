/**
 * Local bare repositories that stand in for GitHub in tests.
 *
 * Layer: test double.
 *
 * Preparation is mostly git behaviour — what `clone --branch` does, what `checkout -B` does to a
 * branch that already exists on the remote — so the only honest double is a real repository. A
 * `file://` remote provides that without a network, a server or a credential.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createChildEnv } from '../child-env.js';
import { createGitRunner, gitOrThrow } from '../git.js';
import type { GitArgs, GitRunner } from '../git.js';

import { makeTempDir, removeTempDir } from './temp-dir.js';

/** Identity for the seed commits; git refuses to commit without one, and there is no user config. */
const COMMITTER = [
  '-c',
  'user.name=Agent Hangar Test',
  '-c',
  'user.email=test@example.com',
] as const;

/**
 * Environment for the git invocations.
 *
 * The user's own git configuration is deliberately excluded: a global `init.defaultBranch`,
 * `commit.gpgsign` or hook path would otherwise make these tests behave differently per machine.
 */
const env: Record<string, string> = createChildEnv({
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
});

/** What to put in the repository. */
export interface BareRepoOptions {
  /** Branch the seed commit lands on; defaults to `main`. */
  branch?: string;
  /** Files of the seed commit, keyed by repository-relative path. */
  files?: Record<string, string>;
  /** Extra branches, each one commit ahead of the seed. */
  extraBranches?: readonly string[];
}

/** A seeded bare repository. */
export interface BareRepo {
  /** Path of the bare repository. */
  bareDir: string;
  /** `file://` URL to clone from. */
  url: string;
  /** Branch the seed commit is on. */
  branch: string;
  /** Sha of the seed commit. */
  headSha: string;
  /** Removes the bare repository and the scratch clone. */
  cleanup(): Promise<void>;
}

/**
 * Runs one git command, failing loudly when it does not succeed.
 *
 * @param git - Runner to use.
 * @param cwd - Working directory.
 * @param args - Subcommand and its arguments.
 * @returns The trimmed standard output.
 */
async function run(git: GitRunner, cwd: string, args: GitArgs): Promise<string> {
  return gitOrThrow(git, args, { cwd, env });
}

/**
 * Writes one seed file, creating the directories it needs.
 *
 * @param workDir - Scratch clone.
 * @param name - Repository-relative path.
 * @param content - File contents.
 */
async function writeSeedFile(workDir: string, name: string, content: string): Promise<void> {
  const target = path.join(workDir, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

/**
 * Creates a bare repository with one seed commit, plus any extra branches.
 *
 * @param options - Branch name, seed files and extra branches.
 * @returns The repository, its clone URL and the seed sha.
 */
export async function createBareRepoWithSeed(options: BareRepoOptions = {}): Promise<BareRepo> {
  const branch = options.branch ?? 'main';
  const git = createGitRunner();
  const bareDir = await makeTempDir('bare-repo');
  const workDir = await makeTempDir('bare-seed');

  await run(git, bareDir, ['init', '--bare', `--initial-branch=${branch}`, '.']);
  await run(git, workDir, ['init', `--initial-branch=${branch}`, '.']);
  await run(git, workDir, ['remote', 'add', 'origin', bareDir]);
  for (const [name, content] of Object.entries(options.files ?? { 'README.md': '# seed\n' })) {
    await writeSeedFile(workDir, name, content);
  }
  await run(git, workDir, ['add', '-A']);
  await run(git, workDir, [...COMMITTER, 'commit', '-m', 'seed']);
  await run(git, workDir, ['push', 'origin', branch]);
  const headSha = await run(git, workDir, ['rev-parse', 'HEAD']);

  for (const extra of options.extraBranches ?? []) {
    await run(git, workDir, ['checkout', '-B', extra, branch]);
    await run(git, workDir, [...COMMITTER, 'commit', '--allow-empty', '-m', `work on ${extra}`]);
    await run(git, workDir, ['push', 'origin', extra]);
  }

  return {
    bareDir,
    url: `file://${bareDir}`,
    branch,
    headSha,
    async cleanup() {
      await removeTempDir(bareDir);
      await removeTempDir(workDir);
    },
  };
}
