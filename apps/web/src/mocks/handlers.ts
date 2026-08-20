/**
 * Every MSW handler the mock API serves, composed from the per-domain arrays.
 *
 * Layer: mock (composition root).
 *
 * Each feature area owns exactly one additive line here, spreading its own handler module, which
 * keeps the diff of every contribution trivially mergeable.
 */
import { chatHandlers } from './chats';
import { eventHandlers } from './events';
import { healthHandlers } from './health';
import { repoHandlers } from './repos';
import { scheduledHandlers } from './scheduled';
import { settingsHandlers } from './settings';
import { settingsStatusHandlers } from './settings-status';

/**
 * Every mock handler, in the order MSW matches them.
 *
 * `scheduledHandlers` comes before `chatHandlers` because both answer `POST /api/turns/:id/cancel`
 * — the route takes a turn id or a job-run id. The scheduled handler returns nothing for an id it
 * does not know, so an unmatched id falls through to the chat handler behind it.
 */
export const handlers = [
  ...repoHandlers,
  ...scheduledHandlers,
  ...chatHandlers,
  ...healthHandlers,
  ...settingsStatusHandlers,
  ...eventHandlers,
  ...settingsHandlers,
];
