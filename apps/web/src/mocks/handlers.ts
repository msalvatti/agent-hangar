/**
 * Every MSW handler the mock API serves, composed from the per-domain arrays.
 *
 * Layer: mock (composition root).
 *
 * `scheduledHandlers`/`settingsHandlers` (lane W1-H) are appended below the marked line — the
 * only cross-lane edit to this file, one additive line, resolved by the orchestrator.
 */
import { chatHandlers } from './chats';
import { eventHandlers } from './events';
import { healthHandlers } from './health';
import { repoHandlers } from './repos';
import { settingsStatusHandlers } from './settings-status';

/** Every mock handler, in the order MSW matches them. */
export const handlers = [
  ...repoHandlers,
  ...chatHandlers,
  ...healthHandlers,
  ...settingsStatusHandlers,
  ...eventHandlers,
  // W1-H appends ...scheduledHandlers, ...settingsHandlers here (see docs/tasks/wave-1h-web-scheduled-settings.md)
];
