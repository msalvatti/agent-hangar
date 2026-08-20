/**
 * Unit tests for container ↔ workspace-row reconciliation.
 *
 * Layer: unit.
 * Goal: containers with no live row are classified for destruction, live rows with no container
 * are classified as gone, an agreeing pair produces no work, and both lists are ordered.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import type { WorkspaceHandle } from '../runner/types.ts';

import { planOrphanReconcile } from './orphans.ts';

/**
 * Builds a runner handle.
 *
 * @param workspaceId - Id the workspace row would carry.
 * @returns A handle as `WorkspaceRunner.list` reports it.
 */
function handle(workspaceId: string): WorkspaceHandle {
  return { workspaceId, runnerRef: `container-${workspaceId}` };
}

/**
 * Builds a live workspace row.
 *
 * @param id - Workspace id.
 * @returns A row as the repository reports it.
 */
function row(id: string): { id: string; runnerRef: string | null } {
  return { id, runnerRef: `container-${id}` };
}

describe('planOrphanReconcile', () => {
  /**
   * With nothing on either side there is nothing to repair.
   */
  it('produces an empty plan for empty inputs', () => {
    expect(planOrphanReconcile({ runnerHandles: [], dbLive: [] })).toEqual({
      destroyOrphans: [],
      markGone: [],
    });
  });

  /**
   * A worker that died between `create` and the row update leaves a container nothing points at;
   * it burns memory until the collector destroys it.
   */
  it('classifies a container with no live row as an orphan', () => {
    const orphan = handle('ws-1');
    expect(planOrphanReconcile({ runnerHandles: [orphan], dbLive: [] })).toEqual({
      destroyOrphans: [orphan],
      markGone: [],
    });
  });

  /**
   * A container removed by hand or lost to a Docker restart leaves a row claiming a workspace that
   * no longer exists; the caller closes the row out.
   */
  it('classifies a live row with no container as gone', () => {
    expect(planOrphanReconcile({ runnerHandles: [], dbLive: [row('ws-1')] })).toEqual({
      destroyOrphans: [],
      markGone: ['ws-1'],
    });
  });

  /**
   * Matching is by workspace id, which both sides know from the moment the row is inserted, so an
   * agreeing pair produces no work even though the handle carries a runner reference too.
   */
  it('produces no work when both sides agree', () => {
    expect(planOrphanReconcile({ runnerHandles: [handle('ws-1')], dbLive: [row('ws-1')] })).toEqual(
      { destroyOrphans: [], markGone: [] },
    );
  });

  /**
   * Both kinds of drift can be present at once, and each list is ordered by id so the plan is
   * stable and diffable in logs.
   */
  it('reports both directions in a stable order', () => {
    const plan = planOrphanReconcile({
      runnerHandles: [handle('orphan-b'), handle('shared'), handle('orphan-a')],
      dbLive: [row('gone-b'), row('shared'), row('gone-a')],
    });
    expect(plan.destroyOrphans.map((entry) => entry.workspaceId)).toEqual(['orphan-a', 'orphan-b']);
    expect(plan.markGone).toEqual(['gone-a', 'gone-b']);
  });

  /**
   * The plan is pure, so the collector may keep using the handle list and the rows it read.
   */
  it('does not mutate its inputs', () => {
    const runnerHandles = [handle('b'), handle('a')];
    const dbLive = [row('z'), row('a')];
    const handlesBefore = structuredClone(runnerHandles);
    const rowsBefore = structuredClone(dbLive);
    planOrphanReconcile({ runnerHandles, dbLive });
    expect(runnerHandles).toEqual(handlesBefore);
    expect(dbLive).toEqual(rowsBefore);
  });
});
