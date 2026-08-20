/**
 * Regression guard over the actually emitted declaration graph of @agent-hangar/core.
 *
 * Layer: integration (reads `packages/core/dist`, so it needs a tree where `tsc -b` has already
 * run — a fresh worktree has never been built).
 * Goal: `declaration-specifiers.test.ts` proves the rewrite transform is correct in isolation;
 * this suite proves the emit actually applied it to what is on disk. A regression here would
 * mean either a script that runs `tsc -b` stopped calling
 * `packages/core/scripts/rewrite-declaration-specifiers.ts`, or a new TypeScript release started
 * emitting a specifier shape the transform does not recognize.
 *
 * `dist` is produced by any `tsc -b` that reaches this package, not only by `build`: the project
 * is `composite`, so type-checking emits as well. `pnpm typecheck`, `pnpm build` and
 * `pnpm --filter @agent-hangar/core build` therefore all leave a `dist` for this suite to scan,
 * and the continuous-integration `unit` job builds this package before running the tests, so the
 * suite executes there rather than reporting a skip that reads like a pass. It runs alongside —
 * not instead of — `assertFullyRewritten` in `rewrite-declaration-specifiers.ts`, which fails the
 * emit itself the moment a declaration file is left unrewritten.
 *
 * The one state that has nothing to check is a worktree where `tsc -b` has never run, and there
 * scanning an absent directory would either report a trivial, meaningless pass or require
 * fabricating content to scan, neither of which tests anything real. `describe.skipIf` marks
 * every test below as SKIPPED, not passed, in that state, so a reporter always shows the true
 * state: skipped (nothing was on disk), passed (checked and clean) or failed (checked and found a
 * regression) — never a silent, unearned green.
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
