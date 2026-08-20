/**
 * The single place a test id is spelled, and the copy the specs assert on.
 *
 * Layer: test support (pure).
 *
 * Page objects reach for an accessible role and name first — that is what a person uses, so an
 * assertion written that way fails when the interface becomes unusable, which a class or an id
 * cannot tell you. A test id is used only where the interface exposes no stable name. Keys marked
 * below as pending have no id in the interface today; the page object still names the key, so
 * adding the attribute is the only change needed to switch that locator over.
 */

/** Test ids the specs reach for, by role in the interface. */
export const TEST_IDS = {
  // Shell — present.
  sidebar: 'sidebar-slot',
  sidebarRail: 'sidebar-rail',
  header: 'header-slot',
  chatListSkeleton: 'chat-list-skeleton',
  // Shell — pending.
  sidebarNewChat: 'sidebar-new-chat',
  sidebarNavScheduled: 'sidebar-nav-scheduled',
  sidebarNavSettings: 'sidebar-nav-settings',
  sidebarSearch: 'sidebar-search',
  chatList: 'chat-list',
  chatListItem: 'chat-list-item',
  archivedGroupToggle: 'archived-group-toggle',
  archivedList: 'archived-list',
  envPill: 'env-pill',
  themeToggle: 'theme-toggle',

  // Composer — present.
  composerSkeleton: 'composer-skeleton',
  newChatScroll: 'new-chat-scroll',
  // Composer — pending.
  composer: 'composer',
  repoPicker: 'repo-picker',
  repoPickerOption: 'repo-picker-option',
  branchPicker: 'branch-picker',
  branchPickerOption: 'branch-picker-option',
  composerTextarea: 'composer-textarea',
  composerSend: 'composer-send',
  secretsMissingNotice: 'secrets-missing-notice',
  secretsMissingLink: 'secrets-missing-link',

  // Chat — present.
  transcript: 'transcript',
  streamCursor: 'stream-cursor',
  chatSkeleton: 'chat-skeleton',
  // Chat — pending.
  chatTitle: 'chat-title',
  repoChip: 'repo-chip',
  statusPill: 'status-pill',
  stopTurn: 'stop-turn',
  chatMenu: 'chat-menu',
  chatMenuArchive: 'chat-menu-archive',
  chatMenuRestore: 'chat-menu-restore',
  chatMenuDelete: 'chat-menu-delete',
  messageUser: 'message-user',
  messageAssistant: 'message-assistant',
  systemNotice: 'system-notice',
  toolCallRow: 'tool-call-row',
  toolCallOutput: 'tool-call-output',
  errorCard: 'error-card',
  archivedBanner: 'archived-banner',
  archivedBannerRestore: 'archived-banner-restore',
  reconnectingBar: 'reconnecting-bar',

  // Scheduled — present.
  jobsSkeleton: 'jobs-skeleton',
  runsSkeleton: 'runs-skeleton',
  // Scheduled — pending.
  jobsTable: 'jobs-table',
  jobRow: 'job-row',
  newJob: 'new-job',
  jobDialog: 'job-dialog',
  jobName: 'job-name',
  jobCron: 'job-cron',
  jobCronPreview: 'job-cron-preview',
  jobCronError: 'job-cron-error',
  jobTimezone: 'job-timezone',
  jobPrompt: 'job-prompt',
  jobEnabled: 'job-enabled',
  jobSave: 'job-save',
  jobRowMenu: 'job-row-menu',
  jobRunNow: 'job-run-now',
  jobEdit: 'job-edit',
  jobDelete: 'job-delete',
  jobDeleteConfirm: 'job-delete-confirm',
  runsTable: 'runs-table',
  runRow: 'run-row',
  runDrawer: 'run-drawer',
  runOutput: 'run-output',
  runDrawerTranscript: 'run-drawer-transcript',

  // Settings — present (the two secret keys are interpolated by `secretFieldId`/`secretMaskId`).
  secretFieldGithubPat: 'secret-field-GITHUB_PAT',
  secretMaskGithubPat: 'secret-mask-GITHUB_PAT',
  secretFieldOpenaiKey: 'secret-field-OPENAI_API_KEY',
  secretMaskOpenaiKey: 'secret-mask-OPENAI_API_KEY',
  // Settings — pending.
  secretInputGithubPat: 'secret-input-GITHUB_PAT',
  secretSaveGithubPat: 'secret-save-GITHUB_PAT',
  secretReplaceGithubPat: 'secret-replace-GITHUB_PAT',
  secretRemoveGithubPat: 'secret-remove-GITHUB_PAT',
  secretInputOpenaiKey: 'secret-input-OPENAI_API_KEY',
  secretSaveOpenaiKey: 'secret-save-OPENAI_API_KEY',
  secretReplaceOpenaiKey: 'secret-replace-OPENAI_API_KEY',
  secretRemoveOpenaiKey: 'secret-remove-OPENAI_API_KEY',
  secretRemoveConfirm: 'secret-remove-confirm',
  settingsModel: 'settings-model',
  envSummary: 'env-summary',

  // Mock bootstrap — present.
  mockBooting: 'mock-booting',
  mockFailed: 'mock-failed',
} as const;

/** Secret keys the settings screen renders a field for. */
export type SecretKey = 'GITHUB_PAT' | 'OPENAI_API_KEY';

/** Test id of one secret field's container. */
export function secretFieldId(key: SecretKey): string {
  return `secret-field-${key}`;
}

/** Test id of one secret field's mask, rendered once the value is stored. */
export function secretMaskId(key: SecretKey): string {
  return `secret-mask-${key}`;
}

/** Visible label of each secret field, which is also its input's accessible name. */
export const SECRET_LABELS: Readonly<Record<SecretKey, string>> = {
  GITHUB_PAT: 'GitHub Personal Access Token',
  OPENAI_API_KEY: 'OpenAI API key',
};

/** `data-item-kind` values the transcript marks its rows with. */
export const ITEM_KIND = {
  user: 'user',
  assistant: 'assistant',
  notice: 'notice',
  tool: 'tool',
} as const;

/** Copy the specs assert on, quoted from the interface so a wording change fails a spec. */
export const COPY = {
  newChatHeadline: 'What should we build?',
  chooseRepository: 'Choose repository',
  chooseBranch: 'Choose branch',
  promptLabel: 'Prompt',
  send: 'Send',
  secretsMissing: 'Add your GitHub token and OpenAI key in Settings to start.',
  openSettings: 'Open Settings',
  archivedBanner: 'This chat is archived. Restore it to continue in a fresh workspace.',
  restore: 'Restore',
  archive: 'Archive',
  stop: 'Stop',
  stopTurnTitle: 'Stop the running turn?',
  confirmStop: 'Stop',
  chatActions: 'Chat actions',
  transcriptRegion: 'Transcript',
  newJob: 'New job',
  saveJob: 'Save',
  cronEmptyPreview: 'Enter a cron expression (5 fields).',
  runNow: 'Run now',
  deleteJob: 'Delete',
  runsHeading: 'Runs',
  jobsTableCaption: 'Scheduled jobs',
  runsTableCaption: 'Runs',
  copyOutput: 'Copy output',
  noOutputYet: 'No output yet.',
  removeSecret: 'Remove',
  replaceSecret: 'Replace',
  saveSecret: 'Save',
  settingsMissingHeadline: 'Add your GitHub token and OpenAI key in Settings to start.',
} as const;

/** Status-pill text for each phase of a turn; the pill exposes no role or attribute. */
export const STATUS_LABEL = {
  queued: 'Queued',
  preparing: 'Preparing',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const;

/** A phase the status pill can show. */
export type StatusPhase = keyof typeof STATUS_LABEL;
