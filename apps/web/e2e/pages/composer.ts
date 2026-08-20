/**
 * Page object for the composer: repository and branch pickers, the prompt box and Send.
 *
 * Layer: test support (Playwright).
 *
 * The pickers mount their dialog unconditionally, so every assertion is about visibility rather
 * than presence. Their search field is a combobox, not a textbox: it drives the option list
 * beneath it.
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { COPY } from '../support/selectors';

/** The composer, on both the new-chat screen and the chat screen. */
export class ComposerPage {
  readonly page: Page;
  /** Trigger of the repository picker; its name is the selection or the placeholder. */
  readonly repoTrigger: Locator;
  /** Trigger of the branch picker. */
  readonly branchTrigger: Locator;
  /** Prompt box; its accessible name comes from the visually hidden label. */
  readonly textarea: Locator;
  /** Send button. */
  readonly send: Locator;
  /** Notice shown while a credential is missing. */
  readonly secretsMissingNotice: Locator;
  /** Link from that notice to the settings screen. */
  readonly secretsMissingLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.repoTrigger = page.getByRole('button', { name: COPY.chooseRepository });
    this.branchTrigger = page.getByRole('button', { name: COPY.chooseBranch });
    this.textarea = page.getByRole('textbox', { name: COPY.promptLabel });
    this.send = page.getByRole('button', { name: COPY.send, exact: true });
    this.secretsMissingNotice = page.getByRole('status').filter({ hasText: COPY.secretsMissing });
    this.secretsMissingLink = this.secretsMissingNotice.getByRole('link', {
      name: COPY.openSettings,
    });
  }

  /** Trigger of the repository picker once a repository is selected. */
  selectedRepoTrigger(fullName: string): Locator {
    return this.page.getByRole('button', { name: fullName, exact: true });
  }

  /**
   * Opens the repository picker, filters to `fullName` and selects it.
   *
   * @param fullName - `owner/name` as the picker lists it.
   */
  async chooseRepo(fullName: string): Promise<void> {
    await this.repoTrigger.click();
    const search = this.page.getByRole('combobox', { name: 'Search repositories' });
    await expect(search).toBeVisible();
    await search.fill(fullName);
    await this.page.getByRole('option', { name: fullName }).click();
    await expect(this.selectedRepoTrigger(fullName)).toBeVisible();
  }

  /**
   * Opens the branch picker and selects a branch.
   *
   * @param name - Branch name as the picker lists it.
   */
  async chooseBranch(name: string): Promise<void> {
    const trigger = this.page
      .getByRole('button', { name: COPY.chooseBranch, exact: true })
      .or(this.page.getByRole('button', { name, exact: true }))
      .first();
    await trigger.click();
    const search = this.page.getByRole('combobox', { name: 'Search branches' });
    await expect(search).toBeVisible();
    await search.fill(name);
    await this.page.getByRole('option', { name, exact: true }).click();
    await expect(this.page.getByRole('button', { name, exact: true }).first()).toBeVisible();
  }

  /** Types a prompt, replacing whatever is there. */
  async type(prompt: string): Promise<void> {
    await this.textarea.fill(prompt);
    await expect(this.textarea).toHaveValue(prompt);
  }

  /** Clicks Send and waits for the button to accept the click. */
  async submit(): Promise<void> {
    await expect(this.send).toBeEnabled();
    await this.send.click();
  }

  /** Asserts the credentials notice is shown and points at the settings screen. */
  async expectBlockedBySecrets(): Promise<void> {
    await expect(this.secretsMissingNotice).toBeVisible();
    await expect(this.secretsMissingLink).toHaveAttribute('href', '/settings');
    await expect(this.textarea).toHaveCount(0);
  }

  /** Asserts Send refuses the current state. */
  async expectSendDisabled(): Promise<void> {
    await expect(this.send).toBeDisabled();
  }
}
