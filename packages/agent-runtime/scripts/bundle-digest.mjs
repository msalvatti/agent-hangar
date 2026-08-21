/**
 * Prints the SHA-256 digest of the agent runtime bundle this tree produces.
 *
 * Layer: build.
 *
 * The workspace image carries this digest as a label, and every command that is about to use the
 * image recomputes it from the tree it was started from and compares. That is the whole mechanism
 * by which an image can be known to match its checkout, so what it hashes matters:
 *
 *   * the bundle's own bytes, not a commit id or a timestamp. A rebuild that consumed stale
 *     generated output would stamp the current `HEAD` onto bytes that predate it, and uncommitted
 *     source shares a commit id with the code it differs from — either way the check would accept
 *     the very image it exists to reject, while reporting it verified;
 *   * bytes that are produced here and now, from the source, rather than read from `dist`. `dist`
 *     is generated output like any other, and hashing it would only prove the image matches the
 *     last build, not that the last build matches the tree.
 *
 * Nothing is written: the bundle is built in memory, which costs a fifth of a second and cannot
 * disturb a `dist` a build or a dev server is using.
 */
import { createHash } from 'node:crypto';

import { build } from 'esbuild';

import { BUNDLE_FILENAME, bundleOptions } from '../esbuild.options.mjs';

const result = await build({ ...bundleOptions, write: false, logLevel: 'silent' });
const bundle = result.outputFiles.find((file) => file.path.endsWith(`/${BUNDLE_FILENAME}`));
if (bundle === undefined) {
  console.error(`bundle-digest: esbuild produced no ${BUNDLE_FILENAME}`);
  process.exit(1);
}

process.stdout.write(`${createHash('sha256').update(bundle.contents).digest('hex')}\n`);
