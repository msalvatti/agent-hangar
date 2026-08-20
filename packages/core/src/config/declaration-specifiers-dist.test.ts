/**
 * Regression guard over the actually emitted declaration graph of @agent-hangar/core.
 *
 * Layer: integration (reads `packages/core/dist`; requires a prior
 * `pnpm --filter @agent-hangar/core build` — a fresh worktree has never been built).
 * Goal: `declaration-specifiers.test.ts` proves the rewrite transform is correct in isolation;
 * this suite proves the build actually applied it to what is on disk. A regression here would
 * mean either the `build` script stopped calling
 * `packages/core/scripts/rewrite-declaration-specifiers.ts`, or a new TypeScript release started
 * emitting a specifier shape the transform does not recognize.
 *
 * `packages/core/dist` does not exist in a worktree that has never been built, and this suite has
 * nothing to check in that state — scanning an absent directory would either report a trivial,
 * meaningless pass or require fabricating content to scan, neither of which tests anything real.
 * `describe.skipIf` marks every test below as SKIPPED, not passed, whenever `dist` is missing, so
 * a reporter always shows the true state: skipped (nothing was checked), passed (checked and
 * clean) or failed (checked and found a regression) — never a silent, unearned green. Build the
 * package first (`pnpm --filter @agent-hangar/core build`) to exercise this guard locally.
 *
 * This repository's continuous integration runs the `unit` job (which runs this suite) and the
 * `build` job as separate, independent jobs with no shared file system, so `dist` is absent here
 * in CI too and this suite is always skipped there. The guarantee CI actually enforces is
 * `assertFullyRewritten` in `rewrite-declaration-specifiers.ts`, which runs inside the `build` job
 * itself and fails that job the moment a declaration file is left unrewritten. This suite exists
 * for the local development loop: it catches the same regression the moment `dist` exists on the
 * machine running the tests, without waiting for a separate build job.
 * Mocks: none.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { findRelativeTsSpecifiers } from './declaration-specifiers.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const coreDistDir = join(repoRoot, 'packages', 'core', 'dist');
const distIsBuilt = existsSync(coreDistDir);

/** Recursively lists every `.d.ts` file under `dir`. */
function listDeclarationFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listDeclarationFiles(fullPath));
    } else if (entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe.skipIf(!distIsBuilt)('emitted declarations of @agent-hangar/core', () => {
  /**
   * Every `.d.ts` under `dist` must name files that exist in `dist`. `tsc` itself tolerates a
   * dangling `.ts` specifier by substituting the matching `.d.ts`, so this is not something every
   * type-checker run against this package would visibly fail on today — but a declaration file
   * naming a path that is not there is wrong regardless of which resolvers currently route around
   * it, so the emitted graph is held to the plain, verifiable fact: every specifier names a file
   * that exists.
   */
  it('never points a relative specifier at a .ts sibling', () => {
    const offenders: string[] = [];
    for (const file of listDeclarationFiles(coreDistDir)) {
      const matches = findRelativeTsSpecifiers(readFileSync(file, 'utf8'));
      for (const match of matches) {
        offenders.push(`${relative(repoRoot, file)}: ${match}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
