/**
 * Unit tests pinning the constants that leave this process.
 *
 * Layer: unit.
 * Goal: the paths inside the workspace image, the failure codes persisted on a run and the
 * sentences shown to the user are contract rather than implementation — each is read by something
 * this file cannot import, so each is written out here as a literal.
 * Mocks: none.
 *
 * A test that compares a constant against itself proves nothing, so nothing here imports the
 * wording twice: the expected text is typed out, and an edit to either side is a failure. The
 * agreement these pins protect is real and lives elsewhere — the runtime CLI and the askpass
 * helper are installed at these paths by the workspace image, the codes are matched by the web
 * app when it renders a failed run, and the sentences are what the user is left with. The
 * end-to-end suite is what proves the two sides still meet; this is what catches the edit that
 * would break them before it gets that far.
 */
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_ORIGIN_PATH,
  EXEC_GRACE_MS,
  JOB_DISABLED_MESSAGE,
  JOB_MISSING_MESSAGE,
  RUNTIME_CMD,
  SECRETS_MISSING_MESSAGE,
  SECRETS_MISSING_REASON,
  STALLED_RECOVERY_NOTE,
  STALLED_RECOVERY_REASON,
  STALLED_RUN_MESSAGE,
  STALLED_RUN_REASON,
  WORKSPACE_RECLAIMED_CODE,
  WORKSPACE_RECLAIMED_MESSAGE,
} from './constants.js';

describe('what the workspace image is asked for', () => {
  /**
   * The command is what the runner executes inside the container. Its three words are decided by
   * the image — `node` is on the path, the bundle is installed at that path by the runtime's own
   * Dockerfile lines, and `turn` is the subcommand the CLI parses — so an edit here is an edit to
   * an agreement with a file this package cannot see.
   */
  it('runs the runtime CLI with the turn subcommand', () => {
    expect(RUNTIME_CMD).toStrictEqual(['node', '/opt/agent-runtime/cli.js', 'turn']);
  });

  /**
   * The origin file sits in the root-owned directory beside the askpass helper: the workspace user
   * may read it and can neither rewrite nor unlink it. Both readers live inside the container, so
   * the path is spelled on each side of the boundary and this is the side that can be checked
   * without a daemon.
   */
  it('names the allowed-origin file in the root-owned directory', () => {
    expect(ALLOWED_ORIGIN_PATH).toBe('/opt/agent-runtime/allowed-origin');
  });

  /**
   * The grace is added to the turn's own wall-clock limit, and the runner's timeout is only a
   * backstop for a runtime that failed to enforce its own. A grace measured in fractions of a
   * millisecond is the same as none: the backstop would fire first and every long turn would be
   * reported as a transport timeout instead of finishing.
   */
  it('gives the runtime a full minute past its own deadline', () => {
    expect(EXEC_GRACE_MS).toBe(60_000);
  });
});

describe('what a failed run tells the user', () => {
  /**
   * The reason is written to `Workspace.failureReason` and the message is the sentence the user
   * reads. Neither is derived from the other, and only the message says what to do about it.
   */
  it('explains a missing credential', () => {
    expect(SECRETS_MISSING_REASON).toBe('secrets missing');
    expect(SECRETS_MISSING_MESSAGE).toBe(
      'Configure the GitHub PAT and the OpenAI API key in Settings, then try again.',
    );
  });

  /**
   * The two recovery reasons name different events — a turn found still held by a predecessor, and
   * the container a run's dead worker left behind — and they are read together in the workspace
   * history, so one wording standing in for the other would hide which of the two happened.
   */
  it('tells the two stalled recoveries apart', () => {
    expect(STALLED_RECOVERY_REASON).toBe('stalled turn recovery');
    expect(STALLED_RUN_REASON).toBe('stalled run recovery');
    expect(STALLED_RECOVERY_REASON).not.toBe(STALLED_RUN_REASON);
  });

  /**
   * The model is told its filesystem is gone as a SYSTEM message, because the alternative is a
   * turn that carries on referring to files it wrote in a workspace that no longer exists.
   */
  it('tells the model its previous workspace is gone', () => {
    expect(STALLED_RECOVERY_NOTE).toBe(
      'Previous workspace was lost while a turn was running; a fresh workspace was created.',
    );
  });

  /**
   * A run whose worker died and a run whose workspace was taken before it started are different
   * things to be told: one lost work in progress, the other lost nothing and will be retried by
   * the next tick. The code is what the web app matches on; the sentence is what it shows.
   */
  it('tells a lost worker apart from a reclaimed workspace', () => {
    expect(STALLED_RUN_MESSAGE).toBe(
      'The worker stopped while this run was executing; its workspace has been reclaimed.',
    );
    expect(WORKSPACE_RECLAIMED_CODE).toBe('workspace_reclaimed');
    expect(WORKSPACE_RECLAIMED_MESSAGE).toBe(
      'This run lost its workspace before it could start; the next tick creates a fresh one.',
    );
  });

  /**
   * A manual run can outlive the job it names in two ways, and the user is owed the difference:
   * one job is gone for good, the other is one switch away from running.
   */
  it('tells a deleted job apart from a disabled one', () => {
    expect(JOB_MISSING_MESSAGE).toBe('This scheduled job no longer exists.');
    expect(JOB_DISABLED_MESSAGE).toBe(
      'This scheduled job is disabled; enable it and run it again.',
    );
  });
});
