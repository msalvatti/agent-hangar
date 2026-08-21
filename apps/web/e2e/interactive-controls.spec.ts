/**
 * Pointer and width contract: on every screen, at each of the four widths the design is drawn for,
 * no interactive control is covered by another element, every clickable one offers a pointer
 * cursor, and the page itself does not scroll sideways.
 *
 * Layer: end-to-end spec (mock mode only).
 *
 * These are the two assertions in this repository that can see a control a person cannot use. The
 * unit suites can make neither — jsdom reports every rectangle as 0×0 and computes no cursor from
 * a Tailwind class, so both checks would pass against broken code — and the reviews that found the
 * last three collisions found them by eye. Here a real engine answers `elementFromPoint` at points
 * inside every control, which is the same question a click asks, and reports the cursor the person
 * actually sees rather than the class that was written.
 *
 * Mock mode, for the same reason `pages.smoke.spec.ts` runs there: the seeded state is fixed, so
 * every screen is populated the same way on every run and a width that regresses fails for one
 * reason. Nothing measured here depends on the worker, Docker or the database — a covered control
 * is a fact about the stylesheet and the markup, which are identical in both modes.
 *
 * The widths are the ones spec 10 §9 names: 1440 and 1024 for the sidebar and its rail, 768 and
 * 375 for the overlay drawer. The reported point is in viewport coordinates, so a failure can be
 * reproduced by opening the same screen at the same width.
 *
 * The sheets' own widths are measured here for the same reason: a width is a fact about the
 * cascade, and the cascade is the thing a unit assertion about a class name cannot see.
 */
import type { Locator, Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { ChatPage, JobDetailPage, ScheduledPage, SettingsPage, SidebarPage } from './pages';
import { describeDefects, findUnusableControls } from './support/interactive-controls';
import { COPY, TEST_IDS } from './support/selectors';

/** Viewport widths spec 10 §9 designs for, with the height used for all of them. */
const WIDTHS = [1440, 1024, 768, 375] as const;

/** Viewport height every width is measured at; tall enough to put whole screens in view. */
const VIEWPORT_HEIGHT = 900;

/** The narrowest width of the walk, and the only one below the 768 px overlay-drawer breakpoint. */
const DRAWER_WIDTH = 375;

/** Chats the mock API seeds. */
const MOCK_CHATS = {
  finished: 'chat-finished',
  archived: 'chat-archived',
} as const;

/** Job the mock API seeds; it is enabled and has runs, so its detail screen has a drawer to open. */
const MOCK_JOB = 'Nightly tests';

/** Width spec 10 §4 gives the run drawer, and §2 the sidebar, in CSS pixels. */
const SHEET_WIDTH = { runDrawer: 720, sidebar: 260 } as const;

/**
 * Fails naming every control on the page that is covered or that offers no pointer cursor.
 *
 * Both rules are asserted together at every stop, because both are properties of one rendered
 * screen and separating them would mean walking the product twice to learn the same thing.
 *
 * @param page - The page to measure.
 * @param where - Screen and width, so a failure names what was on screen.
 */
async function expectUsableControls(page: Page, where: string): Promise<void> {
  expect(describeDefects(where, await findUnusableControls(page))).toEqual([]);
}

/**
 * Fails when the page itself scrolls sideways.
 *
 * Spec 10 §9 forbids it outright, and it is the other defect a rectangle in jsdom cannot see: one
 * element wider than its column pushes the whole document out, and every unit assertion about that
 * element still passes. The document element is what is measured rather than a container, because
 * a table that scrolls inside its own box is the intended behaviour and only the page is not
 * allowed to.
 *
 * @param page - The page to measure.
 * @param where - Screen and width, so a failure names what was on screen.
 */
async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth > overflow.clientWidth
      ? [
          `${where}: the page scrolls to ${String(overflow.scrollWidth)}px in a ` +
            `${String(overflow.clientWidth)}px viewport`,
        ]
      : [],
  ).toEqual([]);
}

/**
 * The width one element occupies on screen, rounded to whole pixels.
 *
 * The border box is read rather than the computed `width`, because that is the number a person
 * sees: a sheet whose `max-width` wins reports the cap it settled on, not the `width` it asked
 * for. Rounded because a percentage width lands on a fraction — 75 % of 375 px is 281.25 — and a
 * fraction is never the answer a design states.
 *
 * @param locator - The element to measure; it must be visible.
 * @returns Its rendered width in CSS pixels.
 */
async function widthOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  expect(box, 'the element must be visible to be measured').not.toBeNull();
  return Math.round(box?.width ?? 0);
}

test.describe('interactive controls are usable with a pointer', () => {
  test.beforeEach(async ({ page, mode }) => {
    test.skip(mode === 'real', 'the layout is measured against the mock API seeded state');
    await page.setViewportSize({ width: WIDTHS[0], height: VIEWPORT_HEIGHT });
  });

  for (const width of WIDTHS) {
    /**
     * Walks the three screens the checklist names — the new-chat home, the scheduled-jobs list and
     * settings — at one width, and requires every control on each to own its own box and to offer
     * a pointer cursor, and the page to fit the viewport. These
     * are the screens the sidebar shares, so this is also where the shell's own controls are
     * measured: the wordmark, the search trigger, the navigation, the chat rows, the environment
     * pill and the theme toggle, in the column at the wide widths and in the rail below 1024.
     */
    test(`the three screens keep their controls usable at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      const sidebar = new SidebarPage(page);

      await sidebar.goto();
      await expect(
        page.getByRole('heading', { level: 1, name: COPY.newChatHeadline }),
      ).toBeVisible();
      await expectUsableControls(page, `/chats/new at ${String(width)} px`);
      await expectNoSidewaysScroll(page, `/chats/new at ${String(width)} px`);

      const scheduled = new ScheduledPage(page);
      await scheduled.goto();
      await expectUsableControls(page, `/scheduled at ${String(width)} px`);
      await expectNoSidewaysScroll(page, `/scheduled at ${String(width)} px`);

      const settings = new SettingsPage(page);
      await settings.goto();
      await expect(settings.modelLine()).toBeVisible();
      await expectUsableControls(page, `/settings at ${String(width)} px`);
      await expectNoSidewaysScroll(page, `/settings at ${String(width)} px`);
    });
  }

  /**
   * The chat screen carries the densest header in the product — title, repository chip, status
   * pill, stop control and an overflow trigger, all on one line — and a transcript whose tool rows
   * are themselves focusable. It is measured with a tool row expanded, because that is when the
   * row grows a copy control of its own next to the header's.
   */
  test('the chat screen keeps its header and transcript controls usable', async ({ page }) => {
    const chat = new ChatPage(page);
    await chat.goto(MOCK_CHATS.finished);
    await expect(chat.title).toBeVisible();
    await expectUsableControls(page, '/chats/:id');

    const toolRow = chat.toolRows('run_shell').first();
    await chat.expandToolRow(toolRow);
    await expect(toolRow.getByRole('heading', { name: 'Output' })).toBeVisible();
    await expectUsableControls(page, '/chats/:id with a tool row expanded');
  });

  /**
   * An archived chat replaces the composer with a banner carrying a Restore control, which sits
   * where the composer's own controls otherwise are.
   */
  test('an archived chat keeps its banner controls usable', async ({ page }) => {
    const chat = new ChatPage(page);
    await chat.goto(MOCK_CHATS.archived);
    await expect(chat.archivedBanner).toBeVisible();
    await expectUsableControls(page, '/chats/:id archived');
  });

  /**
   * The run drawer is a sheet, and a sheet paints its own close button into the top-right corner
   * after its header — which is how the drawer's "Copy run id" button came to sit inside the close
   * button's box, where a click aimed at Copy closed the drawer. Both tabs are measured, because
   * the raw-output tab replaces the whole body.
   */
  test('the run drawer keeps its header actions clear of the close button', async ({ page }) => {
    const scheduled = new ScheduledPage(page);
    const detail = new JobDetailPage(page);
    await scheduled.goto();
    await scheduled.openJob(MOCK_JOB);
    await expect(detail.runsTable).toBeVisible();
    await expectUsableControls(page, '/scheduled/:id');

    await detail.openRun(0);
    await expect(detail.drawer.getByTestId(TEST_IDS.transcript)).toBeVisible();
    await expectUsableControls(page, 'the run drawer');

    await detail.drawer.getByRole('tab', { name: 'Raw output' }).click();
    await expect(detail.drawer.locator('pre').first()).toBeVisible();
    await expectUsableControls(page, 'the run drawer showing raw output');
  });

  /**
   * Below 768 px the sidebar is an overlay drawer, and the drawer is a sheet with the same close
   * button in the same corner — the second of the three collisions this suite exists to catch was
   * the drawer's search trigger sitting under it. The measurement is taken with the archived group
   * expanded, so the drawer is at its tallest and its footer is pushed against the viewport.
   */
  test('the mobile sidebar drawer keeps its own controls usable', async ({ page }) => {
    await page.setViewportSize({ width: DRAWER_WIDTH, height: VIEWPORT_HEIGHT });
    const sidebar = new SidebarPage(page);
    await sidebar.goto();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    // Not `SidebarPage.nav`: that locator is scoped to the docked sidebar slot, and below 768 px
    // the navigation lives in the drawer's sheet instead.
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expectUsableControls(page, 'the mobile navigation drawer');

    const drawer = page.getByRole('dialog');
    await drawer.getByRole('button', { name: /^Archived/ }).click();
    await expect(drawer.getByRole('list', { name: 'Archived chats', exact: true })).toBeVisible();
    await expectUsableControls(page, 'the mobile navigation drawer with archived expanded');
  });

  /**
   * The job dialog stacks a form on top of the list it was opened from, and the timezone and
   * repository pickers open popups over that form. A popup marks what it covers `inert`, so what
   * is measured here is the popup's own rows against each other and against the dialog's chrome.
   */
  test('the job dialog keeps its fields and its popup usable', async ({ page }) => {
    const scheduled = new ScheduledPage(page);
    await scheduled.goto();
    await scheduled.openNewJob();
    await expect(scheduled.dialog.getByLabel('Name', { exact: true })).toBeVisible();
    await expectUsableControls(page, 'the job dialog');

    await scheduled.dialog.getByRole('button', { name: 'Timezone' }).click();
    await expect(page.getByRole('option').first()).toBeVisible();
    await expectUsableControls(page, 'the job dialog with the timezone picker open');
  });

  /**
   * The two sheets are as wide as the design says, which no unit assertion in this repository can
   * establish.
   *
   * The run drawer asked for `w-full sm:max-w-[720px]` and rendered at 384 px, because the sheet
   * primitive expressed its own cap as `data-[side=right]:sm:max-w-sm` — an attribute selector,
   * which outranks the caller's plain class — and `cn` cannot merge two classes written under
   * different variants. The test that was meant to hold the 720 px asserted that the class was in
   * the attribute, and it was: present, and outvoted. The same override took the sidebar drawer
   * from the 260 px it asked for to the primitive's `w-3/4`.
   *
   * Measured at 1440 px, above the `sm` breakpoint where the cap applies, and at 375 px, where the
   * run drawer has no cap and must simply fill the viewport — the width at which a sheet that
   * ignored `w-full` would cover three quarters of the screen and leave a quarter of a backdrop
   * nobody meant to show.
   */
  test('the sheets are as wide as the design says', async ({ page }) => {
    const scheduled = new ScheduledPage(page);
    const detail = new JobDetailPage(page);
    await scheduled.goto();
    await scheduled.openJob(MOCK_JOB);
    await detail.openRun(0);
    await expect(detail.drawer.getByTestId(TEST_IDS.transcript)).toBeVisible();
    expect(await widthOf(detail.drawer)).toBe(SHEET_WIDTH.runDrawer);

    await page.setViewportSize({ width: DRAWER_WIDTH, height: VIEWPORT_HEIGHT });
    expect(await widthOf(detail.drawer)).toBe(DRAWER_WIDTH);

    const sidebar = new SidebarPage(page);
    await sidebar.goto();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const navigation = page.locator('[data-slot="sheet-content"][data-side="left"]');
    await expect(navigation.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    expect(await widthOf(navigation)).toBe(SHEET_WIDTH.sidebar);
  });

  /**
   * The chat search palette is the ⌘K surface: a command dialog whose rows are options rather
   * than links, opened over whatever screen the person was on.
   */
  test('the chat search palette keeps its rows usable', async ({ page }) => {
    const sidebar = new SidebarPage(page);
    await sidebar.goto();
    await sidebar.search.click();
    await expect(page.getByRole('option').first()).toBeVisible();
    await expectUsableControls(page, 'the chat search palette');
  });
});
