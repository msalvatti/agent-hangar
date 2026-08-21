/**
 * Unit tests for the bare-repository helper.
 *
 * Layer: unit.
 * Goal: the helper really produces a clonable repository with the seed commit on the named branch
 * and the extra branches ahead of it, because every preparation test is only as trustworthy as
 * this fixture.
 * Mocks: none; real `git` against temporary directories.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createGitRunner, gitOrThrow } from '../git.js';

import { createBareRepoWithSeed } from './bare-repo.js';
import type { BareRepo } from './bare-repo.js';
import { makeTempDir, removeTempDir } from './temp-dir.js';

const env: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

let repo: BareRepo | undefined;
let clone: string | undefined;

afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
  if (clone !== undefined) {
    await removeTempDir(clone);
    clone = undefined;
  }
});

describe('createBareRepoWithSeed', () => {
  /** The seed sha is what preparation tests assert `prepare.done` reports. */
  it('produces a repository that clones with the seed commit on the default branch', async () => {
    repo = await createBareRepoWithSeed({ files: { 'README.md': '# hello\n' } });
    clone = await makeTempDir('bare-repo-clone');
    const git = createGitRunner();
    await gitOrThrow(git, ['clone', '--branch', 'main', '--', repo.url, '.'], { cwd: clone, env });
    await expect(readFile(path.join(clone, 'README.md'), 'utf8')).resolves.toBe('# hello\n');
    await expect(gitOrThrow(git, ['rev-parse', 'HEAD'], { cwd: clone, env })).resolves.toBe(
      repo.headSha,
    );
    expect(repo.branch).toBe('main');
  });

  /** The work-branch cases need a branch that already exists on the remote. */
  it('creates nested seed files and extra branches ahead of the seed', async () => {
    repo = await createBareRepoWithSeed({
      branch: 'trunk',
      files: { 'src/a.ts': 'export {};\n' },
      extraBranches: ['agent/existing'],
    });
    clone = await makeTempDir('bare-repo-clone');
    const git = createGitRunner();
    await gitOrThrow(git, ['clone', '--branch', 'trunk', '--', repo.url, '.'], { cwd: clone, env });
    await expect(readFile(path.join(clone, 'src', 'a.ts'), 'utf8')).resolves.toBe('export {};\n');
    const heads = await gitOrThrow(git, ['ls-remote', '--heads', 'origin'], { cwd: clone, env });
    expect(heads).toContain('refs/heads/agent/existing');
    expect(heads).toContain('refs/heads/trunk');
    const tip = await gitOrThrow(git, ['rev-parse', 'origin/agent/existing'], { cwd: clone, env });
    expect(tip).not.toBe(repo.headSha);
  });
});
