/**
 * Page objects for the scheduled-jobs list, the job dialog and the job detail screen with its run
 * drawer.
 *
 * Layer: test support (Playwright).
 *
 * Rows carry no job or run id, so they are located by the accessible name of the control inside
 * them — the job's link, the run's "Open run from …" button — which is what a person clicks.
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { COPY, TEST_IDS } from '../support/selectors';

/** Fields of the job dialog. */
export interface JobFormValues {
  name: string;
  cron: string;
  repo: string;
  branch: string;
  prompt: string;
  timezone?: string;
}

/** The scheduled-jobs list screen. */
export class ScheduledPage {
  readonly page: Page;
  /** Table of jobs; its accessible name comes from a visually hidden caption. */
  readonly table: Locator;
  /** Button opening the create dialog. */
  readonly newJob: Locator;
  /** The create/edit dialog. */
  readonly dialog: Locator;
  /** Skeleton shown while the list loads. */
  readonly skeleton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.table = page.getByRole('table', { name: COPY.jobsTableCaption });
    this.newJob = page.getByRole('button', { name: COPY.newJob }).first();
    this.dialog = page.getByRole('dialog');
    this.skeleton = page.getByTestId(TEST_IDS.jobsSkeleton);
  }

  /** Opens the scheduled-jobs screen. */
  async goto(): Promise<void> {
    await this.page.goto('/scheduled');
    await expect(this.newJob).toBeVisible();
  }

  /** Row of one job, located by the link that carries its name. */
  row(name: string): Locator {
    return this.table.getByRole('row').filter({ has: this.page.getByRole('link', { name }) });
  }

  /** Enabled switch of one job. */
  enabledSwitch(name: string): Locator {
    return this.page.getByRole('switch', { name: `Enable ${name}` });
  }

  /** Overflow trigger of one job's row. */
  rowMenu(name: string): Locator {
    return this.page.getByRole('button', { name: `Actions for ${name}` });
  }

  /** Opens the create dialog. */
  async openNewJob(): Promise<void> {
    await this.newJob.click();
    await expect(this.dialog).toBeVisible();
  }

  /**
   * The cron preview of the open dialog: a polite live region that is debounced, so assertions
   * against it must poll rather than read once.
   */
  cronPreview(): Locator {
    return this.dialog.locator('[aria-live="polite"]').first();
  }

  /** Fills every field of the open dialog without saving. */
  async fillJob(values: JobFormValues): Promise<void> {
    await this.dialog.getByLabel('Name', { exact: true }).fill(values.name);
    await this.dialog
      .getByRole('group', { name: 'Repository' })
      .getByRole('button')
      .first()
      .click();
    const repoSearch = this.page.getByRole('combobox', { name: 'Search repositories' });
    await expect(repoSearch).toBeVisible();
    await repoSearch.fill(values.repo);
    await this.page.getByRole('option', { name: values.repo }).click();
    await this.dialog.getByRole('group', { name: 'Branch' }).getByRole('button').first().click();
    const branchSearch = this.page.getByRole('combobox', { name: 'Search branches' });
    await expect(branchSearch).toBeVisible();
    await branchSearch.fill(values.branch);
    await this.page.getByRole('option', { name: values.branch, exact: true }).click();
    await this.dialog.getByLabel('Cron', { exact: true }).fill(values.cron);
    if (values.timezone !== undefined) {
      await this.dialog.getByRole('button', { name: 'Timezone' }).click();
      const zoneSearch = this.page.getByPlaceholder('Search timezones…');
      await zoneSearch.fill(values.timezone);
      await this.page.getByRole('option', { name: values.timezone, exact: true }).click();
    }
    await this.dialog.getByLabel('Prompt', { exact: true }).fill(values.prompt);
  }

  /** Saves the open dialog and waits for it to close. */
  async saveJob(): Promise<void> {
    await this.dialog.getByRole('button', { name: COPY.saveJob, exact: true }).click();
    await expect(this.dialog).toHaveCount(0);
  }

  /** Triggers a run from a row's overflow menu. */
  async runNow(name: string): Promise<void> {
    await this.rowMenu(name).click();
    await this.page.getByRole('menuitem', { name: COPY.runNow }).click();
  }

  /** Deletes a job from its row menu and confirms. */
  async deleteJob(name: string): Promise<void> {
    await this.rowMenu(name).click();
    await this.page.getByRole('menuitem', { name: COPY.deleteJob, exact: true }).click();
    const dialog = this.page.getByRole('alertdialog').filter({ hasText: `Delete job ${name}?` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: COPY.deleteJob, exact: true }).click();
    // The confirmation closing is waited for first, and it is what carries the meaning. The
    // dialog is modal, so while it stands the rest of the page is marked `aria-hidden` and no
    // role locator reaches into it: measured live, the table counts zero elements and `row(name)`
    // counts zero rows for as long as the dialog is open. Asserting the row straight after the
    // click is therefore a check that cannot fail, and it cannot fail in exactly the case the
    // screen keeps the dialog open to report — a delete that was refused. The screen closes the
    // dialog only once `DELETE /api/jobs/:id` has answered, so waiting for it also means the
    // request is over rather than still in flight when the test ends.
    await expect(dialog).toHaveCount(0);
    await expect(this.row(name)).toHaveCount(0);
  }

  /** Opens the detail screen of one job. */
  async openJob(name: string): Promise<void> {
    await this.table.getByRole('link', { name }).click();
    await expect(this.page).toHaveURL(/\/scheduled\/[^/]+$/);
  }
}

/** The job detail screen with its runs table and run drawer. */
export class JobDetailPage {
  readonly page: Page;
  /** Runs table; its accessible name comes from a visually hidden caption. */
  readonly runsTable: Locator;
  /** Standalone Run now button of the header. */
  readonly runNow: Locator;
  /** The run drawer. */
  readonly drawer: Locator;

  constructor(page: Page) {
    this.page = page;
    this.runsTable = page.getByRole('table', { name: COPY.runsTableCaption });
    this.runNow = page.getByRole('button', { name: COPY.runNow }).first();
    this.drawer = page.getByRole('dialog');
  }

  /** Every run row of the table. */
  get runRows(): Locator {
    return this.runsTable.getByRole('row').filter({ has: this.page.getByRole('button') });
  }

  /** Opens the drawer for one run row, by index. */
  async openRun(index: number): Promise<void> {
    await this.runRows.nth(index).getByRole('button').first().click();
    await expect(this.drawer).toBeVisible();
  }

  /**
   * Waits for at least one run row to show a status label.
   *
   * @param label - Status word rendered by the run status cell (`ok`, `fail`, `running`, …).
   * @param timeoutMs - Budget.
   */
  async waitForRunStatus(label: string, timeoutMs: number): Promise<void> {
    await expect(this.runsTable.getByText(label, { exact: true }).first()).toBeVisible({
      timeout: timeoutMs,
    });
  }

  /** Tool rows of the drawer's transcript. */
  get drawerToolRows(): Locator {
    return this.drawer.getByTestId(TEST_IDS.transcript).locator('[data-item-kind="tool"]');
  }

  /** Raw output text of the open drawer. */
  async rawOutputText(): Promise<string> {
    await this.drawer.getByRole('tab', { name: 'Raw output' }).click();
    return (await this.drawer.locator('pre').first().innerText()).trim();
  }
}
