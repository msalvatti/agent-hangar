/**
 * Exclusive ownership of what a piece of work is about to act on: a workspace, or a turn.
 *
 * Layer: utility.
 *
 * Two things write a workspace row's status: the turn that runs inside it and the collector that
 * reclaims it. Both decide from a row they read earlier, and either can act in between.
 *
 * What arbitrates that is not this register. Every write that commits one of them to a workspace —
 * the turn taking it `BUSY`, the teardown moving it to `STOPPING`, the reconciler closing it out —
 * is a conditional write naming the status its caller read, so the database decides which one wins
 * and the loser is told. That holds however many worker processes run.
 *
 * This register is the cheaper half, and it is about work rather than correctness: it is taken and
 * released without an intervening `await`, so within one process a collector does not snapshot a
 * container and write a chat's restore note only to find, at the conditional write, that the turn
 * consumer beside it took the workspace first. Losing a claim therefore means "somebody here is
 * already on it", never "the row says something other than what I read".
 *
 * Turns are the one thing claimed for its own sake rather than as an optimisation: a redelivery
 * must not join the execution it is a copy of, and no row status distinguishes those two.
 */

/** A workspace a chat's turns share; keyed by the chat, because the chat is what they contend for. */
const CHAT_KEY_PREFIX = 'chat:';

/** A workspace no chat owns — a scheduled run's, or one whose chat was deleted. */
const WORKSPACE_KEY_PREFIX = 'workspace:';

/** One execution of one turn, which its own redelivery must not join. */
const TURN_KEY_PREFIX = 'turn:';

/** What a claim identifies: a workspace, the chat whose single workspace it is, or a turn. */
export type ClaimKey = string;

/** Exclusive, non-blocking ownership of workspaces and turn executions within one worker process. */
export interface WorkspaceClaims {
  /**
   * Takes exclusive ownership of a key.
   *
   * @param key - What to claim.
   * @returns `true` when the caller now owns it, `false` when somebody else already does.
   */
  claim(key: ClaimKey): boolean;
  /**
   * Gives a key back.
   *
   * @param key - The key this caller claimed.
   */
  release(key: ClaimKey): void;
}

/**
 * The key of the workspace a chat's turns share.
 *
 * @param chatId - `Chat.id`.
 * @returns The claim key.
 */
export function chatClaimKey(chatId: string): ClaimKey {
  return `${CHAT_KEY_PREFIX}${chatId}`;
}

/**
 * The key of one turn's execution.
 *
 * Stalled-job recovery redelivers a job whose first delivery may still be running here, and the
 * second delivery must leave that execution alone rather than reporting a conflict against the very
 * turn it is a copy of. Keying the execution — not the workspace it will use — is what tells
 * "another turn of this chat" apart from "this turn, delivered twice".
 *
 * @param turnId - `Turn.id`.
 * @returns The claim key.
 */
export function turnClaimKey(turnId: string): ClaimKey {
  return `${TURN_KEY_PREFIX}${turnId}`;
}

/**
 * The key of an existing workspace row.
 *
 * A chat workspace is keyed by its chat so that a turn — which knows the chat long before it knows
 * which workspace it will run in — contends with the collector for the same key.
 *
 * @param workspace - The row.
 * @returns The claim key.
 */
export function workspaceClaimKey(workspace: { id: string; chatId: string | null }): ClaimKey {
  return workspace.chatId === null
    ? `${WORKSPACE_KEY_PREFIX}${workspace.id}`
    : chatClaimKey(workspace.chatId);
}

/**
 * Creates the claim register of one worker process.
 *
 * @returns A register in which every key is free.
 */
export function createWorkspaceClaims(): WorkspaceClaims {
  const held = new Set<ClaimKey>();
  return {
    claim: (key) => {
      if (held.has(key)) {
        return false;
      }
      held.add(key);
      return true;
    },
    release: (key) => {
      held.delete(key);
    },
  };
}
