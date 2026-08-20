/**
 * Page object for the chat screen: header, status pill, transcript rows and the chat menu.
 *
 * Layer: test support (Playwright).
 *
 * The status pill carries no role, name or attribute of its own; the only stable hook is the
 * polite live region it wraps its text in, which is what the header locator below targets. A
 * `data-testid` on the pill would replace that, and it is on the list of ids requested from the
 * interface lanes.
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { COPY, ITEM_KIND, STATUS_LABEL, TEST_IDS } from '../support/selectors';
import type { StatusPhase } from '../support/selectors';

/** The chat screen. */
export class ChatPage {
  readonly page: Page;
  /** Header bar holding the title, the pill and the actions. */
  readonly header: Locator;
  /** Chat title; a heading whether or not it is editable. */
  readonly title: Locator;
  /** Live region carrying the status text. */
  readonly statusPill: Locator;
  /** Stop button, present only while a turn can still be stopped. */
  readonly stop: Locator;
  /** Overflow menu of the chat. */
  readonly menu: Locator;
  /** Transcript region. */
  readonly transcript: Locator;
  /** Banner shown while the chat is archived. */
  readonly archivedBanner: Locator;
  /** Restore button of that banner. */
  readonly archivedBannerRestore: Locator;
  /** Error card of a failed turn. */
  readonly errorCard: Locator;
  /** Blinking cursor shown while text streams. */
  readonly streamCursor: Locator;

  constructor(page: Page) {
    this.page = page;
    this.header = page.getByTestId(TEST_IDS.header);
    this.title = page.getByRole('heading', { level: 1 });
    this.statusPill = this.header.locator('[aria-live="polite"]').first();
    this.stop = this.header.getByRole('button', { name: COPY.stop, exact: true });
    this.menu = page.getByRole('button', { name: COPY.chatActions });
    this.transcript = page.getByTestId(TEST_IDS.transcript);
    this.archivedBanner = page.getByRole('status').filter({ hasText: COPY.archivedBanner });
    this.archivedBannerRestore = this.archivedBanner.getByRole('button', { name: COPY.restore });
    this.errorCard = page.getByRole('alert');
    this.streamCursor = page.getByTestId(TEST_IDS.streamCursor);
  }

  /** Opens a chat by id. */
  async goto(chatId: string): Promise<void> {
    await this.page.goto(`/chats/${chatId}`);
    await expect(this.transcript).toBeVisible();
  }

  /** Every user message of the transcript. */
  get userMessages(): Locator {
    return this.transcript.locator(`[data-item-kind="${ITEM_KIND.user}"]`);
  }

  /** Every assistant message of the transcript. */
  get assistantMessages(): Locator {
    return this.transcript.locator(`[data-item-kind="${ITEM_KIND.assistant}"]`);
  }

  /** Every system notice of the transcript. */
  get systemNotices(): Locator {
    return this.transcript.locator(`[data-item-kind="${ITEM_KIND.notice}"]`);
  }

  /**
   * Tool-call rows, optionally narrowed to one tool.
   *
   * The rows carry no `data-tool-name`; the tool name is rendered as their leading text, which is
   * what the filter below matches. That id is on the list requested from the interface lanes.
   *
   * @param name - Tool name such as `run_shell`.
   */
  toolRows(name?: string): Locator {
    const rows = this.transcript.locator(`[data-item-kind="${ITEM_KIND.tool}"]`);
    return name === undefined ? rows : rows.filter({ hasText: name });
  }

  /** Expands one tool row so its arguments and output render. */
  async expandToolRow(row: Locator): Promise<void> {
    await row.getByRole('button').first().click();
    await expect(row.getByRole('heading', { name: 'Arguments' })).toBeVisible();
  }

  /**
   * Waits for the status pill to show a phase.
   *
   * @param phase - Phase whose label is expected.
   * @param timeoutMs - Budget.
   */
  async waitForStatus(phase: StatusPhase, timeoutMs: number): Promise<void> {
    await expect(this.statusPill).toContainText(STATUS_LABEL[phase], { timeout: timeoutMs });
  }

  /**
   * Waits for text to appear anywhere in the transcript.
   *
   * @param text - Substring to wait for.
   * @param timeoutMs - Budget.
   */
  async waitForText(text: string, timeoutMs: number): Promise<void> {
    await expect(this.transcript).toContainText(text, { timeout: timeoutMs });
  }

  /** Asserts a preparation notice is rendered for the current turn. */
  async expectPreparingNotice(timeoutMs: number): Promise<void> {
    await expect(
      this.systemNotices.filter({ hasText: /Cloning|Prepared|Checking out/ }),
    ).not.toHaveCount(0, { timeout: timeoutMs });
  }

  /** Requests a stop and confirms the dialog. */
  async requestStop(): Promise<void> {
    await this.stop.click();
    const dialog = this.page.getByRole('alertdialog').filter({ hasText: COPY.stopTurnTitle });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: COPY.confirmStop, exact: true }).click();
  }

  /** Archives the chat through the overflow menu. */
  async archive(): Promise<void> {
    await this.menu.click();
    await this.page.getByRole('menuitem', { name: COPY.archive }).click();
    await expect(this.archivedBanner).toBeVisible();
  }

  /** Restores the chat from the archived banner. */
  async restore(): Promise<void> {
    await this.archivedBannerRestore.click();
    await expect(this.archivedBanner).toHaveCount(0);
  }

  /** Deletes the chat through the overflow menu and its confirmation. */
  async deleteChat(): Promise<void> {
    await this.menu.click();
    await this.page.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = this.page.getByRole('alertdialog').filter({ hasText: 'Delete this chat?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  }

  /** The chat id taken from the current URL. */
  chatIdFromUrl(): string {
    const match = /\/chats\/([^/?#]+)/.exec(new URL(this.page.url()).pathname);
    if (match?.[1] === undefined) {
      throw new Error(`Not on a chat page: ${this.page.url()}`);
    }
    return match[1];
  }
}
