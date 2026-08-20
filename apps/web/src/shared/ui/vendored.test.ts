/**
 * Tests for the boundary between the vendored shadcn primitives and the ones this project authors.
 *
 * Layer: unit.
 * Goal: the exclusion `vitest.config.ts` builds from {@link VENDORED_UI_PRIMITIVES} stays true —
 * every file behind it is still generator output, and a file wired into this project's own modules
 * cannot hide behind it.
 * Mocks: none; the real files and the real `components.json` are read from disk.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  VENDORED_UI_COVERAGE_EXCLUDE,
  VENDORED_UI_DIRECTORY,
  VENDORED_UI_PRIMITIVES,
} from './vendored';

/**
 * The web package root. Vitest runs each workspace from its own directory, and a wrong root would
 * fail the first read rather than pass vacuously.
 */
const PACKAGE_ROOT = `${process.cwd()}/`;

/**
 * Reads one file of the package.
 *
 * @param relativePath - Path relative to the package root.
 * @returns The file's contents.
 */
async function readPackageFile(relativePath: string): Promise<string> {
  return readFile(`${PACKAGE_ROOT}${relativePath}`, 'utf8');
}

/** The part of `components.json` this suite reads: the two aliases the CLI writes imports to. */
const generatorConfig = z.object({
  aliases: z.object({ utils: z.string(), ui: z.string() }),
});

/**
 * The import aliases the shadcn CLI is configured to write into a generated primitive: the single
 * `utils` module, and anything under the components directory.
 *
 * @returns The exact `utils` specifier and the `ui` directory specifier.
 */
async function generatorAliases(): Promise<{ utils: string; ui: string }> {
  const parsed: unknown = JSON.parse(await readPackageFile('components.json'));
  return generatorConfig.parse(parsed).aliases;
}

/**
 * Every `@/…` specifier a module imports from.
 *
 * @param source - The module's source text.
 * @returns The project-local specifiers, in source order.
 */
function projectImports(source: string): string[] {
  return [...source.matchAll(/(?:from|import) '(@\/[^']+)'/g)].map((match) => match[1] ?? '');
}

describe('vendored ui primitives', () => {
  /**
   * The whole exclusion rests on the claim that these files are what the generator wrote. A digest
   * is what turns that from an assertion into a check: the moment someone edits one of them the
   * claim stops being true, and this is where they are told to move the file under measurement
   * rather than leave product code behind a coverage exclusion.
   */
  it.each(VENDORED_UI_PRIMITIVES)(
    '$file is unchanged since it was generated',
    async ({ file, sha256 }) => {
      const source = await readPackageFile(`${VENDORED_UI_DIRECTORY}/${file}`);
      const digest = createHash('sha256').update(source).digest('hex');

      expect(digest).toBe(sha256);
    },
  );

  /**
   * The second way a primitive stops being vendor code is by being wired into this project at
   * generation time, before any digest existed — which is how `sonner.tsx` came to read the palette
   * from `@/shared/lib/theme`. The CLI only ever reaches for the two aliases `components.json`
   * gives it, so any other project import is this repository's own work and belongs under
   * measurement.
   */
  it.each(VENDORED_UI_PRIMITIVES)(
    '$file imports nothing of this project beyond the generator aliases',
    async ({ file }) => {
      const { utils, ui } = await generatorAliases();
      const source = await readPackageFile(`${VENDORED_UI_DIRECTORY}/${file}`);

      const foreign = projectImports(source).filter(
        (specifier) => specifier !== utils && !specifier.startsWith(`${ui}/`),
      );

      expect(foreign).toEqual([]);
    },
  );

  /**
   * An entry naming a file that no longer exists would silently exclude nothing while reading as
   * though it still covered something, and the digest check above would be the only thing standing
   * between the list and fiction.
   */
  it('names only files that are still in the directory', async () => {
    const present = await readdir(`${PACKAGE_ROOT}${VENDORED_UI_DIRECTORY}`);

    expect(present).toEqual(expect.arrayContaining(VENDORED_UI_PRIMITIVES.map(({ file }) => file)));
  });

  /**
   * `vitest.config.ts` spreads this list straight into `coverage.exclude`, so it is the list that
   * decides what is measured. Pinning its shape here keeps a stray entry — an absolute path, a
   * bare file name — from silently excluding nothing.
   */
  it('exposes the primitives as globs rooted at the components directory', () => {
    expect(VENDORED_UI_COVERAGE_EXCLUDE).toHaveLength(VENDORED_UI_PRIMITIVES.length);
    for (const glob of VENDORED_UI_COVERAGE_EXCLUDE) {
      expect(glob.startsWith(`${VENDORED_UI_DIRECTORY}/`)).toBe(true);
    }
  });
});
