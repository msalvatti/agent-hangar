/**
 * Unit tests for `infra/scripts/workspace-image.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Docker and no real bundle build).
 * Goal: the digest is what the tree produces and nothing else; an image is `current` only when it
 * carries that digest, `stale` when it carries another or none, `missing` when it is not there and
 * `unavailable` when the question could not be asked at all; and a tag that is not the instance's
 * own is refused with the command that fixes it.
 * Mocks: `docker` and `node` via `infra/scripts/testing/shims.ts`; the expected digest is derived
 * a second time in TypeScript by `testing/workspace-digest.ts` rather than taken from the script.
 */
import { describe, expect, it } from 'vitest';

import { createShimDir, spawnScript, writeExtraShim } from './testing/shims.js';
import { expectedWorkspaceDigest, SHIM_BUNDLE_DIGEST } from './testing/workspace-digest.js';

const scriptPath = new URL('./workspace-image.sh', import.meta.url).pathname;

/** Tag of the instance every test here works with. */
const TAG = 'agent-hangar/workspace:feat-x';

/** A digest that is not this tree's, standing in for an image built from other sources. */
const FOREIGN_DIGEST = 'c'.repeat(64);

/**
 * Runs the script with shims that report a chosen bundle digest and image label.
 *
 * @param args - Arguments after the script name.
 * @param options - Docker behaviour and the two digests the shims report.
 * @returns The process outcome.
 */
function run(
  args: string[],
  options: {
    image?: 'present' | 'missing';
    availability?: 'up' | 'down';
    imageDigest?: string;
    bundleDigest?: string;
    nodeFails?: boolean;
  } = {},
) {
  const log = `${process.env.TMPDIR ?? '/tmp'}/ah-wsi-${String(process.hrtime.bigint())}.log`;
  const shimDir = createShimDir({
    log,
    docker: {
      image: options.image ?? 'present',
      availability: options.availability ?? 'up',
    },
  });
  if (options.nodeFails === true) {
    writeExtraShim(shimDir, 'node', 'printf \'%s\\n\' "no bundle here" >&2\nexit 1');
  }
  return spawnScript(scriptPath, {
    shimDir,
    args,
    env: {
      AH_SHIM_LOG: log,
      AH_SHIM_BUNDLE_DIGEST: options.bundleDigest ?? SHIM_BUNDLE_DIGEST,
      ...(options.imageDigest === undefined ? {} : { AH_SHIM_IMAGE_DIGEST: options.imageDigest }),
    },
  });
}

describe('workspace-image.sh --digest', () => {
  /**
   * The digest is a pure function of what the image carries — the runtime bundle's own bytes plus
   * the two files of the build context that are not generated. Asserted against a second
   * derivation written in TypeScript, so the script is measured against something other than
   * itself: taking the expected value from the script would prove only that it agrees with itself,
   * which is the shape of the defect it exists to prevent.
   */
  it('prints the digest this tree produces', () => {
    const result = run(['--digest']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expectedWorkspaceDigest());
  });

  /**
   * A different bundle is a different image. This is the whole mechanism: a change in the runtime
   * has to move the digest, or an image built before it would still read as current.
   */
  it('changes when the bundle changes', () => {
    const other = run(['--digest'], { bundleDigest: 'd'.repeat(64) });
    expect(other.stdout.trim()).toBe(expectedWorkspaceDigest('d'.repeat(64)));
    expect(other.stdout.trim()).not.toBe(expectedWorkspaceDigest());
  });
});

describe('workspace-image.sh --status', () => {
  /** An image carrying the tree's digest is the one case where a run may proceed. */
  it('reports current when the image carries this tree', () => {
    const result = run(['--status', TAG], { imageDigest: expectedWorkspaceDigest() });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('current');
  });

  /** An image built from other sources: present, usable, and running code that is in no tree. */
  it('reports stale when the image carries another digest', () => {
    expect(run(['--status', TAG], { imageDigest: FOREIGN_DIGEST }).stdout.trim()).toBe('stale');
  });

  /**
   * An image built before the label existed carries none, and reads as stale rather than as
   * verified. Failing closed is the point: an unlabelled image cannot be shown to match anything,
   * and every image on a machine that predates this check is in exactly that state.
   */
  it('reports stale when the image carries no digest at all', () => {
    expect(run(['--status', TAG]).stdout.trim()).toBe('stale');
  });

  /** No image is not this check's problem: the worker, the health endpoint and the doctor say so. */
  it('reports missing when there is no such image', () => {
    expect(run(['--status', TAG], { image: 'missing' }).stdout.trim()).toBe('missing');
  });

  /**
   * Docker unreachable means the question was never asked, and saying so is the difference between
   * a check and a check-shaped no-op. A developer working on the interface has no Docker up and no
   * reason to; what must not happen is that state being reported as a verified image.
   */
  it('reports unavailable, with a reason, when Docker is unreachable', () => {
    const result = run(['--status', TAG], { image: 'missing', availability: 'down' });
    expect(result.stdout.trim()).toBe('unavailable');
    expect(result.stderr).toContain('Docker is not reachable');
  });

  /** Same rule for the other half: no digest from this tree, no verdict about the image. */
  it('reports unavailable when the bundle cannot be built from this tree', () => {
    const result = run(['--status', TAG], {
      imageDigest: expectedWorkspaceDigest(),
      nodeFails: true,
    });
    expect(result.stdout.trim()).toBe('unavailable');
    expect(result.stderr).toContain('could not be built from this tree');
  });
});

describe('workspace-image.sh --image-digest', () => {
  /** What the image says about itself, read from the label the build stamped. */
  it('prints the digest an image carries', () => {
    const result = run(['--image-digest', TAG], { imageDigest: FOREIGN_DIGEST });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(FOREIGN_DIGEST);
  });
});

describe('workspace-image.sh --assert-tag', () => {
  /** The instance's own tag is the only one a command acting on that instance may use. */
  it('accepts the tag the instance derives', () => {
    expect(run(['--assert-tag', TAG, 'feat-x']).status).toBe(0);
  });

  /**
   * The migration case: an `.env.local` written before the tag carried the instance still records
   * the machine-global one, and honouring it silently would leave the collision in place — one
   * checkout's `pnpm infra:image` deciding what another's next container runs. The refusal names
   * both ways out, and spells the remedy `pnpm run setup --force`, because pnpm consumes `--force`
   * itself when the `run` is left off.
   */
  it('refuses a tag another instance also resolves', () => {
    const result = run(['--assert-tag', 'agent-hangar/workspace:dev', 'feat-x']);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('agent-hangar/workspace:feat-x');
    expect(result.stderr).toContain('pnpm run setup --force');
  });
});

describe('workspace-image.sh usage', () => {
  /** An unknown or incomplete invocation exits 2 with a usage line rather than doing something. */
  it.each([[[]], [['--nope']], [['--status']], [['--image-digest']], [['--assert-tag', TAG]]])(
    'rejects %j with a usage line',
    (args) => {
      const result = run([...args]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('usage');
    },
  );
});
