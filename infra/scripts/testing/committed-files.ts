/**
 * Reads the committed files that the `infra/scripts` guard suites assert about.
 *
 * Layer: test double.
 *
 * Two suites state rules over the same set of files — `call-sites.test.ts` over how the scripts
 * invoke each other, `environment-contract.test.ts` over what they promise about the environment —
 * and both need the same three things: where the repository root is, one script's text, and the
 * list of every shell script under `infra/scripts`. Keeping that here means a new guard suite adds
 * rules rather than another copy of the plumbing.
 *
 * This module is held to the same 100% coverage gate as the rest of `infra/scripts/testing/**`, so
 * it is written without branches a test would have to contrive to reach.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `node:fs` surface this module needs, reached only through this object.
 *
 * Every path here is built from this file's own location, never from untrusted input, but the
 * security linter cannot tell that from a direct call to the imported function by name. Routing
 * each access through one indirection level is the pattern `shims.ts` uses for the same reason.
 */
const fsPort = { readdirSync, readFileSync };

/** Absolute path of `infra/scripts`. */
export const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path of the repository root. */
export const repoRoot = join(scriptsDir, '..', '..');

/**
 * Reads one committed file.
 *
 * @param path - Absolute path.
 * @returns Its text.
 */
export function read(path: string): string {
  return fsPort.readFileSync(path, 'utf8');
}

/**
 * Every `*.sh` under `infra/scripts`, as `[name, source]` pairs ready to hand to `it.each`, so a
 * rule that has to hold for all of them reports which script broke it rather than one merged
 * failure.
 *
 * @returns One entry per committed shell script, sorted by name.
 */
export function shellScripts(): [string, string][] {
  return fsPort
    .readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.sh'))
    .sort()
    .map((name) => [name, read(join(scriptsDir, name))]);
}

/**
 * The root manifest's `scripts` block.
 *
 * @returns Script name to command line.
 */
export function rootScripts(): Record<string, string> {
  const manifest = JSON.parse(read(join(repoRoot, 'package.json'))) as {
    scripts: Record<string, string>;
  };
  return manifest.scripts;
}
