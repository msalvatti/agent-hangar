/** @vitest-environment node */
/**
 * Policy test: only one module of the web app may decrypt a stored credential.
 *
 * Layer: unit.
 * Goal: `SecretsService.reveal` returns plaintext, and the spec confines it to the worker. The web
 * app takes one documented exception — the GitHub client, which needs the token to call the REST
 * API — and this test is what keeps that exception from spreading by copy-paste.
 * Mocks: none; the source tree is read from disk.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** The single module allowed to call `reveal`, relative to the web app root. */
const ALLOWED_FILE = join('src', 'server', 'github.ts');

/** Directories of the web app that are scanned. */
const SCANNED_DIRECTORIES = ['src', 'app'];

/** Root of the web app. */
const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Lists every shipped TypeScript file below a directory.
 *
 * Test files are skipped: a test that asserts `revealCalls` is empty legitimately names the
 * method, and the rule is about shipped code.
 *
 * @param directory - Directory to walk, relative to the web app root.
 * @returns Paths relative to the web app root.
 */
function listSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(WEB_ROOT, directory), { withFileTypes: true })) {
    const relative = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listSourceFiles(relative));
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
      found.push(relative);
    }
  }
  return found;
}

describe('reveal policy', () => {
  /**
   * The whole web app is scanned for a `.reveal(` call. Exactly one file may contain one; a
   * second would mean a credential is being decrypted somewhere that was never reviewed for it.
   */
  it('confines reveal to the GitHub client', () => {
    const offenders = SCANNED_DIRECTORIES.flatMap((directory) => listSourceFiles(directory)).filter(
      (file) => readFileSync(join(WEB_ROOT, file), 'utf8').includes('.reveal('),
    );
    expect(offenders).toEqual([ALLOWED_FILE]);
  });
});
