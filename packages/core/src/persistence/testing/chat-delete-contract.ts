/**
 * The contract `ChatRepository.deleteIfIdle` owes every caller, run against any implementation.
 *
 * Layer: test double (contract).
 *
 * Two implementations satisfy one port, and a rule only one of them enforces is worse than a rule
 * neither does: the in-memory double is what most suites run against, so a promise it keeps and
 * Postgres breaks is a promise that fails in production only. These assertions are therefore
 * written once and called from both suites — the double's unit tests and the Prisma `@db` ones —
 * rather than living beside whichever implementation was edited last. It is the same argument, and
 * the same shape, as `./workspace-claim-contract.ts`.
 *
 * What is pinned here is the arbitration guarantee and nothing else: a chat carrying a live turn is
 * not deleted, a chat whose turns have all finished is, and a chat that is already gone is
 * reported apart from both.
 */
import { describe, expect, it } from 'vitest';

import { LIVE_RUN_STATUSES } from '../../workspace/lifecycle.ts';
import type { TurnStatus } from '../../workspace/types.ts';
import type { Chat } from '../entities.ts';
import type { ChatRepository } from '../ports.ts';

/** How a suite opens one implementation and gives a chat the turns a test needs. */
export interface ChatDeleteContractHarness {
  /** The implementation under test, ready for one test's use. */
  repository: () => ChatRepository;
  /**
   * Creates a chat with no turns.
   *
   * @returns The row it created.
   */
  seed: () => Promise<Chat>;
  /**
   * Gives a chat one turn in the named status.
   *
   * @param chatId - Chat the turn belongs to.
   * @param status - Status the turn should hold.
   */
  addTurn: (chatId: string, status: TurnStatus) => Promise<void>;
}

/**
 * Registers the `deleteIfIdle` contract against one implementation.
 *
 * @param implementation - Name of the implementation, used in the suite title.
 * @param harness - How to open it and seed a chat.
 */
export function describeChatDeleteContract(
  implementation: string,
  harness: ChatDeleteContractHarness,
): void {
  describe(`${implementation} satisfies the deleteIfIdle contract`, () => {
    /**
     * The ordinary case: nothing holds the chat, so the row and everything under it go.
     */
    it('deletes a chat that carries no turn at all', async () => {
      const chat = await harness.seed();

      expect(await harness.repository().deleteIfIdle(chat.id)).toBe('DELETED');
      expect(await harness.repository().getById(chat.id)).toBeNull();
    });

    /**
     * Every live status refuses, and the refusal is checked one status at a time rather than for a
     * representative one: the set is what the delete arbitrates on, and a status quietly dropped
     * from it would let a delete run under work that is under way.
     */
    it.each(LIVE_RUN_STATUSES)('refuses while a %s turn holds the chat', async (status) => {
      const chat = await harness.seed();
      await harness.addTurn(chat.id, status);

      expect(await harness.repository().deleteIfIdle(chat.id)).toBe('LIVE_TURN');
      expect(await harness.repository().getById(chat.id)).not.toBeNull();
    });

    /**
     * A finished turn holds nothing, so the history it left behind is not a reason to keep the
     * chat: the refusal is about work in flight, not about a chat having ever run any.
     */
    it('deletes a chat whose turns have all finished', async () => {
      const chat = await harness.seed();
      await harness.addTurn(chat.id, 'SUCCEEDED');
      await harness.addTurn(chat.id, 'CANCELLED');

      expect(await harness.repository().deleteIfIdle(chat.id)).toBe('DELETED');
      expect(await harness.repository().getById(chat.id)).toBeNull();
    });

    /**
     * A chat that is already gone is reported apart from one held by a turn. Both leave the caller
     * with nothing deleted, but only one of them is a state the user can do something about, and
     * collapsing them would answer "wait for the running turn" to somebody whose chat no longer
     * exists.
     */
    it('reports a chat that is not there apart from one held by a turn', async () => {
      expect(await harness.repository().deleteIfIdle('no-such-chat')).toBe('MISSING');
    });
  });
}
