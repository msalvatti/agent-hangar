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
 * No two arrays answer the same path, so the order is presentation rather than routing: each
 * handler owns its own route and answers every request that reaches it, including the not-found
 * case. Cancelling is the one that used to be shared — a chat turn and a job run are stopped
 * through separate routes precisely because their ids come from separate tables — so nothing here
 * relies on one array declining a request for another to pick it up.
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
