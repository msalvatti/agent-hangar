/**
 * Unit tests for the port-base allocator of `infra/scripts/testing/rotate-key-sandbox.ts`.
 *
 * Layer: unit (no subprocesses; the filesystem is the only thing touched).
 * Goal: a base is never handed to two live claimants, a marker left behind by a run that was
 * killed stops holding its base once it is old enough, a range whose every base is held fails
 * loudly instead of returning a base somebody else owns, and a `mkdir` that failed for any other
 * reason is not mistaken for a base being taken.
 * Mocks: none — the markers are real directories under the OS temporary directory, which is what
 * makes the claim atomic in the first place.
 *
 * The rest of the module is covered through the two rotation suites that use it; only the
 * allocator has branches of its own, and they are driven from here so no rotation test has to
 * contrive one. Every range used here sits above the one `sandbox()` hands out, so a run of this
 * file cannot take a base a rotation test is waiting for.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { releaseSandboxes, reservePortBase } from './rotate-key-sandbox.js';

/** Prefix the allocator names its markers with; mirrored here to inspect and plant them. */
const CLAIM_PREFIX = 'ah-port-base-';

/** Ports one base occupies, and therefore the distance between two of them. */
const STRIDE = 3;

/**
 * A range this file owns outright, well clear of the one `sandbox()` allocates from, so two suites
 * running at once cannot take each other's bases.
 */
const TEST_FLOOR = 40000;

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
  return join(tmpdir(), `${CLAIM_PREFIX}${base}`);
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
  releaseSandboxes();
  for (const marker of planted) {
    rmSync(marker, { recursive: true, force: true });
  }
  planted.length = 0;
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
   * The whole point of the marker: a base another run is holding is stepped past rather than
   * handed out a second time. A pid-seeded counter could not see the other run at all, and a base
   * one worker had bound to play a running instance was given to another worker as a base it
   * expected quiet — the rotation there refused to start and exited 1.
   *
   * The range is one base wide so that "stepped past" cannot look like "handed out anyway".
   */
  it('never hands out a base another run is holding', () => {
    const only = TEST_FLOOR + 3 * STRIDE;
    plantMarker(only);

    expect(() => reservePortBase(only, STRIDE)).toThrow(/No free port base/u);
  });

  /**
   * A run that was killed never reached its teardown, so its markers outlive it. Held for good
   * they would exhaust the range within a working day, so one old enough that no live run could
   * own it stops counting and the base returns to circulation — inside the same call, which is
   * what the second sweep of the range buys: the first spends this base deleting the marker.
   */
  it('reclaims a base whose marker is old enough to be abandoned', () => {
    const only = TEST_FLOOR + 4 * STRIDE;
    const marker = plantMarker(only, ABANDONED_MS);

    expect(reservePortBase(only, STRIDE)).toBe(only);
    expect(existsSync(marker)).toBe(true);
  });

  /**
   * A marker that no longer resolves — a dangling link from a half-finished cleanup, or an owner
   * that released it in the instant between the failed `mkdir` and the age check — reads as
   * abandoned rather than as an error. Letting it throw would take a whole run down over a base
   * that had just become free.
   */
  it('takes a base whose marker no longer resolves', () => {
    const only = TEST_FLOOR + 12 * STRIDE;
    const marker = markerOf(only);
    symlinkSync(join(tmpdir(), `ah-absent-target-${String(process.pid)}`), marker);
    planted.push(marker);

    expect(reservePortBase(only, STRIDE)).toBe(only);
  });

  /**
   * Exhaustion is reported, never worked around. Returning a base held by a live run would put two
   * rotations on one port, which is the failure this allocator exists to prevent, so the range
   * filling up has to be visible — and the message names the markers, so leftovers can be told
   * apart from runs that are genuinely still going.
   */
  it('refuses when every base in the range is held', () => {
    const floor = TEST_FLOOR + 6 * STRIDE;
    plantMarker(floor);
    plantMarker(floor + STRIDE);

    expect(() => reservePortBase(floor, 2 * STRIDE)).toThrow(
      new RegExp(`No free port base in \\[${floor}, ${floor + 2 * STRIDE}\\)`, 'u'),
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
      expect(() => reservePortBase(TEST_FLOOR + 9 * STRIDE, STRIDE)).toThrow(/ENOENT/u);
    } finally {
      process.env.TMPDIR = previous;
    }
  });
});
