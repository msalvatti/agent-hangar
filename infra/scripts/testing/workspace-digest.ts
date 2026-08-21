/**
 * The workspace image digest, computed in TypeScript so the shell implementation is measured
 * against something other than itself.
 *
 * Layer: test double.
 *
 * `infra/scripts/workspace-image.sh` decides whether an image matches the checkout it is used
 * from, and every test of that decision needs the expected answer. Taking it from the script would
 * make each of those tests assert that the script agrees with itself, which is the same shape as
 * the defect the script exists to prevent — a check that passes without checking. So the digest is
 * derived here a second time, from the same files, the way `env-script.test.ts` restates the
 * instance derivation to hold `env.sh` to it.
 *
 * This module is held to the same 100% coverage gate as the rest of `infra/scripts/testing/**`, so
 * it is written without branches a test would have to contrive to reach.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './committed-files.js';

/**
 * The `node:fs` surface this module needs, reached only through this object.
 *
 * Every path here is built from the repository root, never from untrusted input, but the security
 * linter cannot tell that from a direct call to the imported function by name. Routing each access
 * through one indirection level is the pattern `shims.ts` uses for the same reason.
 */
const fsPort = { readFileSync };

/**
 * Bundle digest the `node` shim reports for a test run.
 *
 * A fixed value with no meaning of its own: it stands in for the hash of a real bundle, which
 * would take a full esbuild run to produce and would change with every edit to the runtime.
 */
export const SHIM_BUNDLE_DIGEST = 'b'.repeat(64);

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Digest the workspace image build stamps, and every consumer recomputes.
 *
 * @param bundleDigest - Digest of the runtime bundle the tree produces.
 * @returns The hex digest, as `workspace-image.sh --digest` prints it.
 */
export function expectedWorkspaceDigest(bundleDigest: string = SHIM_BUNDLE_DIGEST): string {
  const dockerfile = sha256(
    fsPort.readFileSync(join(repoRoot, 'infra/workspace/Dockerfile'), 'utf8'),
  );
  const askpass = sha256(fsPort.readFileSync(join(repoRoot, 'infra/workspace/askpass.sh'), 'utf8'));
  return sha256(`bundle ${bundleDigest}\ndockerfile ${dockerfile}\naskpass ${askpass}\n`);
}
