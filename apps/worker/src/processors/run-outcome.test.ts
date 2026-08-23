/**
 * Unit tests for the net that closes a turn nothing else reported.
 *
 * Layer: unit.
 * Goal: a turn still running when its delivery ended is failed with the text the user reads, a
 * turn that already reached a terminal status is left exactly as it is, a turn that is no longer
 * there is not written to at all, and a failure of this net names itself in the log instead of
 * replacing the failure that brought the caller here.
 * Mocks: `setupProcessorContainer`'s in-memory repositories and publisher.
 */
import { describe, expect, it, vi } from 'vitest';

import { seedChatWithTurn, setupProcessorContainer } from '../testing/index.js';

import { endUnreportedTurn } from './run-outcome.js';

/** The records the container collected, parsed back from the lines pino wrote. */
function records(logs: string[]): Record<string, unknown>[] {
  return logs.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('endUnreportedTurn', () => {
  /**
   * A turn whose delivery ended before anything recorded an outcome is failed, and the text says
   * what happened to it. This sentence is the whole of what the user is told about a turn that
   * simply stopped, so it is written out here rather than read from the module that produces it.
   */
  it('fails a turn its delivery never finished, saying so', async () => {
    const container = setupProcessorContainer();
    const { turn } = await seedChatWithTurn(container);

    await endUnreportedTurn(container, turn.id);

    const finished = await container.repos.turns.get(turn.id);
    expect(finished).toMatchObject({
      status: 'FAILED',
      error: 'worker error: the worker stopped before the turn finished',
    });
  });

  /**
   * A turn that already has an outcome keeps it. This net runs after failures that wrote their own
   * reason, and the reason the runtime reported is the one the user is owed — overwriting it with
   * "the worker stopped" would replace every diagnosis with the same sentence.
   */
  it('leaves a turn that already reached an outcome alone', async () => {
    const container = setupProcessorContainer();
    const { turn } = await seedChatWithTurn(container);
    await container.repos.turns.finish(
      turn.id,
      'FAILED',
      { inputTokens: 1, outputTokens: 2, stepCount: 1 },
      'runtime_exit: the container ran out of memory',
    );

    await endUnreportedTurn(container, turn.id);

    expect(await container.repos.turns.get(turn.id)).toMatchObject({
      error: 'runtime_exit: the container ran out of memory',
    });
  });

  /**
   * A turn that is no longer there is not written to. The row can be deleted with its chat while a
   * delivery is in flight, and a net that tried to fail it anyway would turn a tidy ending into a
   * logged error about a row nobody expects to exist.
   */
  it('writes nothing for a turn that is gone', async () => {
    const container = setupProcessorContainer();
    const finish = vi.spyOn(container.repos.turns, 'finish');

    await endUnreportedTurn(container, 'turn-that-never-existed');

    expect(finish).not.toHaveBeenCalled();
    expect(container.logs).toHaveLength(0);
  });

  /**
   * When the net itself cannot write, it says so and returns. The caller is on its way to
   * rethrowing the failure that brought it here, and that is the failure the operator must see —
   * so this one is described into the log instead, named down to the turn it was about. A line
   * that carried neither the turn nor the classification would leave an operator with a sentence
   * they cannot act on, and the driver's own message may not be repeated: it is built from the
   * connection string, password included.
   */
  it('describes a failure of its own without replacing the caller’s', async () => {
    const container = setupProcessorContainer();
    const { turn } = await seedChatWithTurn(container);
    vi.spyOn(container.repos.turns, 'finish').mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    );

    await expect(endUnreportedTurn(container, turn.id)).resolves.toBeUndefined();

    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'recording the outcome of a turn its delivery never finished failed',
        failure: 'ECONNREFUSED',
        turnId: turn.id,
      }),
    );
    expect(container.logs.join('')).not.toContain('127.0.0.1:5432');
  });
});
