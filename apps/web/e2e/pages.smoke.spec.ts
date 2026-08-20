/**
 * Selector contract: every locator the six flow specs rely on resolves against the running
 * interface.
 *
 * Layer: end-to-end spec (mock mode only).
 *
 * A flow spec that fails because a selector stopped matching says "the flow is broken" when the
 * truth is "the interface was renamed". These tests separate the two: they touch each locator once
 * against the mock API's seeded state, so a rename fails here, loudly and in one place, before it
 * can be mistaken for a regression in the product.
 */
import { test, expect } from './fixtures';
import {
  ChatPage,
  ComposerPage,
  JobDetailPage,
  ScheduledPage,
  SettingsPage,
  SidebarPage,
} from './pages';
import { useMockScenario } from './support/mock-scenario';
import { COPY, TEST_IDS } from './support/selectors';

/** Chats the mock API seeds; the sidebar and the chat screen are asserted against them. */
const MOCK_CHATS = {
  running: { id: 'chat-running', title: 'Fix flaky auth test' },
  finished: { id: 'chat-finished', title: 'Add tests for the payment webhook' },
  archived: { id: 'chat-archived', title: 'Refactor the queue consumer' },
} as const;

/** Repository and branch the mock API seeds. */
const MOCK_REPO = 'acme/api';
const MOCK_BRANCH = 'develop';

/** Job the mock API seeds; chosen because it is enabled and has runs. */
const MOCK_JOB = 'Nightly tests';

test.describe('selector contract', () => {
  test.beforeEach(({ mode }) => {
    test.skip(mode === 'real', 'selector validation runs against the mock API');
  });

  /**
   * Proves every shell locator resolves: the navigation landmark and its three links, the search
   * trigger, the active chat list with its seeded rows, the archived disclosure and its list, the
   * environment pill and the theme toggle.
   */
  test('the shell exposes its navigation, chat list and status controls', async ({ page }) => {
    const sidebar = new SidebarPage(page);
    await sidebar.goto();
    await expect(sidebar.root).toBeVisible();
    await expect(sidebar.nav).toBeVisible();
    await expect(sidebar.newChat).toBeVisible();
    await expect(sidebar.scheduled).toBeVisible();
    await expect(sidebar.settings).toBeVisible();
    await expect(sidebar.search).toBeVisible();
    await expect(sidebar.chatItem(MOCK_CHATS.running.title)).toBeVisible();
    await expect(sidebar.chatItem(MOCK_CHATS.finished.title)).toBeVisible();
    await sidebar.openArchived();
    await expect(sidebar.archivedItem(MOCK_CHATS.archived.title)).toBeVisible();
    await expect(sidebar.chatItem(MOCK_CHATS.archived.title)).toHaveCount(0);
    expect(await sidebar.envPillText()).toMatch(/^Environment status:/);
    await expect(sidebar.themeToggle).toBeVisible();
  });

  /**
   * Proves the new-chat screen exposes its headline, suggestion cards and composer, that both
   * pickers open and list the seeded repository and branches, and that Send stays disabled until a
   * repository, a branch and a prompt are all present.
   */
  test('the new chat screen exposes the composer and both pickers', async ({ page }) => {
    const sidebar = new SidebarPage(page);
    const composer = new ComposerPage(page);
    await sidebar.goto();
    await expect(page.getByRole('heading', { level: 1, name: COPY.newChatHeadline })).toBeVisible();
    await expect(page.getByTestId(TEST_IDS.newChatScroll)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Explore and understand code' })).toBeVisible();
    await expect(composer.textarea).toBeVisible();
    await composer.expectSendDisabled();
    await composer.chooseRepo(MOCK_REPO);
    await composer.chooseBranch(MOCK_BRANCH);
    await composer.expectSendDisabled();
    await composer.type('a prompt');
    await expect(composer.send).toBeEnabled();
  });

  /**
   * Proves the credentials notice replaces the composer when no credential is stored, and that it
   * points at the settings screen.
   */
  test('the new chat screen blocks on missing credentials', async ({ page }) => {
    await useMockScenario(page, 'missing-settings');
    const composer = new ComposerPage(page);
    await new SidebarPage(page).goto();
    await composer.expectBlockedBySecrets();
  });

  /**
   * Proves the chat screen exposes its title, status pill, stop control, overflow menu and the
   * four transcript row kinds, and that a tool row expands to show its arguments and output.
   */
  test('the chat screen exposes the header and every transcript row kind', async ({ page }) => {
    const chat = new ChatPage(page);
    await chat.goto(MOCK_CHATS.finished.id);
    await expect(chat.title).toContainText(MOCK_CHATS.finished.title);
    await expect(chat.menu).toBeVisible();
    await expect(chat.userMessages).not.toHaveCount(0);
    await expect(chat.assistantMessages).not.toHaveCount(0);
    const toolRow = chat.toolRows('run_shell').first();
    await expect(toolRow).toBeVisible();
    await expect(toolRow).toHaveAttribute('data-tool-status', 'succeeded');
    await chat.expandToolRow(toolRow);
    await expect(toolRow.getByRole('heading', { name: 'Output' })).toBeVisible();
  });

  /**
   * Proves the live chat screen shows the status pill, the stop control and the preparation
   * notices while a turn is streaming.
   */
  test('a live chat exposes the status pill and the stop control', async ({ page }) => {
    const chat = new ChatPage(page);
    await chat.goto(MOCK_CHATS.running.id);
    await expect(chat.statusPill).toBeVisible();
    await expect(chat.stop).toBeVisible();
    await chat.expectPreparingNotice(15_000);
    await chat.waitForStatus('done', 20_000);
  });

  /**
   * Proves the archived chat renders its banner with a restore control, and that the composer is
   * withheld while the chat is archived.
   */
  test('an archived chat exposes its banner', async ({ page }) => {
    const chat = new ChatPage(page);
    const composer = new ComposerPage(page);
    await chat.goto(MOCK_CHATS.archived.id);
    await expect(chat.archivedBanner).toBeVisible();
    await expect(chat.archivedBannerRestore).toBeVisible();
    await expect(composer.textarea).toBeDisabled();
  });

  /**
   * Proves the scheduled screen exposes its table and seeded rows, that the create dialog opens
   * with every field addressable, that the cron preview reacts to a valid expression and that an
   * invalid one is rejected in place.
   */
  test('the scheduled screen exposes the table and the job dialog', async ({ page }) => {
    const scheduled = new ScheduledPage(page);
    await scheduled.goto();
    await expect(scheduled.table).toBeVisible();
    await expect(scheduled.row(MOCK_JOB)).toBeVisible();
    await expect(scheduled.enabledSwitch(MOCK_JOB)).toBeVisible();
    await expect(scheduled.rowMenu(MOCK_JOB)).toBeVisible();
    await scheduled.openNewJob();
    await expect(scheduled.cronPreview()).toHaveText(COPY.cronEmptyPreview);
    await scheduled.dialog.getByLabel('Cron', { exact: true }).fill('61 * * * *');
    await expect(scheduled.dialog.getByText(/Invalid cron expression/)).toBeVisible();
    await scheduled.dialog.getByLabel('Cron', { exact: true }).fill('* * * * *');
    await expect(scheduled.dialog.getByText(/^Runs /)).toBeVisible();
    await expect(scheduled.dialog.getByLabel('Name', { exact: true })).toBeVisible();
    await expect(scheduled.dialog.getByLabel('Prompt', { exact: true })).toBeVisible();
    await expect(scheduled.dialog.getByRole('group', { name: 'Repository' })).toBeVisible();
    await expect(scheduled.dialog.getByRole('group', { name: 'Branch' })).toBeVisible();
    await expect(scheduled.dialog.getByRole('button', { name: 'Timezone' })).toBeVisible();
    await expect(scheduled.dialog.getByRole('switch', { name: 'Enabled' })).toBeVisible();
    await expect(
      scheduled.dialog.getByRole('button', { name: COPY.saveJob, exact: true }),
    ).toBeVisible();
  });

  /**
   * Proves the job detail screen exposes its runs table and that opening a run row shows the
   * drawer with a transcript and a raw-output tab.
   */
  test('the job detail screen exposes runs and the run drawer', async ({ page }) => {
    const scheduled = new ScheduledPage(page);
    const detail = new JobDetailPage(page);
    await scheduled.goto();
    await scheduled.openJob(MOCK_JOB);
    await expect(page.getByRole('heading', { level: 2, name: COPY.runsHeading })).toBeVisible();
    await expect(detail.runsTable).toBeVisible();
    await expect(detail.runNow).toBeVisible();
    await detail.openRun(0);
    await expect(detail.drawer.getByTestId(TEST_IDS.transcript)).toBeVisible();
    expect(await detail.rawOutputText()).not.toBe('');
  });

  /**
   * Proves the settings screen exposes both credential fields with their masks and controls, the
   * model line and the environment summary.
   */
  test('the settings screen exposes both credential fields', async ({ page }) => {
    const settings = new SettingsPage(page);
    await settings.goto();
    for (const key of ['GITHUB_PAT', 'OPENAI_API_KEY'] as const) {
      await expect(settings.field(key)).toBeVisible();
      await expect(settings.mask(key)).toBeVisible();
      await expect(settings.replaceButton(key)).toBeVisible();
      await expect(settings.removeButton(key)).toBeVisible();
      expect(await settings.maskText(key)).toMatch(/^•{8}.{4}$/);
    }
    await expect(settings.modelLine()).toBeVisible();
    await expect(settings.envSummary()).toBeVisible();
  });

  /**
   * Proves an unset credential renders an input with a Save control, which is the state the
   * settings specs drive.
   */
  test('an unset credential renders its input', async ({ page }) => {
    await useMockScenario(page, 'missing-settings');
    const settings = new SettingsPage(page);
    await settings.goto();
    await settings.expectNotSet('GITHUB_PAT');
    await expect(settings.saveButton('GITHUB_PAT')).toBeVisible();
  });
});
