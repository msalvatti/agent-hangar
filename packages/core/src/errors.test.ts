/**
 * Unit tests for the typed error classes.
 *
 * Layer: unit.
 * Goal: every error carries its literal `code`, a helpful default message, the extra fields it
 * declares, and the `instanceof` chain callers branch on.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import {
  AgentHangarError,
  ConfigError,
  IllegalTransitionError,
  InvalidCronError,
  isAgentHangarError,
  LiveWorkspaceExistsError,
  ProtocolError,
  SecretIntegrityError,
  WorkspaceImageMissing,
} from './errors.js';

describe('AgentHangarError', () => {
  /**
   * Base behaviour: the code and message are stored, the name reflects the concrete class so
   * stack traces are readable, and `cause` is forwarded to the native Error.
   */
  it('stores code, message, name and cause', () => {
    const cause = new Error('root');
    const error = new AgentHangarError('SOME_CODE', 'something happened', { cause });
    expect(error.code).toBe('SOME_CODE');
    expect(error.message).toBe('something happened');
    expect(error.name).toBe('AgentHangarError');
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
  });

  /**
   * No cause given: the `cause` property must stay absent instead of being set to `undefined`,
   * so serialisers and loggers do not print a spurious field.
   */
  it('omits cause when none is given', () => {
    const error = new AgentHangarError('X', 'y');
    expect('cause' in error).toBe(false);
  });
});

describe('subclasses', () => {
  /**
   * `WorkspaceImageMissing` must tell the operator exactly how to fix the problem — the UI shows
   * this message in a banner — and expose the image it looked for.
   */
  it('WorkspaceImageMissing names the image and the fix command', () => {
    const error = new WorkspaceImageMissing('agent-hangar/workspace:dev');
    expect(error.code).toBe('WORKSPACE_IMAGE_MISSING');
    expect(error.image).toBe('agent-hangar/workspace:dev');
    expect(error.message).toContain('agent-hangar/workspace:dev');
    expect(error.message).toContain('pnpm infra:image');
    expect(error.name).toBe('WorkspaceImageMissing');
    expect(error).toBeInstanceOf(AgentHangarError);
  });

  /**
   * `SecretIntegrityError` defaults to a message that never echoes secret material, and accepts
   * a custom message for the specific failure.
   */
  it('SecretIntegrityError has a safe default message and accepts a custom one', () => {
    expect(new SecretIntegrityError().message).toBe('Stored secret failed integrity verification.');
    const custom = new SecretIntegrityError('wrong key version');
    expect(custom.code).toBe('SECRET_INTEGRITY');
    expect(custom.message).toBe('wrong key version');
  });

  /**
   * `ProtocolError` and `ConfigError` are message-only errors with fixed codes.
   */
  it('ProtocolError and ConfigError carry their codes', () => {
    expect(new ProtocolError('bad line').code).toBe('PROTOCOL_ERROR');
    expect(new ConfigError('missing').code).toBe('CONFIG_ERROR');
    expect(new ConfigError('missing').message).toBe('missing');
  });

  /**
   * `InvalidCronError` embeds the expression and the parser reason so the settings form can show
   * both.
   */
  it('InvalidCronError embeds expression and reason', () => {
    const error = new InvalidCronError('* * *', 'expected 5 fields');
    expect(error.code).toBe('INVALID_CRON');
    expect(error.cron).toBe('* * *');
    expect(error.message).toBe('Invalid cron expression "* * *": expected 5 fields');
  });

  /**
   * `IllegalTransitionError` records entity, source and target state for the state machines.
   */
  it('IllegalTransitionError records entity and states', () => {
    const error = new IllegalTransitionError('Workspace', 'DESTROYED', 'READY');
    expect(error.code).toBe('ILLEGAL_TRANSITION');
    expect(error.entity).toBe('Workspace');
    expect(error.from).toBe('DESTROYED');
    expect(error.to).toBe('READY');
    expect(error.message).toBe('Workspace cannot transition from DESTROYED to READY.');
  });

  /**
   * `LiveWorkspaceExistsError` identifies the chat that violates "one live workspace per chat".
   */
  it('LiveWorkspaceExistsError identifies the chat', () => {
    const error = new LiveWorkspaceExistsError('chat-1');
    expect(error.code).toBe('LIVE_WORKSPACE_EXISTS');
    expect(error.chatId).toBe('chat-1');
    expect(error.message).toContain('chat-1');
  });

  /**
   * Subclasses forward `cause` through the base constructor.
   */
  it('forwards cause from subclasses', () => {
    const cause = new Error('socket closed');
    expect(new ProtocolError('eof', { cause }).cause).toBe(cause);
  });
});

describe('isAgentHangarError', () => {
  /**
   * Type guard: true for any subclass, false for foreign errors and non-errors.
   */
  it('narrows domain errors only', () => {
    expect(isAgentHangarError(new ConfigError('x'))).toBe(true);
    expect(isAgentHangarError(new Error('x'))).toBe(false);
    expect(isAgentHangarError('x')).toBe(false);
  });
});
