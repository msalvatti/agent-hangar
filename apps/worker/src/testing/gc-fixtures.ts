/**
 * Seeding helpers shared by the collector's suites.
 *
 * Layer: test double (fixtures).
 *
 * The collector is exercised from two directions — the `workspace-gc` consumer in the steady state
 * and the recovery a boot performs — and both need the same rows: a chat's workspace, a run's
 * workspace, and a container behind either of them when the test is about what the daemon still
 * holds. They live here rather than in one suite so the other cannot drift into seeding a
 * subtly different row for the same word.
 */
import type { Workspace } from '@agent-hangar/core';

import { createGcProcessor } from '../processors/gc.js';
import type { GcResult } from '../processors/gc.js';
import type { ProcessorJob } from '../processors/types.js';

import type { TestContainer } from './test-container.js';

/** Repository every workspace these helpers seed is bound to. */
export const GC_FIXTURE_REPO_URL = 'https://github.com/octocat/Hello-World';

/** Limits every seeded container is created with; no test here is about resource ceilings. */
const FIXTURE_LIMITS = { cpus: 1, memoryBytes: 1, pids: 1 };

/**
 * Runs the collector over one job.
 *
 * @param container - The test container, which satisfies `ProcessorDeps`.
 * @param name - Job name to dispatch on.
 * @param data - Job payload; the idle pass takes none.
 * @returns What the pass changed.
 */
export async function collect(
  container: TestContainer,
  name: string,
  data: unknown = {},
): Promise<GcResult> {
  const job: ProcessorJob<unknown> = { id: 'gc-1', name, data };
  return createGcProcessor(container)(job);
}

/**
 * Seeds a `JOB` workspace and its container, in the state its run left it.
 *
 * @param container - The test container.
 * @returns The workspace row.
 */
export async function seedJobWorkspace(container: TestContainer): Promise<Workspace> {
  const created = await container.repos.workspaces.create({
    kind: 'JOB',
    runnerKind: 'fake',
    image: 'image',
    repoUrl: GC_FIXTURE_REPO_URL,
    branch: 'main',
  });
  await container.repos.workspaces.setStatus(created.id, 'READY', { runnerRef: 'ref-1' });
  await container.runner.create({
    workspaceId: created.id,
    kind: 'JOB',
    image: 'image',
    env: {},
    limits: FIXTURE_LIMITS,
    labels: { 'ah.instance': container.config.AH_INSTANCE },
  });
  return created;
}

/**
 * Seeds a chat with a live workspace, optionally backed by a container the fake runner holds.
 *
 * @param container - The test container.
 * @param options - The status to leave the row in, how long ago it was last active, and whether a
 *   container should exist behind it.
 * @returns The workspace row.
 */
export async function seedWorkspace(
  container: TestContainer,
  options: { status: 'READY' | 'BUSY'; idleMinutes: number; withContainer?: boolean },
): Promise<Workspace> {
  const chat = await container.repos.chats.create({
    title: 'Task',
    repoUrl: GC_FIXTURE_REPO_URL,
    baseBranch: 'main',
  });
  const created = await container.repos.workspaces.create({
    kind: 'CHAT',
    chatId: chat.id,
    runnerKind: 'fake',
    image: 'image',
    repoUrl: GC_FIXTURE_REPO_URL,
    branch: 'main',
  });
  await container.repos.workspaces.setStatus(created.id, 'READY', { runnerRef: 'ref-1' });
  if (options.status === 'BUSY') {
    await container.repos.workspaces.setStatus(created.id, 'BUSY');
  }
  if (options.withContainer === true) {
    await container.runner.create({
      workspaceId: created.id,
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits: FIXTURE_LIMITS,
      labels: { 'ah.instance': container.config.AH_INSTANCE },
    });
  }
  // The store's own accessor rather than a `Map.get` and a guard: the row was created two
  // statements ago, so "it might be missing" is not a case a fixture should carry an untaken
  // branch for — if the store ever loses it, the seeding should fail loudly instead.
  const row = container.repos.store.require(
    container.repos.store.workspaces,
    'Workspace',
    created.id,
  );
  row.lastActiveAt = new Date(container.clock.now().getTime() - options.idleMinutes * 60_000);
  return created;
}
