/**
 * Page object for the application shell: navigation, chat list and the archived group.
 *
 * Layer: test support (Playwright).
 *
 * Everything here is reached by role and accessible name. The shell exposes no test ids for its
 * navigation, and it does not need any: every control carries a visible or `aria-label` name.
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { TEST_IDS } from '../support/selectors';

/** The shell as the specs drive it. */
export class SidebarPage {
  readonly page: Page;
  /** Sidebar column, rendered from the large breakpoint upwards. */
  readonly root: Locator;
  /** Primary navigation landmark. */
  readonly nav: Locator;
  /** Link to the new-chat screen. */
  readonly newChat: Locator;
  /** Link to the scheduled-jobs screen. */
  readonly scheduled: Locator;
  /** Link to the settings screen. */
  readonly settings: Locator;
  /** Button opening the chat search palette. */
  readonly search: Locator;
  /** List of active chats. */
  readonly chatList: Locator;
  /** Disclosure holding the archived chats. */
  readonly archivedToggle: Locator;
  /** List of archived chats, visible once the disclosure is open. */
  readonly archivedList: Locator;
  /** Environment pill; its accessible name summarises the health checks. */
  readonly envPill: Locator;
  /** Theme cycle button; its accessible name names the current theme. */
  readonly themeToggle: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId(TEST_IDS.sidebar);
    this.nav = this.root.getByRole('navigation', { name: 'Primary' });
    this.newChat = this.nav.getByRole('link', { name: 'New chat' });
    this.scheduled = this.nav.getByRole('link', { name: 'Scheduled' });
    this.settings = this.nav.getByRole('link', { name: 'Settings' });
    this.search = this.root.getByRole('button', { name: /^Search chats/ });
    this.chatList = this.root.getByRole('list', { name: 'Chats', exact: true });
    this.archivedToggle = this.root.getByRole('button', { name: /^Archived/ });
    this.archivedList = this.root.getByRole('list', { name: 'Archived chats', exact: true });
    this.envPill = this.root.getByRole('button', { name: /^Environment status:/ });
    this.themeToggle = this.root.getByRole('button', { name: /^Theme:/ });
  }

  /** Opens the new-chat screen directly. */
  async goto(): Promise<void> {
    await this.page.goto('/chats/new');
    await expect(this.page.getByTestId(TEST_IDS.mockBooting)).toHaveCount(0);
  }

  /** Navigates to the new-chat screen through the sidebar. */
  async openNewChat(): Promise<void> {
    await this.newChat.click();
    await expect(this.page).toHaveURL(/\/chats\/new$/);
  }

  /** Navigates to the scheduled-jobs screen. */
  async openScheduled(): Promise<void> {
    await this.scheduled.click();
    await expect(this.page).toHaveURL(/\/scheduled$/);
  }

  /** Navigates to the settings screen. */
  async openSettings(): Promise<void> {
    await this.settings.click();
    await expect(this.page).toHaveURL(/\/settings$/);
  }

  /**
   * Active chat row with the given title.
   *
   * The accessible name of a row is its title followed by a status word when the chat has one, so
   * the match is deliberately a substring rather than the whole name.
   */
  chatItem(title: string): Locator {
    return this.chatList.getByRole('link', { name: title });
  }

  /** Archived chat row with the given title. */
  archivedItem(title: string): Locator {
    return this.archivedList.getByRole('link', { name: title });
  }

  /** Expands the archived group and waits for its list. */
  async openArchived(): Promise<void> {
    if (await this.archivedList.isVisible()) {
      return;
    }
    await this.archivedToggle.click();
    await expect(this.archivedList).toBeVisible();
  }

  /** Text of the environment pill's accessible name. */
  async envPillText(): Promise<string> {
    return (await this.envPill.getAttribute('aria-label')) ?? '';
  }
}
