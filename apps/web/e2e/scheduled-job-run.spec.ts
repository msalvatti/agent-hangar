/**
 * A scheduled job created from the interface runs on demand in a fresh workspace.
 *
 * Layer: end-to-end spec.
 *
 * Covers the scheduling flow: the cron field validates as you type, a saved job appears with its
 * schedule and its next run, a manual trigger produces a run that succeeds, and the workspace the
 * run used is gone afterwards — a job workspace is disposable by design.
 */
import { listRunsResponse, runDetail } from '@agent-hangar/core';

import { test, expect } from './fixtures';
import { JobDetailPage, ScheduledPage } from './pages';
import { chatTarget } from './support/chat-flows';
import {
  API_SETTLE_TIMEOUT_MS,
  JOB_RUN_TIMEOUT_MS,
  PROMPTS,
  WORKSPACE_GONE_TIMEOUT_MS,
} from './support/constants';
import { listWorkspaceContainers } from './support/docker';
import { skipUnlessReal } from './support/mode';
import { COPY } from './support/selectors';

/** Name of the job this spec creates; distinctive so it cannot collide with a seeded one. */
const JOB_NAME = 'E2E print date';

/** Cron expression that makes the job eligible every minute. */
const EVERY_MINUTE = '* * * * *';

/** Cron expression the parser must reject: 61 is not a minute. */
const INVALID_CRON = '61 * * * *';

/** Status word a succeeded run renders in the runs table. */
const SUCCEEDED_LABEL = 'ok';

/**
 * Proves the create dialog rejects an impossible cron in place and previews a valid one; that the
 * saved job appears in the table; that Run now produces a succeeded run whose output and
 * `run_shell` tool call are persisted and rendered in the drawer; and that deleting the job
 * removes its row.
 */
test('a scheduled job runs on demand and reports its output', async ({
  page,
  api,
  env,
  mode,
  seedSettings,
}) => {
  await seedSettings();
  const scheduled = new ScheduledPage(page);
  const detail = new JobDetailPage(page);
  const target = chatTarget(mode);

  await scheduled.goto();
  await scheduled.openNewJob();
  await expect(scheduled.cronPreview()).toHaveText(COPY.cronEmptyPreview);
  await scheduled.dialog.getByLabel('Cron', { exact: true }).fill(INVALID_CRON);
  await expect(scheduled.dialog.getByText(/Invalid cron expression/)).toBeVisible();

  await scheduled.fillJob({
    name: JOB_NAME,
    cron: EVERY_MINUTE,
    repo: target.repo,
    branch: target.branch,
    prompt: PROMPTS.printDate,
  });
  await expect(scheduled.cronPreview()).toHaveText(/^Runs /);
  await scheduled.saveJob();

  const row = scheduled.row(JOB_NAME);
  await expect(row).toBeVisible();
  await expect(row).toContainText(EVERY_MINUTE);

  // Triggering a run and opening the job are user-interface steps the mock API implements, so they
  // run in both modes; only whether the run succeeds, and what it recorded, needs the worker.
  await scheduled.runNow(JOB_NAME);
  await scheduled.openJob(JOB_NAME);
  const jobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  await expect(detail.runsTable).toBeVisible();
  await expect(detail.runRows).not.toHaveCount(0);

  skipUnlessReal(test, mode, 'only the worker executes a scheduled run in a workspace');

  await detail.waitForRunStatus(SUCCEEDED_LABEL, JOB_RUN_TIMEOUT_MS);

  await detail.openRun(0);
  await expect(detail.drawerToolRows.filter({ hasText: 'run_shell' })).toHaveCount(1);
  expect(await detail.rawOutputText()).toContain('printed above');

  const { runs } = await api.get(`/api/jobs/${jobId}/runs`, listRunsResponse);
  // Manual, not merely succeeded: the job is eligible every minute, so the schedule can produce a
  // succeeded run of its own — which would satisfy a status-only assertion even if Run now were
  // broken. At least one rather than exactly one, because that scheduled run may also be here.
  const succeeded = runs.filter((run) => run.status === 'SUCCEEDED' && run.trigger === 'MANUAL');
  expect(succeeded.length).toBeGreaterThanOrEqual(1);
  const first = succeeded[0];
  if (first === undefined) {
    throw new Error('no succeeded run to inspect');
  }
  const run = await api.get(`/api/runs/${first.id}`, runDetail);
  expect(run.output).not.toBeNull();
  expect(run.toolCalls.map((call) => call.toolName)).toEqual(['run_shell']);

  // A job workspace is disposable by design, which is the half of that promise a status cannot
  // show: the run reaches a terminal status before the processor's teardown destroys the
  // container, so this polls rather than reads once. Without it a regression that leaves every job
  // container running still passes the whole spec.
  await expect
    .poll(async () => (await listWorkspaceContainers(env.workspaceNamePrefix)).length, {
      timeout: WORKSPACE_GONE_TIMEOUT_MS,
      message: 'the run workspace was still there after the run finished',
    })
    .toBe(0);

  await page.goto('/scheduled');
  await scheduled.deleteJob(JOB_NAME);
  await expect(scheduled.row(JOB_NAME)).toHaveCount(0, { timeout: API_SETTLE_TIMEOUT_MS });
});
