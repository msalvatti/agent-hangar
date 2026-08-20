/**
 * Unit tests for the shared port-base allocator.
 *
 * Layer: unit (no subprocesses beyond one that is started and reaped to obtain a pid that is
 * certainly gone; the filesystem is the only other thing touched).
 * Goal: a base belongs to the process that took it and comes back only when that process is gone;
 * a marker is never observable without the owner it names; a reclaimer never inspects or deletes a
 * marker another reclaim is deciding about, and cannot strand a base by dying while it holds the
 * lock; a range whose every base is held fails loudly instead of handing out somebody's base; and
 * a failure that is not "the name is taken" is never read as contention.
 * Mocks: none for the claim itself — the markers are real files under the temporary directory,
 * which is what makes the claim atomic in the first place. `linkSync`, `lstatSync` and the signal
 * probe are spied on only to inject states that need two independent processes, a clock twelve
 * hours ahead, or a permission the runner does not have.
 *
 * The allocator names markers from nothing but the base, so two processes running this same file
 * at once would plant and inspect identical paths and make the suite that proves determinism
 * timing-dependent on itself. `beforeAll`/`afterAll` point `TMPDIR` at a directory `mkdtemp` makes
 * unique to this process for the run of this file only — `os.tmpdir()` re-reads it on every call —
 * so every marker planted here lives in a root no other copy of this suite can reach.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PORT_BASE_STRIDE,
  fsPort,
  processPort,
  releasePortBases,
  reservePortBase,
} from './port-base.js';

/** `TMPDIR` as it was before this file pointed it at a private marker root. */
let previousTmpdir: string | undefined;

/** Private marker root for this process, isolating it from any other copy of this suite. */
let privateRoot: string;

beforeAll(() => {
  previousTmpdir = process.env.TMPDIR;
  privateRoot = mkdtempSync(join(tmpdir(), 'ah-port-base-test-'));
  process.env.TMPDIR = privateRoot;
});

afterAll(() => {
  if (previousTmpdir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmpdir;
  }
  rmSync(privateRoot, { recursive: true, force: true });
});

/** Prefix the allocator names its markers with; mirrored here to plant and inspect them. */
const CLAIM_PREFIX = 'ah-port-base-';

/** A range this file owns outright, clear of every range a suite allocates from. */
const TEST_FLOOR = 42000;

/** Comfortably past the twelve-hour backstop. */
const BEYOND_BACKSTOP_MS = 13 * 60 * 60 * 1000;

/** A range wide enough that two reservations in a row cannot be the same base by luck. */
const WIDE_SPAN = 300;

/** Paths this file created directly, removed after each test. */
const planted: string[] = [];

/**
 * Marker path of one base.
 *
 * @param base - The base.
 * @returns Absolute path of its marker.
 */
function markerOf(base: number): string {
  return join(tmpdir(), `${CLAIM_PREFIX}${String(base)}`);
}

/**
 * Returns a process id that is certainly not running: a trivial child is started and reaped, and
 * its id reported once it has exited.
 *
 * @returns The dead process id.
 */
function deadPid(): number {
  return spawnSync('bash', ['-c', 'exit 0']).pid;
}

/**
 * Plants a marker naming an owner, standing in for another run holding that path.
 *
 * @param path - Path to plant.
 * @param content - What the marker should say; a pid, or anything a reader cannot parse.
 * @param ageMs - How long ago the marker should look created; `0` for just now.
 * @returns The planted path.
 */
function plant(path: string, content: string, ageMs = 0): string {
  writeFileSync(path, `${content}\n`, { encoding: 'utf8' });
  planted.push(path);
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
  return path;
}

afterEach(() => {
  releasePortBases();
  for (const path of planted) {
    rmSync(path, { recursive: true, force: true });
  }
  planted.length = 0;
  vi.restoreAllMocks();
});

describe('reservePortBase', () => {
  /**
   * Successive reservations name different bases, and each marker says who owns it — the fact
   * every other rule here is built on. A marker that existed without naming an owner would leave
   * every reader guessing, which is why the claim is a link from an already-written file rather
   * than a name created first and filled afterwards.
   */
  it('claims a distinct base per call and records the owning pid in each marker', () => {
    const first = reservePortBase(TEST_FLOOR, WIDE_SPAN);
    const second = reservePortBase(TEST_FLOOR, WIDE_SPAN);

    expect(second).not.toBe(first);
    for (const base of [first, second]) {
      expect(readFileSync(markerOf(base), 'utf8').trim()).toBe(String(process.pid));
    }
  });

  /**
   * The whole point of the marker. A pid-seeded counter cannot see another claimant at all:
   * workers spawned back to back get adjacent pids, so their sequences interleave over the same
   * slots with the same stride, and a base one worker had bound was handed to another worker as a
   * base it expected quiet. The range is one base wide so that "stepped past" cannot be mistaken
   * for "handed out anyway".
   */
  it('never hands out a base a live owner is holding', () => {
    const only = TEST_FLOOR + 3 * PORT_BASE_STRIDE;
    const marker = plant(markerOf(only), String(process.pid));

    expect(() => reservePortBase(only, PORT_BASE_STRIDE)).toThrow(/No free port base/u);
    expect(existsSync(marker)).toBe(true);
  });

  /**
   * A long-lived owner keeps its base however long it holds it. Under the age rule this replaced,
   * a `vitest --watch` session crossed the threshold and every other reclaimer then deleted its
   * marker and handed the base out underneath it, while it was still bound to those ports.
   */
  it('leaves a live owner alone however old its marker is', () => {
    const only = TEST_FLOOR + 27 * PORT_BASE_STRIDE;
    const marker = plant(markerOf(only), String(process.pid), BEYOND_BACKSTOP_MS / 2);

    expect(() => reservePortBase(only, PORT_BASE_STRIDE)).toThrow(/No free port base/u);
    expect(existsSync(marker)).toBe(true);
  });

  /**
   * A run that was killed never reached its teardown, so its marker outlives it — but its pid does
   * not, and that is what the base comes back on. Freed inside the same call, which is what the
   * second sweep buys: the first spends this base removing the marker.
   */
  it('reclaims a base whose owner is gone', () => {
    const only = TEST_FLOOR + 4 * PORT_BASE_STRIDE;
    plant(markerOf(only), String(deadPid()));

    expect(reservePortBase(only, PORT_BASE_STRIDE)).toBe(only);
    expect(readFileSync(markerOf(only), 'utf8').trim()).toBe(String(process.pid));
  });

  /**
   * A marker that names no owner a reader can recover — a dangling link from a half-finished
   * cleanup, or a directory left by an older layout — is abandoned outright. The only marker that
   * must survive is one whose owner is provably live, and this one names nobody.
   */
  it('takes a base whose marker names no readable owner', () => {
    const only = TEST_FLOOR + 12 * PORT_BASE_STRIDE;
    const marker = markerOf(only);
    symlinkSync(join(tmpdir(), `ah-absent-target-${String(process.pid)}`), marker);
    planted.push(marker);

    expect(reservePortBase(only, PORT_BASE_STRIDE)).toBe(only);
  });

  /**
   * Content that is not a process id names nobody either, so it holds nothing.
   */
  it('takes a base whose marker holds unparseable content', () => {
    const only = TEST_FLOOR + 30 * PORT_BASE_STRIDE;
    plant(markerOf(only), 'not-a-pid');

    expect(reservePortBase(only, PORT_BASE_STRIDE)).toBe(only);
  });

  /**
   * Exhaustion is reported, never worked around. Returning a base held by a live run would put two
   * sandboxes on one port, which is the failure this allocator exists to prevent, so the range
   * filling up has to be visible — and the message names the markers, so leftovers can be told
   * apart from runs that are genuinely still going.
   */
  it('refuses when every base in the range is held', () => {
    const floor = TEST_FLOOR + 6 * PORT_BASE_STRIDE;
    plant(markerOf(floor), String(process.pid));
    plant(markerOf(floor + PORT_BASE_STRIDE), String(process.pid));

    // A plain string, matched as a substring: the expected text carries brackets, and building a
    // pattern from an interpolated string would mean escaping them here for no gain.
    expect(() => reservePortBase(floor, 2 * PORT_BASE_STRIDE)).toThrow(
      `No free port base in [${String(floor)}, ${String(floor + 2 * PORT_BASE_STRIDE)})`,
    );
  });

  /**
   * The reclaim is serialized by a sibling lock so only one process ever inspects-and-maybe-deletes
   * a marker at a time, and the canonical path is never vacated for the length of an inspection —
   * which an earlier rename-then-inspect version did, and why it introduced a worse race than the
   * one it closed. A live holder of that lock is deferred to rather than raced.
   */
  it('leaves a marker alone while a live reclaimer holds its lock', () => {
    const only = TEST_FLOOR + 15 * PORT_BASE_STRIDE;
    const marker = plant(markerOf(only), String(deadPid()));
    plant(`${marker}.reclaim`, String(process.pid));

    expect(() => reservePortBase(only, PORT_BASE_STRIDE)).toThrow(/No free port base/u);
    expect(existsSync(marker)).toBe(true);
  });

  /**
   * The lock answers to the same liveness rule as the marker, because it has the same failure
   * mode: a reclaimer killed between taking it and releasing it used to leave a lock nothing could
   * clear, and every later reclaim deferred to a holder that no longer existed — that base was
   * then unreclaimable for good.
   */
  it('recovers a reclaim lock whose holder is gone', () => {
    const only = TEST_FLOOR + 33 * PORT_BASE_STRIDE;
    const marker = plant(markerOf(only), String(deadPid()));
    plant(`${marker}.reclaim`, String(deadPid()));

    expect(reservePortBase(only, PORT_BASE_STRIDE)).toBe(only);
    expect(existsSync(`${marker}.reclaim`)).toBe(false);
  });

  /**
   * Recovering an abandoned lock is itself a race, and losing it is not an error: another
   * reclaimer got there first and is now deciding this marker's fate, so this call defers exactly
   * as it would have to a lock that was live all along.
   */
  it('defers when another reclaimer wins the lock it was recovering', () => {
    const only = TEST_FLOOR + 36 * PORT_BASE_STRIDE;
    const marker = plant(markerOf(only), String(deadPid()));
    plant(`${marker}.reclaim`, String(deadPid()));
    const taken = new Error('name taken');
    (taken as NodeJS.ErrnoException).code = 'EEXIST';
    // Only the lock's own publish is intercepted; the marker still has to go through the real
    // link, or the base would be claimed on the first sweep and the deferral never reached.
    vi.spyOn(fsPort, 'linkSync').mockImplementation((staging, path) => {
      if (String(path).endsWith('.reclaim')) {
        throw taken;
      }
      linkSync(staging, path);
    });

    expect(() => reservePortBase(only, PORT_BASE_STRIDE)).toThrow(/No free port base/u);
    expect(existsSync(marker)).toBe(true);
  });

  /**
   * The backstop, and the only thing it is for: a dead owner's pid recycled onto an unrelated live
   * process makes its marker look held for good, and nothing else would ever free that base. It
   * sits far beyond any session, so the long watch run above is never reached by it.
   */
  it('reclaims a base whose owner looks alive but whose marker outlived any session', () => {
    const only = TEST_FLOOR + 21 * PORT_BASE_STRIDE;
    plant(markerOf(only), String(process.pid), BEYOND_BACKSTOP_MS);

    expect(reservePortBase(only, PORT_BASE_STRIDE)).toBe(only);
  });

  /**
   * A marker whose age cannot be read at all has already been released between the ownership read
   * and this one, so there is nothing left to protect.
   */
  it('takes a base whose marker vanished during the backstop check', () => {
    const only = TEST_FLOOR + 39 * PORT_BASE_STRIDE;
    plant(markerOf(only), String(process.pid));
    vi.spyOn(fsPort, 'lstatSync').mockReturnValue(undefined);

    expect(reservePortBase(only, PORT_BASE_STRIDE)).toBe(only);
  });

  /**
   * `ESRCH` is the only signal answer that means gone. `EPERM` means the process exists and
   * belongs to somebody else, which is a reason not to take its base rather than a reason to.
   */
  it('treats an owner the probe may not signal as still holding its base', () => {
    const only = TEST_FLOOR + 42 * PORT_BASE_STRIDE;
    const marker = plant(markerOf(only), String(deadPid()));
    const forbidden = new Error('operation not permitted');
    (forbidden as NodeJS.ErrnoException).code = 'EPERM';
    vi.spyOn(processPort, 'kill').mockImplementation(() => {
      throw forbidden;
    });

    expect(() => reservePortBase(only, PORT_BASE_STRIDE)).toThrow(/No free port base/u);
    expect(existsSync(marker)).toBe(true);
  });

  /**
   * Only `EEXIST` means "somebody else has this name". Any other reason the link failed — here a
   * permission error — is a broken machine, not a contended base, and treating it as contention
   * would walk the whole range before reporting the wrong thing.
   */
  it('propagates a link failure that is not a taken name', () => {
    const only = TEST_FLOOR + 9 * PORT_BASE_STRIDE;
    const broken = new Error('permission denied');
    (broken as NodeJS.ErrnoException).code = 'EACCES';
    vi.spyOn(fsPort, 'linkSync').mockImplementation(() => {
      throw broken;
    });

    expect(() => reservePortBase(only, PORT_BASE_STRIDE)).toThrow(/permission denied/u);
  });

  /**
   * A thrown value that is not an `Error` cannot be a taken name either, however much it resembles
   * one, so it travels outward untouched instead of being read as contention.
   */
  it('propagates a non-Error thrown by the claim', () => {
    const only = TEST_FLOOR + 24 * PORT_BASE_STRIDE;
    // Typed `unknown` rather than thrown as a bare literal: a platform that rejects with a plain
    // object is the case being covered.
    const notAnError: unknown = { code: 'EEXIST', message: 'looks like contention' };
    vi.spyOn(fsPort, 'linkSync').mockImplementation(() => {
      throw notAnError;
    });

    expect(() => reservePortBase(only, PORT_BASE_STRIDE)).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );
  });
});
