/**
 * Unit tests for the shared port-base allocator.
 *
 * Layer: unit (no subprocesses; the filesystem is the only thing touched).
 * Goal: a base is never handed to two live claimants, a marker left behind by a run that was
 * killed stops holding its base once it is old enough, a range whose every base is held fails
 * loudly instead of returning a base somebody else owns, and a `mkdir` or `rename` that failed for
 * any other reason is not mistaken for a base being taken.
 * Mocks: none for the claim itself — the markers are real directories under the temporary
 * directory, which is what makes the claim atomic in the first place; `renameSync` is spied on
 * only to inject the one interleaving two independent processes racing each other would produce.
 *
 * The allocator names markers from nothing but the base, so two processes running this same file
 * at once would plant and inspect identical paths and make the suite that proves determinism
 * timing-dependent on itself. `beforeAll`/`afterAll` point `TMPDIR` at a directory `mkdtemp` makes
 * unique to this process for the run of this file only — `os.tmpdir()` re-reads it on every call —
 * so every marker planted here lives in a root no other copy of this suite can reach.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PORT_BASE_STRIDE, fsPort, releasePortBases, reservePortBase } from './port-base.js';

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

/** Prefix the allocator names its markers with; mirrored here to inspect and plant them. */
const CLAIM_PREFIX = 'ah-port-base-';

/** A range this file owns outright, clear of every range a suite allocates from. */
const TEST_FLOOR = 42000;

/** Comfortably past the hour at which the allocator stops believing a marker. */
const ABANDONED_MS = 2 * 60 * 60 * 1000;

/** A range wide enough that two reservations in a row cannot be the same base by luck. */
const WIDE_SPAN = 300;

/** Paths this file created directly, removed after each test. */
const planted: string[] = [];

/**
 * Marker path of one base.
 *
 * @param base - The base.
 * @returns Absolute path of its marker directory.
 */
function markerOf(base: number): string {
  return join(tmpdir(), `${CLAIM_PREFIX}${String(base)}`);
}

/**
 * Creates a marker directly, standing in for another run holding that base.
 *
 * @param base - Base to hold.
 * @param ageMs - How long ago the marker should look created; `0` for just now.
 * @returns The marker path.
 */
function plantMarker(base: number, ageMs = 0): string {
  const marker = markerOf(base);
  mkdirSync(marker, { recursive: true });
  planted.push(marker);
  const when = new Date(Date.now() - ageMs);
  utimesSync(marker, when, when);
  return marker;
}

afterEach(() => {
  releasePortBases();
  for (const marker of planted) {
    rmSync(marker, { recursive: true, force: true });
  }
  planted.length = 0;
  vi.restoreAllMocks();
});

describe('reservePortBase', () => {
  /**
   * Successive reservations name different bases and leave a marker for each, which is what tells
   * every other process on the machine that those bases are spoken for.
   */
  it('claims a distinct base per call and marks each one', () => {
    const first = reservePortBase(TEST_FLOOR, WIDE_SPAN);
    const second = reservePortBase(TEST_FLOOR, WIDE_SPAN);

    expect(second).not.toBe(first);
    expect(existsSync(markerOf(first))).toBe(true);
    expect(existsSync(markerOf(second))).toBe(true);
  });

  /**
   * The whole point of the marker. A pid-seeded counter cannot see another claimant at all:
   * workers spawned back to back get adjacent pids, so their sequences interleave over the same
   * slots with the same stride, and a base one worker had bound was handed to another worker as a
   * base it expected quiet. The range is one base wide so that "stepped past" cannot be mistaken
   * for "handed out anyway".
   */
  it('never hands out a base another run is holding', () => {
    const only = TEST_FLOOR + 3 * PORT_BASE_STRIDE;
    plantMarker(only);

    expect(() => reservePortBase(only, PORT_BASE_STRIDE)).toThrow(/No free port base/u);
  });

  /**
   * A run that was killed never reached its teardown, so its markers outlive it. Held for good
   * they would exhaust the range within a working day, so one old enough that no live run could
   * own it stops counting and the base returns to circulation — inside the same call, which is
   * what the second sweep buys: the first spends this base deleting the marker.
   */
  it('reclaims a base whose marker is old enough to be abandoned', () => {
    const only = TEST_FLOOR + 4 * PORT_BASE_STRIDE;
    const marker = plantMarker(only, ABANDONED_MS);

    expect(reservePortBase(only, PORT_BASE_STRIDE)).toBe(only);
    expect(existsSync(marker)).toBe(true);
  });

  /**
   * A marker whose age still reads as recent belongs to a live run, so the reclaim puts it back
   * exactly as found rather than deleting a claim somebody is using.
   */
  it('restores a marker that turns out not to be abandoned', () => {
    const only = TEST_FLOOR + 21 * PORT_BASE_STRIDE;
    const marker = plantMarker(only);

    expect(() => reservePortBase(only, PORT_BASE_STRIDE)).toThrow(/No free port base/u);
    expect(existsSync(marker)).toBe(true);
  });

  /**
   * A marker that no longer resolves — a dangling link from a half-finished cleanup, or an owner
   * that released it between the failed `mkdir` and the age check — reads as abandoned rather than
   * as an error. Letting it throw would take a whole run down over a base that had just become
   * free.
   */
  it('takes a base whose marker no longer resolves', () => {
    const only = TEST_FLOOR + 12 * PORT_BASE_STRIDE;
    const marker = markerOf(only);
    symlinkSync(join(tmpdir(), `ah-absent-target-${String(process.pid)}`), marker);
    planted.push(marker);

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
    plantMarker(floor);
    plantMarker(floor + PORT_BASE_STRIDE);

    // A plain string, matched as a substring: the expected text carries brackets, and building a
    // pattern from an interpolated string would mean escaping them here for no gain.
    expect(() => reservePortBase(floor, 2 * PORT_BASE_STRIDE)).toThrow(
      `No free port base in [${String(floor)}, ${String(floor + 2 * PORT_BASE_STRIDE)})`,
    );
  });

  /**
   * The reclaim is a rename-then-inspect, not a stat-then-remove, precisely so a second claimant
   * reading the same marker cannot delete a fresh claim the first just made in the gap. Simulated
   * here: the marker standing at the moment of the rename is somebody else's reclaim already in
   * flight, so this attempt's rename loses that race — `ENOENT` — and must fold quietly into "not
   * mine to take" rather than crash or misreport the base as free.
   */
  it('does not treat a marker somebody else already reclaimed as an error', () => {
    const only = TEST_FLOOR + 15 * PORT_BASE_STRIDE;
    const marker = plantMarker(only);
    const raced = new Error('already reclaimed');
    (raced as NodeJS.ErrnoException).code = 'ENOENT';
    vi.spyOn(fsPort, 'renameSync').mockImplementationOnce(() => {
      throw raced;
    });

    expect(() => reservePortBase(only, PORT_BASE_STRIDE)).toThrow(/No free port base/u);
    expect(existsSync(marker)).toBe(true);
  });

  /**
   * Only a race loss (`ENOENT`) is swallowed by the reclaim. Any other reason the rename failed —
   * here a permission error — is a broken machine, not a concurrent claimant, and burying it would
   * hide a real fault behind "somebody else has this base".
   */
  it('propagates a rename failure that is not a race loss', () => {
    const only = TEST_FLOOR + 18 * PORT_BASE_STRIDE;
    plantMarker(only);
    const broken = new Error('permission denied');
    (broken as NodeJS.ErrnoException).code = 'EACCES';
    vi.spyOn(fsPort, 'renameSync').mockImplementationOnce(() => {
      throw broken;
    });

    expect(() => reservePortBase(only, PORT_BASE_STRIDE)).toThrow(/permission denied/u);
  });

  /**
   * A thrown value that is not an `Error` at all cannot be a race loss either, so it travels
   * outward untouched instead of being read as contention.
   */
  it('propagates a non-Error thrown by the claim', () => {
    const only = TEST_FLOOR + 24 * PORT_BASE_STRIDE;
    // Typed `unknown` rather than thrown as a bare literal: a driver that rejects with a plain
    // object is the case being covered, and the classification has to survive it without
    // pretending the value is an `Error`.
    const notAnError: unknown = { code: 'EEXIST', message: 'looks like contention' };
    vi.spyOn(fsPort, 'mkdirSync').mockImplementationOnce(() => {
      throw notAnError;
    });

    expect(() => reservePortBase(only, PORT_BASE_STRIDE)).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );
  });

  /**
   * Only `EEXIST` means "somebody else has this base". Any other reason `mkdir` refused — here a
   * temporary directory that does not exist — is a broken machine, not a contended base, and
   * treating it as contention would walk the whole range before reporting the wrong thing.
   */
  it('propagates a mkdir failure that is not a taken base', () => {
    const previous = process.env.TMPDIR ?? '';
    // `os.tmpdir()` re-reads this on every call, so pointing it at a directory that does not exist
    // is enough to make the claim fail for a reason that is not contention.
    process.env.TMPDIR = join(tmpdir(), `ah-absent-${String(process.pid)}`);
    try {
      expect(() => reservePortBase(TEST_FLOOR + 9 * PORT_BASE_STRIDE, PORT_BASE_STRIDE)).toThrow(
        /ENOENT/u,
      );
    } finally {
      process.env.TMPDIR = previous;
    }
  });
});
