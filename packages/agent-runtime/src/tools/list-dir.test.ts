/**
 * Unit tests for the directory listing.
 *
 * Layer: unit.
 * Goal: a plain directory is walked to the requested depth with `.git` hidden, a git working tree
 * is listed through git so `.gitignore` is honoured, the entry count is capped with a note, and a
 * path that is not a directory or leaves the workspace fails.
 * Mocks: none for the walk; real `git` for the repository cases.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGitRunner } from '../git.js';
import { makeTempDir, removeTempDir } from '../testing/temp-dir.js';

import { listDir } from './list-dir.js';
import type { ListDirContext } from './list-dir.js';

let root: string;
let context: ListDirContext;

/** Environment for the real git invocations. */
const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

/**
 * Runs a git command in the workspace, failing the test when it does not succeed.
 *
 * @param args - Subcommand and its arguments.
 */
async function git(...args: [string, ...string[]]): Promise<void> {
  expect((await createGitRunner().run(args, { cwd: root, env })).code).toBe(0);
}

beforeEach(async () => {
  root = await makeTempDir('list-dir');
  await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), '# hi\n', 'utf8');
  await writeFile(path.join(root, 'src', 'a.ts'), 'export {};\n', 'utf8');
  await writeFile(path.join(root, 'src', 'nested', 'b.ts'), 'export {};\n', 'utf8');
  context = { workspaceRoot: root, env, maxOutputBytes: 32_768, git: createGitRunner() };
});

afterEach(async () => {
  await removeTempDir(root);
});

describe('listDir outside a repository', () => {
  it('lists one level by default and marks directories', async () => {
    // A shallow listing is what the model wants first; the trailing slash tells it where to go.
    const result = await listDir({ path: null, depth: null }, context);
    expect(result.output.split('\n')).toStrictEqual(['README.md', 'src/']);
    expect(result.status).toBe('SUCCEEDED');
  });

  it('walks deeper when asked', async () => {
    // Depth is bounded by the schema, so this cannot become an unbounded walk.
    const result = await listDir({ path: null, depth: 2 }, context);
    expect(result.output.split('\n')).toStrictEqual([
      'README.md',
      'src/',
      'src/a.ts',
      'src/nested/',
    ]);
  });

  it('lists a subdirectory relative to it', async () => {
    // Entries are relative to the directory that was listed, not to the workspace root.
    const result = await listDir({ path: 'src', depth: null }, context);
    expect(result.output.split('\n')).toStrictEqual(['a.ts', 'nested/']);
  });

  it('never shows git internal storage', async () => {
    // `.git` is thousands of files of no interest and would swamp the entry cap.
    const result = await listDir({ path: null, depth: 5 }, context);
    expect(result.output).not.toContain('.git');
  });

  it('caps the number of entries and says how many were left out', async () => {
    // A directory with thousands of files must not fill the model's context.
    await Promise.all(
      Array.from({ length: 30 }, async (_unused, index) =>
        writeFile(path.join(root, `f${String(index)}.txt`), 'x', 'utf8'),
      ),
    );
    const result = await listDir({ path: null, depth: 1 }, { ...context, maxEntries: 10 });
    const lines = result.output.split('\n');
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toBe('[… 22 more entries omitted]');
  });

  it('uses the real git runner when none is injected', async () => {
    // Production builds the runner itself; the default path has to work.
    const result = await listDir(
      { path: null, depth: null },
      {
        workspaceRoot: root,
        env,
        maxOutputBytes: 32_768,
      },
    );
    expect(result.output).toContain('README.md');
  });

  it('truncates a listing that exceeds the byte budget', async () => {
    // The listing shares the same budget as every other tool result.
    const result = await listDir({ path: null, depth: 2 }, { ...context, maxOutputBytes: 12 });
    expect(result.output).toContain('[truncated:');
  });
});

describe('listDir inside a repository', () => {
  beforeEach(async () => {
    await removeTempDir(path.join(root, '.git'));
    await git('init', '--initial-branch=main');
    await writeFile(path.join(root, '.gitignore'), 'ignored.txt\nbuild/\n', 'utf8');
    await writeFile(path.join(root, 'ignored.txt'), 'noise\n', 'utf8');
    await mkdir(path.join(root, 'build'), { recursive: true });
    await writeFile(path.join(root, 'build', 'out.js'), 'noise\n', 'utf8');
    await git('add', 'README.md');
  });

  it('honours .gitignore and still shows untracked files that are not ignored', async () => {
    // Listing `node_modules` and build output is what makes a plain walk useless here.
    const result = await listDir({ path: null, depth: 1 }, context);
    const lines = result.output.split('\n');
    expect(lines).toContain('README.md');
    expect(lines).toContain('.gitignore');
    expect(lines).toContain('src/');
    expect(lines).not.toContain('ignored.txt');
    expect(lines).not.toContain('build/');
  });

  it('falls back to walking the tree when git cannot list the files', async () => {
    // A corrupt index leaves the model with a listing rather than with nothing at all.
    const result = await listDir(
      { path: null, depth: 1 },
      {
        ...context,
        git: {
          run: (args) =>
            Promise.resolve(
              args[0] === 'rev-parse'
                ? { code: 0, stdout: 'true\n', stderr: '' }
                : { code: 128, stdout: '', stderr: 'fatal: index file corrupt' },
            ),
        },
      },
    );
    expect(result.output.split('\n')).toContain('ignored.txt');
  });

  it('synthesises the intermediate directories of a deeper listing', async () => {
    // Git reports file paths only, so the directories between them have to be derived.
    const result = await listDir({ path: null, depth: 2 }, context);
    const lines = result.output.split('\n');
    expect(lines).toContain('src/');
    expect(lines).toContain('src/a.ts');
    expect(lines).toContain('src/nested/');
    expect(lines).not.toContain('src/nested/b.ts');
  });
});

describe('listDir failures', () => {
  it('fails when the path is not a directory', async () => {
    // Listing a file is a mistake the model should see and correct.
    const result = await listDir({ path: 'README.md', depth: null }, context);
    expect(result).toMatchObject({ status: 'FAILED', output: 'not a directory: README.md' });
  });

  it('fails when the directory does not exist', async () => {
    // The model guesses paths; the workspace-relative name is what it needs back.
    const result = await listDir({ path: 'nope', depth: null }, context);
    expect(result).toMatchObject({ status: 'FAILED', output: 'directory not found: nope' });
  });

  it('refuses a path that leaves the workspace', async () => {
    // Enumerating the container filesystem is a reconnaissance step worth blocking.
    const result = await listDir({ path: '/etc', depth: null }, context);
    expect(result.status).toBe('FAILED');
    expect(result.output).toContain('escapes the workspace');
  });

  it('reports a workspace root that cannot be resolved at all', async () => {
    // A destroyed workspace must not surface as an unhandled rejection mid-turn.
    const result = await listDir(
      { path: null, depth: null },
      {
        ...context,
        workspaceRoot: path.join(root, 'gone'),
      },
    );
    expect(result).toMatchObject({ status: 'FAILED', output: 'path could not be resolved' });
  });
});
