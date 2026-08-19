/**
 * In-memory `ToolCallLogRepository` and `SecretRepository`.
 *
 * Layer: test double.
 */
import type { SecretRecord, ToolCallLog } from '../../persistence/entities.js';
import type {
  FinishToolCallInput,
  SecretRepository,
  StartToolCallInput,
  ToolCallLogRepository,
} from '../../persistence/ports.js';
import { SECRET_KEYS } from '../../secrets/types.js';
import type { SecretEnvelope, SecretKey, SecretStatus } from '../../secrets/types.js';

import type { InMemoryStore } from './store.js';

/** Tool-call log rows. */
export class InMemoryToolCallLogRepository implements ToolCallLogRepository {
  constructor(private readonly store: InMemoryStore) {}

  async start(input: StartToolCallInput): Promise<ToolCallLog> {
    const toolCall: ToolCallLog = {
      id: this.store.newId(),
      workspaceId: input.workspaceId,
      turnId: input.turnId ?? null,
      jobRunId: input.jobRunId ?? null,
      callId: input.callId,
      seq: input.seq,
      toolName: input.toolName,
      args: input.args,
      resultHead: null,
      resultBytes: null,
      exitCode: null,
      status: 'RUNNING',
      startedAt: this.store.now(),
      finishedAt: null,
      durationMs: null,
    };
    this.store.toolCalls.set(toolCall.id, toolCall);
    return { ...toolCall };
  }

  async finish(id: string, input: FinishToolCallInput): Promise<ToolCallLog> {
    const toolCall = this.store.require(this.store.toolCalls, 'ToolCallLog', id);
    Object.assign(toolCall, {
      status: input.status,
      exitCode: input.exitCode,
      resultHead: input.resultHead,
      resultBytes: input.resultBytes,
      durationMs: input.durationMs,
      finishedAt: this.store.now(),
    });
    return { ...toolCall };
  }

  async listByTurn(turnId: string): Promise<ToolCallLog[]> {
    return this.sorted((toolCall) => toolCall.turnId === turnId);
  }

  async listByJobRun(jobRunId: string): Promise<ToolCallLog[]> {
    return this.sorted((toolCall) => toolCall.jobRunId === jobRunId);
  }

  private sorted(predicate: (toolCall: ToolCallLog) => boolean): ToolCallLog[] {
    return [...this.store.toolCalls.values()]
      .filter(predicate)
      .sort((a, b) => a.seq - b.seq)
      .map((toolCall) => ({ ...toolCall }));
  }
}

/** Secret rows: one per key, append-or-replace; never hold plaintext. */
export class InMemorySecretRepository implements SecretRepository {
  constructor(private readonly store: InMemoryStore) {}

  async upsert(key: SecretKey, envelope: SecretEnvelope): Promise<void> {
    const existing = this.store.secrets.get(key);
    const now = this.store.now();
    this.store.secrets.set(key, {
      key,
      ...envelope,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async get(key: SecretKey): Promise<SecretRecord | null> {
    const record = this.store.secrets.get(key);
    return record === undefined ? null : { ...record };
  }

  async remove(key: SecretKey): Promise<void> {
    this.store.secrets.delete(key);
  }

  async status(): Promise<Record<SecretKey, SecretStatus>> {
    const result = {} as Record<SecretKey, SecretStatus>;
    for (const key of SECRET_KEYS) {
      const record = this.store.secrets.get(key);
      result[key] =
        record === undefined
          ? { set: false }
          : { set: true, last4: record.last4, updatedAt: record.updatedAt };
    }
    return result;
  }
}
