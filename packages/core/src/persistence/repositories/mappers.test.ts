/**
 * Unit tests for the Prisma row/enum mappers.
 *
 * Layer: unit.
 * Goal: every enum guard accepts its literals and rejects anything else; every row mapper copies
 * a fully populated row and an all-null row field-for-field; `truncateResultHead` never splits a
 * UTF-8 code point and never drops a replacement character the payload itself contains;
 * `toInputJson` drops `undefined`.
 * Mocks: none — plain object rows stand in for Prisma results (mappers do no I/O).
 */
import { describe, expect, it } from 'vitest';

import { PersistenceMappingError } from './errors.ts';
import {
  asChatStatus,
  asJobRunStatus,
  asJobRunTrigger,
  asMessageRole,
  asSecretKey,
  asToolCallStatus,
  asTurnStatus,
  asWorkspaceKind,
  asWorkspaceStatus,
  RESULT_HEAD_MAX_BYTES,
  toChat,
  toInputJson,
  toJobRun,
  toMessage,
  toScheduledJob,
  toSecretRecord,
  toToolCallLog,
  toTurn,
  toWorkspace,
  truncateResultHead,
} from './mappers.ts';

describe('enum guards', () => {
  const cases: [name: string, guard: (value: string) => string, literals: string[]][] = [
    ['asChatStatus', asChatStatus, ['ACTIVE', 'ARCHIVED']],
    ['asMessageRole', asMessageRole, ['USER', 'ASSISTANT', 'SYSTEM', 'TOOL_SUMMARY']],
    [
      'asTurnStatus',
      asTurnStatus,
      ['QUEUED', 'PREPARING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
    ],
    ['asWorkspaceKind', asWorkspaceKind, ['CHAT', 'JOB']],
    [
      'asWorkspaceStatus',
      asWorkspaceStatus,
      ['CREATING', 'READY', 'BUSY', 'STOPPING', 'DESTROYED', 'FAILED'],
    ],
    [
      'asJobRunStatus',
      asJobRunStatus,
      ['QUEUED', 'PREPARING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
    ],
    ['asJobRunTrigger', asJobRunTrigger, ['SCHEDULE', 'MANUAL']],
    ['asToolCallStatus', asToolCallStatus, ['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT']],
    ['asSecretKey', asSecretKey, ['GITHUB_PAT', 'OPENAI_API_KEY']],
  ];

  for (const [name, guard, literals] of cases) {
    describe(name, () => {
      /** Every literal of the union round-trips through the guard unchanged. */
      it(`accepts every literal of its union`, () => {
        for (const literal of literals) {
          expect(guard(literal)).toBe(literal);
        }
      });

      /** Anything outside the union throws the persistence mapping error, never a bare TypeError. */
      it('throws PersistenceMappingError on an unknown value', () => {
        expect(() => guard('BOGUS')).toThrow(PersistenceMappingError);
        expect(() => guard('BOGUS')).toThrow(`Unknown ${name.slice(2)} value: "BOGUS"`);
      });
    });
  }
});

describe('row mappers', () => {
  /** A fully populated Chat row maps every field, including a non-null archivedAt. */
  it('toChat maps a fully populated row', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const row: Parameters<typeof toChat>[0] = {
      id: 'chat-1',
      title: 'Fix the bug',
      status: 'ARCHIVED',
      repoUrl: 'https://github.com/acme/repo',
      baseBranch: 'main',
      workBranch: 'agent/chat-1',
      lastPushedSha: 'abc123',
      createdAt: now,
      updatedAt: now,
      archivedAt: now,
    };
    expect(toChat(row)).toEqual({ ...row });
  });

  /** A Chat row with every nullable column null maps those fields to null (never undefined). */
  it('toChat maps null columns to null', () => {
    const now = new Date();
    const row: Parameters<typeof toChat>[0] = {
      id: 'chat-2',
      title: 'New chat',
      status: 'ACTIVE',
      repoUrl: 'https://github.com/acme/repo',
      baseBranch: 'main',
      workBranch: null,
      lastPushedSha: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    const chat = toChat(row);
    expect(chat.workBranch).toBeNull();
    expect(chat.lastPushedSha).toBeNull();
    expect(chat.archivedAt).toBeNull();
  });

  /** Message row, including a set turnId. */
  it('toMessage maps a fully populated row', () => {
    const row: Parameters<typeof toMessage>[0] = {
      id: 'msg-1',
      chatId: 'chat-1',
      turnId: 'turn-1',
      seq: 3,
      role: 'ASSISTANT',
      content: 'hello',
      createdAt: new Date(),
    };
    expect(toMessage(row)).toEqual(row);
  });

  /** Message row with a null turnId (system/user messages outside a turn). */
  it('toMessage maps a null turnId to null', () => {
    const row: Parameters<typeof toMessage>[0] = {
      id: 'msg-2',
      chatId: 'chat-1',
      turnId: null,
      seq: 1,
      role: 'USER',
      content: 'hi',
      createdAt: new Date(),
    };
    expect(toMessage(row).turnId).toBeNull();
  });

  /** Turn row with every column populated (a finished turn). */
  it('toTurn maps a fully populated row', () => {
    const now = new Date();
    const row: Parameters<typeof toTurn>[0] = {
      id: 'turn-1',
      chatId: 'chat-1',
      workspaceId: 'ws-1',
      status: 'SUCCEEDED',
      model: 'gpt-5.6-sol',
      queueJobId: 'job-1',
      inputTokens: 10,
      outputTokens: 20,
      stepCount: 2,
      error: null,
      preparedBranch: null,
      preparedSha: null,
      queuedAt: now,
      startedAt: now,
      finishedAt: now,
    };
    expect(toTurn(row)).toEqual(row);
  });

  /** Freshly queued turn: every optional timestamp/id/token column is still null. */
  it('toTurn maps a freshly queued row with every optional column null', () => {
    const row: Parameters<typeof toTurn>[0] = {
      id: 'turn-2',
      chatId: 'chat-1',
      workspaceId: null,
      status: 'QUEUED',
      model: 'gpt-5.6-sol',
      queueJobId: null,
      inputTokens: null,
      outputTokens: null,
      stepCount: 0,
      error: null,
      preparedBranch: null,
      preparedSha: null,
      queuedAt: new Date(),
      startedAt: null,
      finishedAt: null,
    };
    const turn = toTurn(row);
    expect(turn.workspaceId).toBeNull();
    expect(turn.startedAt).toBeNull();
    expect(turn.finishedAt).toBeNull();
  });

  /** Workspace row with every column populated (a destroyed workspace). */
  it('toWorkspace maps a fully populated row', () => {
    const now = new Date();
    const row: Parameters<typeof toWorkspace>[0] = {
      id: 'ws-1',
      kind: 'CHAT',
      status: 'DESTROYED',
      chatId: 'chat-1',
      runnerKind: 'docker',
      runnerRef: 'container-1',
      image: 'agent-hangar/workspace:dev',
      repoUrl: 'https://github.com/acme/repo',
      branch: 'main',
      createdAt: now,
      readyAt: now,
      lastActiveAt: now,
      destroyedAt: now,
      failureReason: null,
    };
    expect(toWorkspace(row)).toEqual(row);
  });

  /** Freshly created workspace: chatId null (JOB kind) and every optional timestamp null. */
  it('toWorkspace maps a freshly created JOB row', () => {
    const row: Parameters<typeof toWorkspace>[0] = {
      id: 'ws-2',
      kind: 'JOB',
      status: 'CREATING',
      chatId: null,
      runnerKind: 'docker',
      runnerRef: null,
      image: 'agent-hangar/workspace:dev',
      repoUrl: 'https://github.com/acme/repo',
      branch: 'main',
      createdAt: new Date(),
      readyAt: null,
      lastActiveAt: new Date(),
      destroyedAt: null,
      failureReason: null,
    };
    const workspace = toWorkspace(row);
    expect(workspace.chatId).toBeNull();
    expect(workspace.readyAt).toBeNull();
    expect(workspace.destroyedAt).toBeNull();
  });

  /** ScheduledJob row with run times populated. */
  it('toScheduledJob maps a fully populated row', () => {
    const now = new Date();
    const row: Parameters<typeof toScheduledJob>[0] = {
      id: 'job-1',
      name: 'Nightly report',
      cron: '0 0 * * *',
      timezone: 'UTC',
      prompt: 'print date',
      repoUrl: 'https://github.com/acme/repo',
      branch: 'main',
      enabled: true,
      lastRunAt: now,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    };
    expect(toScheduledJob(row)).toEqual(row);
  });

  /** A never-run job: lastRunAt/nextRunAt null. */
  it('toScheduledJob maps a never-run row', () => {
    const row: Parameters<typeof toScheduledJob>[0] = {
      id: 'job-2',
      name: 'One-off',
      cron: '0 0 * * *',
      timezone: 'UTC',
      prompt: 'print date',
      repoUrl: 'https://github.com/acme/repo',
      branch: 'main',
      enabled: false,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const job = toScheduledJob(row);
    expect(job.lastRunAt).toBeNull();
    expect(job.nextRunAt).toBeNull();
  });

  /** JobRun row with every column populated (a finished run). */
  it('toJobRun maps a fully populated row', () => {
    const now = new Date();
    const row: Parameters<typeof toJobRun>[0] = {
      id: 'run-1',
      jobId: 'job-1',
      workspaceId: 'ws-1',
      status: 'SUCCEEDED',
      trigger: 'SCHEDULE',
      model: 'gpt-5.6-sol',
      output: 'done',
      error: null,
      workBranch: 'agent/job-1',
      lastPushedSha: 'abc1234def5678',
      inputTokens: 5,
      outputTokens: 8,
      stepCount: 1,
      scheduledFor: now,
      queuedAt: now,
      startedAt: now,
      finishedAt: now,
    };
    expect(toJobRun(row)).toEqual(row);
  });

  /** A freshly queued manual run: workspaceId and every optional timestamp/token still null. */
  it('toJobRun maps a freshly queued row', () => {
    const row: Parameters<typeof toJobRun>[0] = {
      id: 'run-2',
      jobId: 'job-1',
      workspaceId: null,
      status: 'QUEUED',
      trigger: 'MANUAL',
      model: 'gpt-5.6-sol',
      output: null,
      error: null,
      workBranch: null,
      lastPushedSha: null,
      inputTokens: null,
      outputTokens: null,
      stepCount: 0,
      scheduledFor: new Date(),
      queuedAt: new Date(),
      startedAt: null,
      finishedAt: null,
    };
    const run = toJobRun(row);
    expect(run.workspaceId).toBeNull();
    expect(run.workBranch).toBeNull();
    expect(run.lastPushedSha).toBeNull();
    expect(run.startedAt).toBeNull();
  });

  /** ToolCallLog row parented by a turn, finished successfully. */
  it('toToolCallLog maps a fully populated row parented by a turn', () => {
    const now = new Date();
    const row: Parameters<typeof toToolCallLog>[0] = {
      id: 'tc-1',
      workspaceId: 'ws-1',
      turnId: 'turn-1',
      jobRunId: null,
      callId: 'call-1',
      seq: 1,
      toolName: 'run_shell',
      args: { command: 'ls' },
      resultHead: 'file.txt',
      resultBytes: 8,
      exitCode: 0,
      status: 'SUCCEEDED',
      startedAt: now,
      finishedAt: now,
      durationMs: 42,
    };
    expect(toToolCallLog(row)).toEqual(row);
  });

  /** ToolCallLog row parented by a job run, still running. */
  it('toToolCallLog maps a running row parented by a job run', () => {
    const row: Parameters<typeof toToolCallLog>[0] = {
      id: 'tc-2',
      workspaceId: 'ws-2',
      turnId: null,
      jobRunId: 'run-1',
      callId: 'call-2',
      seq: 1,
      toolName: 'read_file',
      args: { path: 'a.txt' },
      resultHead: null,
      resultBytes: null,
      exitCode: null,
      status: 'RUNNING',
      startedAt: new Date(),
      finishedAt: null,
      durationMs: null,
    };
    const toolCall = toToolCallLog(row);
    expect(toolCall.turnId).toBeNull();
    expect(toolCall.finishedAt).toBeNull();
  });

  /** Secret row: ciphertext columns pass through as Uint8Array, unchanged. */
  it('toSecretRecord maps ciphertext, iv and authTag through unchanged', () => {
    const now = new Date();
    const row: Parameters<typeof toSecretRecord>[0] = {
      key: 'GITHUB_PAT',
      ciphertext: new Uint8Array([1, 2, 3]),
      iv: new Uint8Array([4, 5, 6]),
      authTag: new Uint8Array([7, 8, 9]),
      keyVersion: 1,
      last4: 'abcd',
      createdAt: now,
      updatedAt: now,
    };
    const record = toSecretRecord(row);
    expect(record.ciphertext).toBe(row.ciphertext);
    expect(record.iv).toBe(row.iv);
    expect(record.authTag).toBe(row.authTag);
    expect(record.key).toBe('GITHUB_PAT');
  });
});

describe('truncateResultHead', () => {
  /** Text well under the limit passes through unchanged. */
  it('returns short ASCII text unchanged', () => {
    expect(truncateResultHead('hello')).toBe('hello');
  });

  /** Text at exactly the byte limit is not truncated. */
  it('returns text at exactly the byte limit unchanged', () => {
    const text = 'a'.repeat(RESULT_HEAD_MAX_BYTES);
    expect(truncateResultHead(text)).toBe(text);
    expect(truncateResultHead(text).length).toBe(RESULT_HEAD_MAX_BYTES);
  });

  /** Text over the limit is cut to exactly the byte budget, no notice appended. */
  it('truncates ASCII text over the byte limit with no notice appended', () => {
    const text = 'a'.repeat(RESULT_HEAD_MAX_BYTES + 100);
    const result = truncateResultHead(text);
    expect(new TextEncoder().encode(result).length).toBe(RESULT_HEAD_MAX_BYTES);
    expect(result).toBe('a'.repeat(RESULT_HEAD_MAX_BYTES));
  });

  /**
   * A multi-byte character sitting exactly on the cut boundary must not be split: the whole
   * character is dropped rather than emitting an invalid half-sequence.
   */
  it('never splits a multi-byte UTF-8 code point at the cut boundary', () => {
    // One 3-byte character (€, U+20AC) repeated so the boundary falls mid-character.
    const text = '€'.repeat(RESULT_HEAD_MAX_BYTES); // 3 bytes each -> far over the limit
    const result = truncateResultHead(text);
    const bytes = new TextEncoder().encode(result);
    expect(bytes.length).toBeLessThanOrEqual(RESULT_HEAD_MAX_BYTES);
    // Re-encoding the result must reproduce it exactly - proof no half code point survived.
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(result);
  });

  /**
   * A replacement character the payload genuinely contains is data, not decoder damage, so it
   * must survive when it is the last character that fits. Inspecting decoded text cannot tell the
   * two apart and would drop it, returning less than the documented longest prefix.
   */
  it('keeps a genuine U+FFFD that ends the prefix that fits', () => {
    // 8189 ASCII bytes + a real U+FFFD (3 bytes) fills the budget exactly; the tail overflows.
    const prefix = `${'a'.repeat(RESULT_HEAD_MAX_BYTES - 3)}\uFFFD`;
    const result = truncateResultHead(`${prefix}tail`);
    expect(result).toBe(prefix);
    expect(new TextEncoder().encode(result).length).toBe(RESULT_HEAD_MAX_BYTES);
  });
});

describe('toInputJson', () => {
  /** A plain JSON-safe object round-trips unchanged. */
  it('passes a JSON-safe object through unchanged', () => {
    expect(toInputJson({ command: 'ls', args: [1, 2, 3] })).toEqual({
      command: 'ls',
      args: [1, 2, 3],
    });
  });

  /** `undefined` at the top level becomes `null` (JSON has no `undefined`). */
  it('narrows a top-level undefined to null', () => {
    expect(toInputJson(undefined)).toBeNull();
  });

  /** `undefined` nested inside an object is dropped by the JSON round trip. */
  it('drops undefined values nested inside an object', () => {
    expect(toInputJson({ a: 1, b: undefined })).toEqual({ a: 1 });
  });
});

describe('truncateResultHead at its boundary', () => {
  /**
   * The cap is the largest head that is stored whole, not the first size that is cut: measured one
   * byte early, a result that fits exactly comes back truncated, and the row then disagrees with
   * the byte count stored beside it.
   */
  it('stores a head of exactly the budget unchanged', () => {
    const text = 'x'.repeat(8192);

    expect(truncateResultHead(text)).toBe(text);
  });

  /** One byte more is cut, and cut to the budget rather than to something near it. */
  it('cuts a head one byte past the budget to the budget', () => {
    const truncated = truncateResultHead('x'.repeat(8193));

    expect(new TextEncoder().encode(truncated)).toHaveLength(8192);
  });
});
