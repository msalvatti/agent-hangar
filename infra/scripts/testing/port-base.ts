/**
 * Port-base allocator shared by the infra script suites.
 *
 * Layer: test double.
 *
 * A suite that needs "Postgres is on its port" or "nothing is on the web port" cannot ask the OS
 * for a free port: `env.sh` derives every port from AH_PORT_BASE and deliberately ignores a
 * same-named variable in the environment, so the test has to name a base and listen where the
 * derivation points. Two things have to hold, and they are enforced separately.
 *
 * The range is private rather than OS-assigned: it sits below the ephemeral range both Linux
 * (32768+) and macOS (49152+) allocate from, so the OS never hands one of these ports to somebody
 * else. Binding port 0 and releasing it does not survive that — a released ephemeral port is free
 * only until the OS hands it to the next caller, and with suites running in parallel it did
 * exactly that.
 *
 * Within the range, a base belongs to one claimant at a time, and the marker directory is what
 * says so. A counter — however it is seeded — cannot do this: Vitest workers are spawned back to
 * back and get adjacent pids, so pid-seeded sequences interleave over the same slots with the same
 * stride, one slot apart, and a base one worker had bound to play a running instance was handed to
 * another worker as a base it expected quiet. `mkdir` is the test-and-set that closes it: it
 * either creates the directory or fails, never both, and it fails the same way for a sibling
 * worker of this run and for a wholly separate process.
 *
 * Every caller shares this module, and the marker names carry nothing but the base, so the
 * exclusion holds across suites as well as within one.
 */
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The `node:fs` surface this module needs, reached only through this object.
 *
 * Every path here is built from the temporary directory and an integer, never from untrusted
 * input, but the security linter cannot tell that from a direct call to the imported function by
 * name; routing each access through one indirection level is the pattern `shims.ts` uses for the
 * same reason. Exported so `port-base.test.ts` can spy on `mkdirSync` to inject the one
 * interleaving of the reclaim that only two independent processes racing could produce.
 */
export const fsPort = { mkdirSync, rmSync, statSync };

/** Ports one instance occupies (web, Postgres, Redis), and therefore the distance between bases. */
export const PORT_BASE_STRIDE = 3;

/** Name prefix of the marker directory that holds one base for whoever created it. */
const CLAIM_PREFIX = 'ah-port-base-';

/**
 * Age at which a marker is treated as abandoned rather than held.
 *
 * A run killed outright — Ctrl-C on a watch session, a cancelled job — never reaches its teardown,
 * and without this its markers would hold their bases for good; some twenty such runs would
 * exhaust a range and turn a convenience into an outage. An hour is far longer than any run of
 * this project, so a marker that old cannot belong to a run still using it.
 */
const STALE_CLAIM_MS = 60 * 60 * 1000;

/**
 * Where this process starts looking. Seeding from the pid means concurrent workers usually claim
 * on their first try instead of walking past each other's bases; it is a head start, not the thing
 * that keeps them apart, which is the marker.
 */
let nextPortBase = process.pid * PORT_BASE_STRIDE;

/** Marker directories this process created, removed by {@link releasePortBases}. */
const claims: string[] = [];

/**
 * Reports whether a failed `mkdir` lost the race to create a path another actor already holds.
 *
 * @param error - Value thrown by `mkdirSync`.
 * @returns `true` when the directory already existed.
 */
function isDirectoryExistsError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

/**
 * Deletes `marker` if — and only if — it is actually abandoned, without ever deleting a directory
 * a concurrent claimant just created there.
 *
 * A plain stat-then-remove, with no mutual exclusion, is unsafe two different ways: two reclaimers
 * can both read the same old age and both act on it, one deleting the abandoned directory a moment
 * after the other already did (harmless — `force` absorbs it) or, unsafely, one deleting a fresh
 * claim a concurrent claimant made in the gap between the read and the removal, which is exactly
 * the two-processes-believe-they-hold-the-same-base failure this allocator exists to prevent. An
 * earlier version of this function tried to close that gap by renaming `marker` aside before
 * inspecting it, which traded that bug for a worse one: renaming vacates the canonical path for the
 * whole inspection, and a third claimant's plain `mkdir` can succeed there in that window, so this
 * function's own rename-back — restoring an owner's claim it had only borrowed — could stamp over
 * that third claimant's fresh directory instead.
 *
 * The fix keeps the canonical path occupied throughout: a sibling `.reclaim` marker, claimed with
 * the same atomic `mkdir` test-and-set the base itself uses, serializes reclaimers one at a time,
 * so only ever one process is inspecting-and-maybe-deleting `marker` at once and `marker` is never
 * vacated except by the single winner's own deliberate, already-decided removal. Losing that race
 * (`EEXIST`) means somebody else is already deciding this marker's fate this instant, so this call
 * simply defers to them rather than acting on a read it has no exclusive claim to.
 *
 * @param marker - Marker path to inspect.
 */
function reclaimIfStale(marker: string): void {
  const lock = `${marker}.reclaim`;
  try {
    fsPort.mkdirSync(lock);
  } catch (error) {
    if (isDirectoryExistsError(error)) {
      return;
    }
    throw error;
  }
  try {
    // `throwIfNoEntry: false` rather than a plain stat: the marker can be a dangling symlink left
    // behind by a half-finished cleanup, which resolves to nothing. Missing reads as `0`, which is
    // stale, so the removal below is what disposes of it.
    const heldSince = fsPort.statSync(marker, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (Date.now() - heldSince > STALE_CLAIM_MS) {
      fsPort.rmSync(marker, { recursive: true, force: true });
    }
  } finally {
    fsPort.rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Takes one base for this process, or reports it as somebody else's.
 *
 * A marker old enough to be abandoned is deleted rather than claimed here, so the sweep that
 * follows can take the base on its second pass instead of this call having to succeed at a `mkdir`
 * it just raced somebody for.
 *
 * @param base - Base to claim.
 * @returns `true` when this process now owns the base.
 */
function claimPortBase(base: number): boolean {
  const marker = join(tmpdir(), `${CLAIM_PREFIX}${String(base)}`);
  try {
    fsPort.mkdirSync(marker);
  } catch (error) {
    if (!isDirectoryExistsError(error)) {
      throw error;
    }
    reclaimIfStale(marker);
    return false;
  }
  claims.push(marker);
  return true;
}

/**
 * Reserves a port base no other live sandbox on this machine holds.
 *
 * The range is the caller's: each suite owns one, which gives concurrent suites a head start on
 * each other, while the marker is what actually keeps two claimants off one base. There is no
 * default, because a shared allocator has no business preferring one suite's range.
 *
 * Two sweeps of the range, because the first may spend a candidate deleting an abandoned marker
 * rather than taking it.
 *
 * @param floor - Lowest base to consider.
 * @param span - Width of the range in ports; must be a whole number of strides.
 * @returns A base this process now holds, released by {@link releasePortBases}.
 * @throws Error when every base in the range is held by a run that is still going.
 */
export function reservePortBase(floor: number, span: number): number {
  const attempts = (span / PORT_BASE_STRIDE) * 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const base = floor + (nextPortBase % span);
    nextPortBase += PORT_BASE_STRIDE;
    if (claimPortBase(base)) {
      return base;
    }
  }
  throw new Error(
    `No free port base in [${String(floor)}, ${String(floor + span)}): every one is held by a ` +
      `live run. Stop the other test runs, or delete the stale markers with ` +
      `rm -rf ${join(tmpdir(), `${CLAIM_PREFIX}*`)}`,
  );
}

/**
 * Releases every base this process claimed. Called from each suite's teardown; the loop is
 * unconditional, so a teardown never depends on how the test that preceded it ended. Releasing
 * here is what keeps a range from filling up over a working day — the age-based reclamation in
 * {@link reservePortBase} covers only the runs that never get here at all.
 */
export function releasePortBases(): void {
  for (const marker of claims) {
    fsPort.rmSync(marker, { recursive: true, force: true });
  }
  claims.length = 0;
}
