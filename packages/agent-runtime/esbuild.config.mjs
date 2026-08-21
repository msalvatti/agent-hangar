/**
 * Bundles the agent runtime into a single ESM file for the workspace image.
 *
 * Layer: build.
 *
 * The image carries `dist/cli.js` and the `dist/package.json` written beside it — no
 * `node_modules`, and nothing but that one manifest — so no import may stay external. The options
 * that decide all of it live in `esbuild.options.mjs`, which `scripts/bundle-digest.mjs` reads
 * too. `scripts/check-bundle.mjs` proves the result really is self-contained.
 */
import { chmod, writeFile } from 'node:fs/promises';

import { build } from 'esbuild';

import { BUNDLE_DIR, BUNDLE_FILENAME, BUNDLE_MANIFEST, bundleOptions } from './esbuild.options.mjs';

await build({ ...bundleOptions, logLevel: 'info' });

await chmod(new URL(BUNDLE_FILENAME, BUNDLE_DIR), 0o755);
await writeFile(new URL('package.json', BUNDLE_DIR), BUNDLE_MANIFEST, 'utf8');
