/**
 * ESLint configuration of the agent runtime: the monorepo configuration plus one narrowed rule.
 *
 * Layer: config.
 *
 * ESLint resolves the configuration from the linted file upwards, so this file replaces the root
 * one for this package; it spreads the root configuration first so every project-wide rule and
 * ban still applies unchanged.
 */
import { defineConfig } from 'eslint/config';

import rootConfig from '../../eslint.config.js';

/**
 * Modules whose whole purpose is to act on a path the model chose.
 *
 * `security/detect-non-literal-fs-filename` flags exactly that, and it is right to: an
 * unconstrained path here would be arbitrary read and write on the container filesystem. The
 * answer is confinement, not silence — every one of these modules routes its path through
 * `resolveInsideWorkspace`, which resolves the deepest existing ancestor and rejects `..`
 * segments, absolute paths outside the root and symlinks that leave it, with unit tests for each
 * escape. Relaxing the rule by configuration keeps that reasoning in one reviewable place; a
 * per-line comment would be a suppression, which this project bans outright.
 */
const WORKSPACE_FILESYSTEM_FILES = [
  'src/child-env.ts',
  'src/prepare.ts',
  'src/testing/**/*.ts',
  'src/tools/**/*.ts',
];

export default defineConfig([
  ...rootConfig,
  {
    files: WORKSPACE_FILESYSTEM_FILES,
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },
]);
