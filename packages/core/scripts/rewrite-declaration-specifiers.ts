/**
 * Emit step: rewrites relative ".ts" specifiers to ".js" across the emitted declaration graph.
 *
 * Layer: tooling (entry point for `tsx`, exposed as this package's `declarations:rewrite` script;
 * never imported by application code).
 *
 * `tsc -b` emits declarations for every `composite` project it builds, so it produces `dist`
 * whether it was invoked to build or merely to type-check. This rewrite therefore belongs to
 * `tsc -b` itself rather than to any one script: every `typecheck` and `build` script in the
 * repository whose `tsc -b` can reach this package runs it immediately afterwards, so no
 * invocation can leave a half-finished `dist` behind.
 *
 * The rewrite itself is the pure transform in `../src/config/declaration-specifiers.ts` — see
 * that module for why the rewrite is needed. This script supplies the file-system side of it:
 * walk `dist`, apply the transform to every `.d.ts` file, and fail loudly if anything is still
 * unrewritten afterwards.
 *
 * Idempotent: a file whose content does not change is left untouched on disk, so running this
 * script twice in a row performs no writes on the second run.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findRelativeTsSpecifiers,
  rewriteDeclarationSpecifiers,
} from '../src/config/declaration-specifiers.js';

/** Directory this script rewrites in place. */
const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url));

/** Recursively lists every regular file under `dir`. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

/**
 * Rewrites every `.d.ts` file under `distDir` in place and returns their paths. A file whose
 * content does not change is not written back, so its on-disk mtime is left alone.
 *
 * @param distDir - Directory to walk; a missing directory yields no files (a fresh worktree has
 *   never been built, so nothing to rewrite is a normal, non-error outcome).
 * @returns The declaration files found, whether or not their content changed.
 */
export function rewriteDeclarationDirectory(distDir: string): string[] {
  if (!existsSync(distDir)) {
    return [];
  }
  const declarationFiles = listFiles(distDir).filter((path) => path.endsWith('.d.ts'));
  for (const file of declarationFiles) {
    const original = readFileSync(file, 'utf8');
    const rewritten = rewriteDeclarationSpecifiers(original);
    if (rewritten !== original) {
      writeFileSync(file, rewritten, 'utf8');
    }
  }
  return declarationFiles;
}

/**
 * Fails the build if any declaration file still names a relative ".ts" specifier after the
 * rewrite. A match here means either the rewrite regressed or TypeScript started emitting a
 * specifier shape this transform does not recognize — both are build-breaking, not warnings.
 *
 * @param declarationFiles - Paths to check, as returned by {@link rewriteDeclarationDirectory}.
 * @throws {Error} If any file still contains a relative ".ts" specifier.
 */
export function assertFullyRewritten(declarationFiles: readonly string[]): void {
  const offenders = declarationFiles
    .map((file) => ({ file, matches: findRelativeTsSpecifiers(readFileSync(file, 'utf8')) }))
    .filter(({ matches }) => matches.length > 0);
  if (offenders.length > 0) {
    const detail = offenders
      .map(({ file, matches }) => `${file} (${matches.join(', ')})`)
      .join('; ');
    throw new Error(
      `relative ".ts" specifiers remain in emitted declarations after rewrite: ${detail}`,
    );
  }
}

/** Runs the rewrite against `dist` and fails the build if anything is left unrewritten. */
export function main(): void {
  const declarationFiles = rewriteDeclarationDirectory(DIST_DIR);
  assertFullyRewritten(declarationFiles);
}

main();
