/**
 * Integration tests (@db) for the Prisma client and the initial migration.
 *
 * Layer: integration.
 * Goal: the migration applies to a real Postgres, the hand-written partial unique index exists
 * and enforces "one live workspace per chat", and the client round-trips `SELECT 1`.
 * Mocks: none — needs `DATABASE_URL` (compose instance). Fails loudly when `CI=1` and the
 * database is not configured; skips with an instruction locally.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assertDatabaseReachable } from './client.js';
import { truncateAll, withTestDb } from './testing/db.js';

const databaseUrl = process.env.DATABASE_URL;
const hasDatabase = databaseUrl !== undefined && databaseUrl.length > 0;

if (!hasDatabase && process.env.CI !== undefined) {
  throw new Error(
    '@db integration tests require DATABASE_URL in CI (services postgres must be configured)',
  );
}

if (!hasDatabase) {
  console.info(
    '[skip] @db integration tests: set DATABASE_URL (pnpm infra:up; export the values of .env.local) to run them',
  );
}

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

describe.skipIf(!hasDatabase)('prisma client @db', () => {
  /**
   * `prisma migrate deploy` applies `0001_init` (idempotent on re-run) and the partial unique
   * index `Workspace_one_live_per_chat` is present in `pg_indexes` with its WHERE clause.
   */
  it('applies the migration including the partial unique index', async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    await withTestDb(async (client) => {
      await assertDatabaseReachable(client);
      const rows = await client.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'Workspace_one_live_per_chat'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.indexdef).toContain('UNIQUE');
      expect(rows[0]?.indexdef).toMatch(/WHERE/);
    });
  });

  /**
   * Invariant: two live workspaces for the same chat violate the partial unique index (Prisma
   * error P2002), while a DESTROYED one plus a live one is allowed; tables are truncated after.
   */
  it('rejects a second live workspace for the same chat', async () => {
    await withTestDb(async (client) => {
      const chat = await client.chat.create({
        data: { title: 't', repoUrl: 'https://github.com/acme/w', baseBranch: 'main' },
      });
      const base = {
        chatId: chat.id,
        kind: 'CHAT' as const,
        runnerKind: 'fake',
        image: 'img',
        repoUrl: chat.repoUrl,
        branch: 'main',
      };
      await client.workspace.create({ data: { ...base, status: 'DESTROYED' } });
      await client.workspace.create({ data: { ...base, status: 'READY' } });
      await expect(
        client.workspace.create({ data: { ...base, status: 'BUSY' } }),
      ).rejects.toMatchObject({
        code: 'P2002',
      });
      await truncateAll(client);
      expect(await client.workspace.count()).toBe(0);
      expect(await client.chat.count()).toBe(0);
    });
  });
});
