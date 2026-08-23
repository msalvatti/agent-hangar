/** @vitest-environment node */
/**
 * Unit tests for the guards every write route starts with.
 *
 * Layer: unit.
 * Goal: what each refusal tells the user, and the totals recorded for work that never ran. These
 * sentences are the whole of what a page shows when a request is declined, and they are written
 * out here rather than compared against the constants they came from.
 * Mocks: the `bullmq` module; everything else is a real core double.
 */
import { describe, expect, it, vi } from 'vitest';

import { createTestContainer } from '../testing/test-container';

import {
  CLAIM_RELEASED,
  LIVE_TURN_REFUSAL,
  NO_USAGE,
  requireNoLiveTurn,
  requireSecrets,
  requireSoleClaim,
  requireStillActive,
} from './guards';

vi.mock('bullmq', () => import('../testing/fake-queue'));

/** A repository URL the contracts accept. */
const REPO_URL = 'https://github.com/acme/widgets';

/** Seeds a chat with no turns. */
async function seedChat(harness: ReturnType<typeof createTestContainer>): Promise<string> {
  const chat = await harness.doubles.repos.chats.create({
    title: 'Task',
    repoUrl: REPO_URL,
    baseBranch: 'main',
  });
  return chat.id;
}

describe('requireSecrets', () => {
  /**
   * The refusal names the credentials that are missing, in the order the turn needs them, and
   * separates them so a user reading it can act on both. Run together, two keys read as one name
   * nobody has heard of.
   */
  it.each([
    [['GITHUB_PAT', 'OPENAI_API_KEY'], 'GITHUB_PAT, OPENAI_API_KEY'],
    [['OPENAI_API_KEY'], 'OPENAI_API_KEY'],
    [['GITHUB_PAT'], 'GITHUB_PAT'],
  ])('names %s in the refusal', async (missing, listed) => {
    const harness = createTestContainer();
    for (const key of missing) {
      await harness.doubles.secrets.remove(key as 'GITHUB_PAT');
    }

    await expect(requireSecrets(harness.container)).rejects.toMatchObject({
      code: 'SECRETS_MISSING',
      message: `Configure the missing credentials in Settings: ${listed}`,
    });
  });

  /**
   * With both configured there is nothing to refuse.
   */
  it('says nothing when both credentials are configured', async () => {
    const harness = createTestContainer();

    await expect(requireSecrets(harness.container)).resolves.toBeUndefined();
  });
});

describe('what a refused request is told', () => {
  /**
   * A chat that went while the request was in flight, and one that was archived, are different
   * things to say: the first is gone for good, the second comes back with one click.
   */
  it('tells a deleted chat apart from one archived under the request', async () => {
    const harness = createTestContainer();
    const chatId = await seedChat(harness);

    await expect(requireStillActive(harness.container, 'no-such-chat')).rejects.toMatchObject({
      message: 'Chat not found',
    });

    await harness.doubles.repos.chats.setStatus(chatId, 'ARCHIVED');
    await expect(requireStillActive(harness.container, chatId)).rejects.toMatchObject({
      code: 'CHAT_ARCHIVED',
      message: 'The chat was archived while the request was sent',
    });
  });

  /**
   * A live turn refuses the next one, and the sentence says what to do about it — waiting or
   * cancelling are the only two ways out, and neither is obvious from a bare conflict.
   */
  it('says how to get past a live turn', async () => {
    const harness = createTestContainer();
    const chatId = await seedChat(harness);
    await harness.doubles.repos.turns.create({ chatId, model: 'test-model' });

    await expect(requireNoLiveTurn(harness.container, chatId)).rejects.toMatchObject({
      code: 'TURN_IN_PROGRESS',
      message: 'Wait for the running turn to finish or cancel it',
    });
    expect(LIVE_TURN_REFUSAL).toBe('Wait for the running turn to finish or cancel it');
  });

  /**
   * Two requests reaching the same chat at the same moment: the one that sees a rival gives up and
   * is told to try again, which is the difference between this and the refusal above — nothing is
   * running yet, so waiting is not the advice.
   */
  it('tells the loser of a simultaneous claim to try again', async () => {
    const harness = createTestContainer();
    const chatId = await seedChat(harness);
    const mine = await harness.doubles.repos.turns.create({ chatId, model: 'test-model' });
    await harness.doubles.repos.turns.create({ chatId, model: 'test-model' });

    await expect(requireSoleClaim(harness.container, chatId, mine.id)).rejects.toMatchObject({
      code: 'TURN_IN_PROGRESS',
      message: 'Another request claimed this chat at the same moment; try it again',
    });
  });

  /**
   * And the caller's own claim is not a rival: a request that saw only its own turn proceeds.
   */
  it('does not count the caller’s own claim', async () => {
    const harness = createTestContainer();
    const chatId = await seedChat(harness);
    const mine = await harness.doubles.repos.turns.create({ chatId, model: 'test-model' });

    await expect(requireSoleClaim(harness.container, chatId, mine.id)).resolves.toBeUndefined();
  });
});

describe('what is recorded for work that never ran', () => {
  /**
   * A turn closed before it started consumed nothing, and the repositories require the totals
   * either way. Recorded as an empty object, the row would carry `null` counts and the UI would
   * render a turn whose cost it cannot state.
   */
  it('records zero of everything', () => {
    expect(NO_USAGE).toStrictEqual({ inputTokens: 0, outputTokens: 0, stepCount: 0 });
  });

  /**
   * And the error on such a turn says why it ended, which is the only thing distinguishing it from
   * one the user cancelled.
   */
  it('says why a claim was released', () => {
    expect(CLAIM_RELEASED).toBe('Released: another request claimed the chat at the same moment');
  });
});
