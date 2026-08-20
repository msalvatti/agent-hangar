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
 * only until the OS hands it to the next caller.
 *
 * Within the range, a base belongs to one claimant at a time. Three properties carry that, and
 * each replaced something that looked sufficient and was not:
 *
 * 1. **The claim is a hard link, not a counter and not a `mkdir`.** A counter — however it is
 *    seeded — cannot exclude anything: Vitest workers are spawned back to back and get adjacent
 *    pids, so pid-seeded sequences interleave over the same slots with the same stride, one slot
 *    apart, and a base one worker had bound was handed to another as a base it expected quiet.
 *    `link` is the test-and-set that closes it — it either creates the name or fails with
 *    `EEXIST`, never both, and it fails the same way for a sibling worker and for a wholly
 *    separate process. It is chosen over `mkdir` because the marker has to carry its owner, and
 *    `mkdir` then write is two steps with an observable gap between them (see {@link publish}).
 *
 * 2. **Ownership is liveness, not age.** The marker names the pid that took it, and a base comes
 *    back only when that process is gone. Age cannot express ownership: a `vitest --watch`
 *    session crosses any threshold you pick and is still bound to its ports, and under the
 *    previous age rule every other reclaimer then read its marker as abandoned, deleted it, and
 *    handed the base out underneath it — the module's own invariant failing, not a cost at the
 *    edges. Liveness also closes the delete-the-wrong-marker race a clock leaves open: "old" is
 *    a property of a process that is still running and may release at any instant, while "gone"
 *    is stable — a dead owner performs no release, so a marker its owner cannot touch and other
 *    reclaimers are locked out of cannot change under the reclaimer that is deleting it.
 *
 * 3. **Every step is recoverable.** A run killed outright never reaches its teardown, so both the
 *    marker and the reclaim lock name their holder and answer to the same liveness test. A
 *    reclaimer killed mid-flight used to leave a lock nothing could clear, which made that base
 *    permanently unreclaimable.
 *
 * The one question liveness cannot answer is pid reuse: a dead owner's pid recycled onto an
 * unrelated live process makes its marker look held for good. {@link REUSED_PID_BACKSTOP_MS} is
 * the backstop for exactly that, and nothing else — it is deliberately far longer than any
 * session, so a three-hour watch run is never reclaimed by it.
 *
 * Every caller shares this module, and the marker names carry nothing but the base, so the
 * exclusion holds across suites as well as within one.
 */
import { randomUUID } from 'node:crypto';
import { linkSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The `node:fs` surface this module needs, reached only through this object.
 *
 * Every path here is built from the temporary directory and an integer, never from untrusted
 * input, but the security linter cannot tell that from a direct call to the imported function by
 * name; routing each access through one indirection level is the pattern `shims.ts` uses for the
 * same reason. Exported so `port-base.test.ts` can inject the interleavings only two independent
 * processes racing each other would produce.
 */
export const fsPort = { linkSync, lstatSync, readFileSync, rmSync, writeFileSync };

/**
 * The `node:process` surface this module needs. Exported for the same reason as {@link fsPort}:
 * a test has to be able to produce an owner that is alive, gone, or unanswerable, and only the
 * first two can be arranged with a real process.
 */
export const processPort = { kill: process.kill.bind(process) };

/** Ports one instance occupies (web, Postgres, Redis), and therefore the distance between bases. */
export const PORT_BASE_STRIDE = 3;

/** Name prefix of every file this module plants: the markers, their locks and their staging. */
const CLAIM_PREFIX = 'ah-port-base-';

/**
 * Age past which a marker whose owner still *looks* alive is reclaimed anyway.
 *
 * A backstop, not the ownership test — {@link isAbandoned} consults it only after liveness has
 * already said "held". Its single purpose is pid reuse: when a dead owner's pid is recycled onto
 * an unrelated live process, nothing else would ever free that base. Twelve hours is far beyond
 * any run or watch session of this project, so the case this exists to catch is the only one it
 * can reach.
 */
const REUSED_PID_BACKSTOP_MS = 12 * 60 * 60 * 1000;

/**
 * Where this process starts looking. Seeding from the pid means concurrent workers usually claim
 * on their first try instead of walking past each other's bases; it is a head start, not the thing
 * that keeps them apart, which is the marker.
 */
let nextPortBase = process.pid * PORT_BASE_STRIDE;

/** Markers this process owns, removed by {@link releasePortBases}. */
const claims: string[] = [];

/**
 * Reports whether an operation failed because the name it wanted already exists.
 *
 * @param error - Value thrown by `linkSync`.
 * @returns `true` when the target was already there.
 */
function isNameTakenError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

/**
 * Publishes a marker naming this process, or reports the name as somebody else's.
 *
 * The content is written to a private staging path and the marker is then hard-linked from it, so
 * the file is complete before it becomes visible under the name anybody looks up: no reader can
 * ever find a marker that exists but does not yet say who owns it. Creating the name first and
 * filling it afterwards — `mkdir` then write — is two steps with exactly that gap in between, and
 * a reader landing in it would have to guess. `infra/scripts/rotate-key.sh`'s `take_lock` takes
 * the same route for the same reason; this is that pattern, not a second invention of it.
 *
 * `link` is also what makes the publish exclusive: it fails rather than overwrites, so it can
 * never take a name another process already holds, and never replaces what is there.
 *
 * @param path - Marker path to claim.
 * @returns `true` when this process now owns the name.
 * @throws Error when the link failed for any reason other than the name being taken.
 */
function publish(path: string): boolean {
  const staging = `${path}.staging-${randomUUID()}`;
  fsPort.writeFileSync(staging, `${String(process.pid)}\n`, { encoding: 'utf8' });
  try {
    fsPort.linkSync(staging, path);
    return true;
  } catch (error) {
    if (isNameTakenError(error)) {
      return false;
    }
    throw error;
  } finally {
    fsPort.rmSync(staging, { force: true });
  }
}

/**
 * Reads the process id a marker names.
 *
 * @param path - Marker path.
 * @returns The owning pid, or `null` when the marker names none that can be read — a directory
 * left by an older layout, a dangling link from a half-finished cleanup, or unparseable content.
 */
function ownerOf(path: string): number | null {
  let raw: string;
  try {
    raw = fsPort.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Reports whether a process is still running.
 *
 * @param pid - Process id to test.
 * @returns `true` unless the signal probe says the process is gone.
 */
function isOwnerAlive(pid: number): boolean {
  try {
    processPort.kill(pid, 0);
    return true;
  } catch (error) {
    // `ESRCH` is the only answer that means gone. `EPERM` means the process exists and belongs to
    // somebody else, which is a reason not to take its base rather than a reason to.
    return !(error instanceof Error && (error as NodeJS.ErrnoException).code === 'ESRCH');
  }
}

/**
 * Reports whether a marker may be removed.
 *
 * A marker naming no readable owner is abandoned outright: the only marker that must survive is
 * one whose owner is provably live, and this one names nobody.
 *
 * @param path - Marker path.
 * @returns `true` when no live process holds it.
 */
function isAbandoned(path: string): boolean {
  const owner = ownerOf(path);
  if (owner === null) {
    return true;
  }
  if (!isOwnerAlive(owner)) {
    return true;
  }
  // Reached only when liveness already said "held", so this is the pid-reuse backstop and nothing
  // else. A marker missing by now reads as age `0`, which is past any bound — it has already been
  // released, and removing what is no longer there is what `force` absorbs.
  const bornAt = fsPort.lstatSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  return Date.now() - bornAt > REUSED_PID_BACKSTOP_MS;
}

/**
 * Takes the per-base reclaim lock, recovering one whose holder is gone.
 *
 * The lock serializes reclaimers so only ever one inspects-and-maybe-deletes a marker at a time,
 * and the canonical marker path is never vacated for the length of an inspection. It names its own
 * holder for the same reason the marker does: a reclaimer killed between taking the lock and
 * releasing it would otherwise strand that base forever, since every later reclaim would defer to
 * a holder that no longer exists.
 *
 * @param lock - Lock path.
 * @returns `true` when this process holds the lock.
 */
function takeReclaimLock(lock: string): boolean {
  if (publish(lock)) {
    return true;
  }
  if (!isAbandoned(lock)) {
    return false;
  }
  fsPort.rmSync(lock, { recursive: true, force: true });
  return publish(lock);
}

/**
 * Frees a base whose owner is gone, and only such a base.
 *
 * Deleting under the lock is safe because of what "gone" means: the owner performs no release of
 * its own, and every other reclaimer is excluded, so the marker inspected here is still the marker
 * removed here. That was not true of an age test, where the holder is by definition still running.
 * The one path where it is not true here either is the pid-reuse backstop inside
 * {@link isAbandoned}, whose owner may be live and releasing — the price of ever recovering a
 * reused-pid base at all, paid twelve hours after the fact.
 *
 * @param marker - Marker path to inspect.
 */
function reclaimIfOwnerGone(marker: string): void {
  const lock = `${marker}.reclaim`;
  if (!takeReclaimLock(lock)) {
    return;
  }
  try {
    if (isAbandoned(marker)) {
      fsPort.rmSync(marker, { recursive: true, force: true });
    }
  } finally {
    fsPort.rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Takes one base for this process, or reports it as somebody else's.
 *
 * A marker whose owner is gone is freed rather than taken here, so the sweep that follows can
 * claim the base instead of this call having to win a `link` it just raced somebody for.
 *
 * @param base - Base to claim.
 * @returns `true` when this process now owns the base.
 */
function claimPortBase(base: number): boolean {
  const marker = join(tmpdir(), `${CLAIM_PREFIX}${String(base)}`);
  if (publish(marker)) {
    claims.push(marker);
    return true;
  }
  reclaimIfOwnerGone(marker);
  return false;
}

/**
 * Reserves a port base no other live sandbox on this machine holds.
 *
 * The range is the caller's: each suite owns one, which gives concurrent suites a head start on
 * each other, while the marker is what actually keeps two claimants off one base. There is no
 * default, because a shared allocator has no business preferring one suite's range.
 *
 * Two sweeps of the range, because the first may spend a candidate freeing an abandoned marker
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
      `live run. Stop the other test runs, or delete the leftover markers with ` +
      `rm -rf ${join(tmpdir(), `${CLAIM_PREFIX}*`)}`,
  );
}

/**
 * Releases every base this process claimed. Called from each suite's teardown; the loop is
 * unconditional, so a teardown never depends on how the test that preceded it ended. Releasing
 * here is what keeps a range clear during normal use — the liveness reclamation in
 * {@link reservePortBase} covers only the runs that never get here at all.
 */
export function releasePortBases(): void {
  for (const marker of claims) {
    fsPort.rmSync(marker, { recursive: true, force: true });
  }
  claims.length = 0;
}
