/**
 * Page object for the settings screen: the two credential fields, their masks and the environment
 * summary.
 *
 * Layer: test support (Playwright).
 *
 * A stored credential renders as a mask; the input only exists while the value is unset or being
 * replaced. `<input type="password">` exposes no ARIA role, so the input is reached through its
 * field container rather than by role.
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { COPY, SECRET_LABELS, secretFieldId, secretMaskId } from '../support/selectors';
import type { SecretKey } from '../support/selectors';

/** The settings screen. */
export class SettingsPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** Opens the settings screen. */
  async goto(): Promise<void> {
    await this.page.goto('/settings');
    await expect(this.field('GITHUB_PAT')).toBeVisible();
  }

  /** Container of one credential field. */
  field(key: SecretKey): Locator {
    return this.page.getByTestId(secretFieldId(key));
  }

  /** Mask of one stored credential. */
  mask(key: SecretKey): Locator {
    return this.page.getByTestId(secretMaskId(key));
  }

  /** Input of one credential field, present only while unset or replacing. */
  input(key: SecretKey): Locator {
    return this.field(key).locator('input');
  }

  /** Save button of one credential field. */
  saveButton(key: SecretKey): Locator {
    return this.field(key).getByRole('button', { name: COPY.saveSecret, exact: true });
  }

  /** Replace button of one stored credential. */
  replaceButton(key: SecretKey): Locator {
    return this.field(key).getByRole('button', { name: COPY.replaceSecret, exact: true });
  }

  /** Remove button of one stored credential. */
  removeButton(key: SecretKey): Locator {
    return this.field(key).getByRole('button', { name: COPY.removeSecret, exact: true });
  }

  /**
   * Types a value into a field and saves it.
   *
   * @param key - Which credential.
   * @param value - Value to store; always a canary.
   */
  async save(key: SecretKey, value: string): Promise<void> {
    await this.input(key).fill(value);
    await this.saveButton(key).click();
    await expect(this.mask(key)).toBeVisible();
  }

  /** Rendered mask text of a stored credential. */
  async maskText(key: SecretKey): Promise<string> {
    return (await this.mask(key).innerText()).trim();
  }

  /**
   * Replaces a stored credential with a new value.
   *
   * @param key - Which credential.
   * @param value - Replacement value.
   */
  async replace(key: SecretKey, value: string): Promise<void> {
    await this.replaceButton(key).click();
    await expect(this.input(key)).toBeVisible();
    await this.save(key, value);
  }

  /**
   * Removes a stored credential and confirms the dialog.
   *
   * @param key - Which credential.
   */
  async remove(key: SecretKey): Promise<void> {
    await this.removeButton(key).click();
    const dialog = this.page
      .getByRole('alertdialog')
      .filter({ hasText: `Remove ${SECRET_LABELS[key]}?` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: COPY.removeSecret, exact: true }).click();
    await this.expectNotSet(key);
  }

  /** Asserts a credential is not stored: the input is shown and no mask is. */
  async expectNotSet(key: SecretKey): Promise<void> {
    await expect(this.mask(key)).toHaveCount(0);
    await expect(this.input(key)).toBeVisible();
  }

  /** The model line, which names the configured model and where it comes from. */
  modelLine(): Locator {
    return this.page.getByText(/^Model .+ \(from OPENAI_MODEL\)$/);
  }

  /** The environment summary list. */
  envSummary(): Locator {
    return this.page.getByRole('list').filter({ hasText: 'Postgres' }).first();
  }
}
