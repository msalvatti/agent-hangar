/**
 * Exclusive ownership of what a piece of work is about to act on: a workspace, or a turn.
 *
 * Layer: utility.
 *
 * Two things write a workspace row's status: the turn that runs inside it and the collector that
 * reclaims it. Both decide from a row they read earlier, and the repository offers no conditional
 * status update that would make the decision and the write one step — so a collector acting on a
 * snapshot can destroy the container a turn claimed a moment later, and two turns of one chat can
 * both take the single workspace their chat is allowed.
 *
 * A claim closes those windows. It is taken and released without an intervening `await`, so at any
 * moment at most one holder is acting on a given workspace, and whoever holds it may re-read the
 * row and trust what it says. Work that cannot take the claim reports a conflict instead of acting
 * on a state it cannot vouch for.
 *
 * The scope is the process, which is the scope of the concurrency it guards: an instance runs one
 * worker, whose turn consumer and collector are the only writers of these rows. A deployment with
 * a second worker process would need the claim in Postgres or Redis instead, and the honest place
 * to put it would be a conditional update in the workspace repository.
 */

/** A workspace a chat's turns share; keyed by the chat, because the chat is what they contend for. */
const CHAT_KEY_PREFIX = 'chat:';

/** A workspace no chat owns — a scheduled run's, or one whose chat was deleted. */
const WORKSPACE_KEY_PREFIX = 'workspace:';

/** One execution of one turn, which its own redelivery must not join. */
const TURN_KEY_PREFIX = 'turn:';

/** What a claim identifies: a workspace, the chat whose single workspace it is, or a turn. */
export type ClaimKey = string;

/** Exclusive, non-blocking ownership of workspaces within one worker process. */
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
