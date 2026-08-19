/**
 * Unit tests for the restore-context and turn-request builders.
 *
 * Layer: unit.
 * Goal: every field of the restore context is filled from the chat, a reuse decision skips the
 * clone and the notice, a create decision clones and adds the notice exactly once, overrides
 * merge over the defaults, the result satisfies the frozen protocol schema, and no failure path
 * echoes conversation content.
 * Mocks: none; `FakeClock` supplies the current instant and the canaries stand in for credentials.
 */
import { describe, expect, it } from 'vitest';

import { turnRequestSchema } from '../agent-protocol/schemas.js';
import { ProtocolError } from '../errors.js';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '../testing/canaries.js';
import { FakeClock } from '../testing/fake-clock.js';
import type { EnsureWorkspaceDecision, RestoreContext } from '../workspace/types.js';

import { buildJobTurnRequest, buildRestoreContext, buildTurnRequest } from './build.js';
import type { ChatRestoreSource } from './build.js';
import type { HistoryMessage } from './history.js';
import { DEFAULT_CHAT_TURN_LIMITS, DEFAULT_JOB_TURN_LIMITS } from './limits.js';
import { RESTORATION_NOTICE_PREFIX, restorationNotice } from './notice.js';

/** Instant every builder call is anchored to. */
const NOW = new FakeClock().now();

/** A chat that has already pushed work, so the restore path has a branch and a commit. */
const PUSHED_CHAT: ChatRestoreSource = {
  id: '018f3a2b-6c1d-7f00-9a11-2233445566aa',
  repoUrl: 'https://github.com/acme/api',
  baseBranch: 'main',
  workBranch: 'agent/018f3a2b',
  lastPushedSha: 'abc1234def5678',
};

/** A chat that has not pushed anything yet. */
const FRESH_CHAT: ChatRestoreSource = {
  ...PUSHED_CHAT,
  workBranch: null,
  lastPushedSha: null,
};

/** History of a short chat. */
const MESSAGES: HistoryMessage[] = [
  { seq: 1, role: 'USER', content: 'add auth' },
  { seq: 2, role: 'ASSISTANT', content: 'on it' },
];

/**
 * Builds a create decision carrying a restore context for a chat.
 *
 * @param chat - Chat the context describes.
 * @param messages - History the context carries.
 * @returns The decision the worker would have taken.
 */
function createDecision(chat: ChatRestoreSource, messages = MESSAGES): EnsureWorkspaceDecision {
  const restore: RestoreContext = buildRestoreContext({ chat, messages, now: NOW });
  return { action: 'create', clone: true, restore };
}

/** A reuse decision; the workspace id is irrelevant to the request. */
const REUSE: EnsureWorkspaceDecision = { action: 'reuse', workspaceId: 'ws-1' };

describe('buildRestoreContext', () => {
  /**
   * Every field the contract declares is populated from the chat row plus the windowed history,
   * so a recreated workspace has everything it needs without a second query.
   */
  it('fills every field for a chat with pushed work', () => {
    expect(buildRestoreContext({ chat: PUSHED_CHAT, messages: MESSAGES, now: NOW })).toEqual({
      repoUrl: 'https://github.com/acme/api',
      baseBranch: 'main',
      workBranch: 'agent/018f3a2b',
      lastPushedSha: 'abc1234def5678',
      messages: MESSAGES,
      restoredAt: NOW,
    });
  });

  /**
   * Without a work branch there is nothing to check the commit out on, so the commit is dropped
   * rather than handed to a runtime that would compare against something it never fetched.
   */
  it('drops the pushed commit when there is no work branch', () => {
    const context = buildRestoreContext({
      chat: { ...FRESH_CHAT, lastPushedSha: 'abc1234' },
      messages: MESSAGES,
      now: NOW,
    });
    expect(context.workBranch).toBeNull();
    expect(context.lastPushedSha).toBeNull();
  });

  /**
   * The context carries the windowed history, not the whole chat, so a long chat does not have to
   * be re-windowed by every consumer.
   */
  it('carries the windowed history', () => {
    const messages: HistoryMessage[] = [
      { seq: 1, role: 'USER', content: 'add auth' },
      { seq: 2, role: 'ASSISTANT', content: 'one' },
      { seq: 3, role: 'ASSISTANT', content: 'two' },
    ];
    const context = buildRestoreContext({
      chat: PUSHED_CHAT,
      messages,
      now: NOW,
      budget: { maxMessages: 2, maxChars: 1000 },
    });
    expect(context.messages.map((entry) => entry.seq)).toEqual([1, 3]);
  });
});

describe('buildTurnRequest', () => {
  /**
   * A continued chat reuses its container: nothing is cloned, no commit is verified and no notice
   * is added, because nothing about the workspace changed.
   */
  it('builds a reuse turn without clone, commit or notice', () => {
    const request = buildTurnRequest({
      turnId: 'turn-1',
      model: 'gpt-5',
      instructions: 'be careful',
      chat: PUSHED_CHAT,
      messages: MESSAGES,
      decision: REUSE,
    });
    expect(request.prepare).toEqual({ clone: false });
    expect(request.repo.expectedHeadSha).toBeUndefined();
    expect(request.items).toEqual([
      { role: 'user', content: 'add auth' },
      { role: 'assistant', content: 'on it' },
    ]);
    expect(request.protocolVersion).toBe(1);
    expect(request.turnId).toBe('turn-1');
    expect(request.model).toBe('gpt-5');
    expect(request.instructions).toBe('be careful');
  });

  /**
   * A workspace the idle collector reaped leaves no notice in the history, so the builder appends
   * one and the model learns its files are gone; the pushed commit becomes the HEAD to verify.
   */
  it('clones, verifies the commit and appends a notice on recreation', () => {
    const decision = createDecision(PUSHED_CHAT);
    const request = buildTurnRequest({
      turnId: 'turn-1',
      model: 'gpt-5',
      instructions: '',
      chat: PUSHED_CHAT,
      messages: MESSAGES,
      decision,
    });
    expect(request.prepare).toEqual({ clone: true });
    expect(request.repo.expectedHeadSha).toBe('abc1234def5678');
    expect(request.items.at(-1)).toEqual({
      role: 'system',
      content: restorationNotice({ at: NOW, workBranch: 'agent/018f3a2b' }),
    });
  });

  /**
   * The very first turn of a chat also takes the `create` branch — there is no live workspace
   * because there never was one — but nothing was lost, so it must not be told that "uncommitted
   * changes from the previous workspace are gone". Spec 04 flow (a) creates the initial workspace
   * without a restoration notice; the clone still happens, because a fresh container has no repo.
   */
  it('does not announce a recreation on the first turn of a chat', () => {
    const messages: HistoryMessage[] = [{ seq: 1, role: 'USER', content: 'add auth' }];
    const request = buildTurnRequest({
      turnId: 'turn-1',
      model: 'gpt-5',
      instructions: '',
      chat: FRESH_CHAT,
      messages,
      decision: createDecision(FRESH_CHAT, messages),
    });
    expect(request.prepare).toEqual({ clone: true });
    expect(request.items).toEqual([{ role: 'user', content: 'add auth' }]);
    expect(JSON.stringify(request.items)).not.toContain(RESTORATION_NOTICE_PREFIX);
  });

  /**
   * Anything beyond the opening user message means a turn already ran in a container, so the
   * recreation after it does earn the notice — a tool summary counts just as an assistant reply
   * does. This is the other half of the "did a workspace exist?" branch.
   */
  it('announces a recreation when the history carries more than the opening message', () => {
    const messages: HistoryMessage[] = [
      { seq: 1, role: 'USER', content: 'add auth' },
      { seq: 2, role: 'TOOL_SUMMARY', content: 'ran `ls` → exit 0 (1 s)' },
    ];
    const request = buildTurnRequest({
      turnId: 'turn-1',
      model: 'gpt-5',
      instructions: '',
      chat: PUSHED_CHAT,
      messages,
      decision: createDecision(PUSHED_CHAT, messages),
    });
    expect(request.items.at(-1)).toEqual({
      role: 'system',
      content: restorationNotice({ at: NOW, workBranch: 'agent/018f3a2b' }),
    });
  });

  /**
   * The archive-then-restore flow already inserted a notice as a stored message, so a second one
   * would tell the model the same thing twice with two different timestamps.
   */
  it('does not repeat a notice the history already carries', () => {
    const messages: HistoryMessage[] = [
      { seq: 1, role: 'USER', content: 'add auth' },
      { seq: 2, role: 'SYSTEM', content: restorationNotice({ at: NOW, workBranch: 'agent/x' }) },
    ];
    const request = buildTurnRequest({
      turnId: 'turn-1',
      model: 'gpt-5',
      instructions: '',
      chat: PUSHED_CHAT,
      messages,
      decision: createDecision(PUSHED_CHAT, messages),
    });
    expect(request.items).toHaveLength(2);
    expect(request.items.filter((item) => 'role' in item && item.role === 'system')).toHaveLength(
      1,
    );
  });

  /**
   * A system message that is not a notice — the archive note, for instance — does not suppress the
   * notice the recreated workspace needs.
   */
  it('appends a notice when the last system message is something else', () => {
    const messages: HistoryMessage[] = [
      { seq: 1, role: 'USER', content: 'add auth' },
      { seq: 2, role: 'SYSTEM', content: 'Workspace archived; no uncommitted changes.' },
    ];
    const request = buildTurnRequest({
      turnId: 'turn-1',
      model: 'gpt-5',
      instructions: '',
      chat: PUSHED_CHAT,
      messages,
      decision: createDecision(PUSHED_CHAT, messages),
    });
    expect(request.items).toHaveLength(3);
  });

  /**
   * Without a pushed commit there is nothing to verify, so the optional field is absent rather
   * than present and empty, which the schema would reject.
   */
  it('omits the expected commit when nothing was pushed', () => {
    const request = buildTurnRequest({
      turnId: 'turn-1',
      model: 'gpt-5',
      instructions: '',
      chat: FRESH_CHAT,
      messages: MESSAGES,
      decision: createDecision(FRESH_CHAT),
    });
    expect(request.repo.expectedHeadSha).toBeUndefined();
    expect(Object.hasOwn(request.repo, 'expectedHeadSha')).toBe(false);
  });

  /**
   * A chat that has not pushed yet still needs a branch to commit to, derived from its id.
   */
  it('derives the work branch when the chat has none', () => {
    const request = buildTurnRequest({
      turnId: 'turn-1',
      model: 'gpt-5',
      instructions: '',
      chat: FRESH_CHAT,
      messages: MESSAGES,
      decision: REUSE,
    });
    expect(request.repo.workBranch).toBe('agent/018f3a2b');
  });

  /**
   * Limits default to the chat values and an override replaces only the field it names, so a
   * caller cannot accidentally drop the other three ceilings.
   */
  it('merges limit overrides over the defaults', () => {
    const base = {
      turnId: 'turn-1',
      model: 'gpt-5',
      instructions: '',
      chat: PUSHED_CHAT,
      messages: MESSAGES,
      decision: REUSE,
    };
    expect(buildTurnRequest(base).limits).toEqual(DEFAULT_CHAT_TURN_LIMITS);
    expect(buildTurnRequest({ ...base, limits: { maxSteps: 5 } }).limits).toEqual({
      ...DEFAULT_CHAT_TURN_LIMITS,
      maxSteps: 5,
    });
  });

  /**
   * A budget is forwarded to the window, so a caller can shrink the history for a cheap model.
   */
  it('forwards the history budget', () => {
    const messages: HistoryMessage[] = [
      { seq: 1, role: 'USER', content: 'add auth' },
      { seq: 2, role: 'ASSISTANT', content: 'one' },
      { seq: 3, role: 'ASSISTANT', content: 'two' },
    ];
    const request = buildTurnRequest({
      turnId: 'turn-1',
      model: 'gpt-5',
      instructions: '',
      chat: PUSHED_CHAT,
      messages,
      decision: REUSE,
      budget: { maxMessages: 2, maxChars: 1000 },
    });
    expect(request.items).toHaveLength(3);
  });

  /**
   * The frozen schema is the contract with the runtime, so the builder's output must satisfy it
   * without any further massaging.
   */
  it('produces a request the protocol schema accepts', () => {
    const request = buildTurnRequest({
      turnId: 'turn-1',
      model: 'gpt-5',
      instructions: '',
      chat: PUSHED_CHAT,
      messages: MESSAGES,
      decision: createDecision(PUSHED_CHAT),
    });
    expect(turnRequestSchema.safeParse(request).success).toBe(true);
  });

  /**
   * Drift from the schema must fail on the host, where the error is readable, rather than inside
   * the container where the only symptom is a non-zero exit.
   */
  it('rejects a request the schema refuses', () => {
    const build = (): unknown =>
      buildTurnRequest({
        turnId: 'turn-1',
        model: '',
        instructions: '',
        chat: PUSHED_CHAT,
        messages: MESSAGES,
        decision: REUSE,
      });
    expect(build).toThrow(ProtocolError);
    expect(build).toThrow(/model/);
  });
});

describe('buildJobTurnRequest', () => {
  /**
   * A scheduled run carries no history: its single user message is the job's prompt, which is what
   * makes two runs of the same job comparable.
   */
  it('builds a single-prompt request in a fresh workspace', () => {
    const request = buildJobTurnRequest({
      runId: '018f3a2b-6c1d-7f00-9a11-2233445566aa',
      model: 'gpt-5',
      instructions: 'nightly',
      job: { repoUrl: 'https://github.com/acme/api', branch: 'develop', prompt: 'run the tests' },
    });
    expect(request.items).toEqual([{ role: 'user', content: 'run the tests' }]);
    expect(request.prepare).toEqual({ clone: true });
    expect(request.turnId).toBe('018f3a2b-6c1d-7f00-9a11-2233445566aa');
    expect(request.repo).toEqual({
      url: 'https://github.com/acme/api',
      baseBranch: 'develop',
      workBranch: 'agent/job-018f3a2b',
    });
    expect(request.limits).toEqual(DEFAULT_JOB_TURN_LIMITS);
  });

  /**
   * Job limits are overridable the same way chat limits are.
   */
  it('merges limit overrides over the job defaults', () => {
    const request = buildJobTurnRequest({
      runId: 'run-1',
      model: 'gpt-5',
      instructions: '',
      job: { repoUrl: 'https://github.com/acme/api', branch: 'main', prompt: 'x' },
      limits: { maxTurnMs: 60_000 },
    });
    expect(request.limits).toEqual({ ...DEFAULT_JOB_TURN_LIMITS, maxTurnMs: 60_000 });
  });
});

describe('credential containment', () => {
  /**
   * Conversation history is agent and tool output: redaction runs before it is stored, but a value
   * that slipped through must not gain a second escape route here. A validation failure therefore
   * reports field paths and issue codes only, never the values — proven with history, a prompt and
   * a repository URL that all carry canaries.
   */
  it('keeps conversation content out of the validation error', () => {
    expect.assertions(4);
    const messages: HistoryMessage[] = [
      { seq: 1, role: 'USER', content: `deploy with ${GITHUB_CANARY}` },
      {
        seq: 2,
        role: 'TOOL_SUMMARY',
        content: `ran \`export KEY=${OPENAI_CANARY}\` → exit 0 (1 s)`,
      },
    ];
    try {
      buildTurnRequest({
        turnId: 'turn-1',
        model: '',
        instructions: `use ${OPENAI_CANARY}`,
        chat: PUSHED_CHAT,
        messages,
        decision: REUSE,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      const failure = error as ProtocolError;
      expect(() => {
        assertNoCanary(failure.message);
      }).not.toThrow();
      expect(failure.message).not.toContain('deploy with');
      expect(failure.message).toContain('model');
    }
  });

  /**
   * The repository URL schema rejects a credential-bearing URL, so the one input whose rejection
   * proves a token is present is also the one whose value must never reach the message. This is
   * where reporting field paths instead of values stops being defensive and starts being load
   * bearing: a chat row that somehow held `user:token@` fails here, and the token stays put.
   */
  it('keeps a credential-bearing repository URL out of the validation error', () => {
    expect.assertions(3);
    try {
      buildTurnRequest({
        turnId: 'turn-1',
        model: 'gpt-5',
        instructions: '',
        chat: {
          ...PUSHED_CHAT,
          repoUrl: `https://x-access-token:${GITHUB_CANARY}@github.com/acme/api`,
        },
        messages: MESSAGES,
        decision: REUSE,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      const failure = error as ProtocolError;
      expect(() => {
        assertNoCanary(failure.message);
      }).not.toThrow();
      expect(failure.message).toContain('repo.url');
    }
  });

  /**
   * The same containment applies to a scheduled run, whose prompt is user-supplied text that could
   * equally hold a pasted credential.
   */
  it('keeps a job prompt out of the validation error', () => {
    expect.assertions(2);
    try {
      buildJobTurnRequest({
        runId: 'run-1',
        model: '',
        instructions: '',
        job: {
          repoUrl: 'https://github.com/acme/api',
          branch: 'main',
          prompt: `publish with ${GITHUB_CANARY}`,
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect(() => {
        assertNoCanary((error as ProtocolError).message);
      }).not.toThrow();
    }
  });
});
