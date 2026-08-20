/**
 * Bringing Redis' Job Schedulers back in step with the database on every boot.
 *
 * Layer: service.
 *
 * Postgres holds the truth and Redis holds the schedulers, and they drift whenever the app writes
 * one and fails before the other, or whenever Redis is flushed. The diff is computed by the
 * scheduling module and applied by the queue wrappers; this file is only the wiring between the
 * two, plus the one scheduler that belongs to no job — the idle-workspace collector.
 *
 * Re-upserting everything would be simpler and wrong: an upsert reschedules the next delayed job,
 * so a worker that restarts often would keep pushing every job's next tick further out.
 */
import {
  applyReconcilePlan,
  listSchedulers,
  reconcile,
  upsertGcScheduler,
} from '@agent-hangar/core';
import type { Repositories } from '@agent-hangar/core';
import type { Logger } from 'pino';

import type { WorkerQueues } from './queues.js';

/** What the reconciler needs from the container. */
export interface ReconcileDeps {
  repos: Pick<Repositories, 'scheduledJobs'>;
  queues: WorkerQueues;
  logger: Logger;
}

/** What one reconciliation changed. */
export interface ReconcileSummary {
  /** How many job schedulers were created or updated. */
  upserted: number;
  /** How many schedulers with no matching enabled job were removed. */
  removed: number;
}

/**
 * Reconciles the registered schedulers with the enabled jobs, and ensures the collector's own.
 *
 * @param deps - Repositories, queues and logger.
 * @returns How many schedulers were upserted and removed.
 */
export async function reconcileSchedulers(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const jobs = await deps.repos.scheduledJobs.listEnabled();
  const existing = await listSchedulers(deps.queues.scheduledJobs);
  const applied = await applyReconcilePlan(deps.queues.scheduledJobs, reconcile(jobs, existing));
  await upsertGcScheduler(deps.queues.workspaceGc);
  const summary: ReconcileSummary = {
    upserted: applied.upserted.length,
    removed: applied.removed.length,
  };
  deps.logger.info(summary, 'job schedulers reconciled');
  return summary;
}
