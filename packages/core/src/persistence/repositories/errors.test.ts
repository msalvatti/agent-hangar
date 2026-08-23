/**
 * Unit tests for `PersistenceMappingError` and the re-exported shared error kinds.
 *
 * Layer: unit.
 * Goal: every persistence error carries the right `code`, extends `AgentHangarError`, and keeps
 * `name` equal to its class name.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { AgentHangarError } from '../../errors.ts';

import {
  LiveWorkspaceExistsError,
  NotFoundError,
  PersistenceMappingError,
  UniqueViolationError,
  WorkspaceKindMismatchError,
} from './errors.ts';

describe('PersistenceMappingError', () => {
  /** New error kind of this layer: carries a stable code and the detail message verbatim. */
  it('carries code PERSISTENCE_MAPPING, the detail message and extends AgentHangarError', () => {
    const error = new PersistenceMappingError('Unknown ChatStatus value: "BOGUS"');
    expect(error).toBeInstanceOf(AgentHangarError);
    expect(error.code).toBe('PERSISTENCE_MAPPING');
    expect(error.name).toBe('PersistenceMappingError');
    expect(error.message).toBe('Unknown ChatStatus value: "BOGUS"');
  });

  /** The optional `cause` is forwarded like every other AgentHangarError subclass. */
  it('forwards an optional cause', () => {
    const cause = new Error('root cause');
    const error = new PersistenceMappingError('bad value', { cause });
    expect(error.cause).toBe(cause);
  });
});

describe('re-exported shared errors', () => {
  /** These three are the module's single import surface for repository code (see file header). */
  it('re-exports NotFoundError, LiveWorkspaceExistsError and UniqueViolationError unchanged', () => {
    expect(new NotFoundError('Chat', 'c1').code).toBe('NOT_FOUND');
    expect(new LiveWorkspaceExistsError('c1').code).toBe('LIVE_WORKSPACE_EXISTS');
    expect(new UniqueViolationError('JobRun', 'workspaceId').code).toBe('UNIQUE_VIOLATION');
  });
});

describe('what a workspace-kind mismatch says', () => {
  /**
   * The message is the whole of what an operator gets: which workspace, what it is, and what was
   * needed. A run pointed at a chat's workspace would otherwise destroy a filesystem the chat is
   * still using, and the report of that near miss has to name all three.
   */
  it('names the workspace, the kind it holds and the kind that was required', () => {
    const error = new WorkspaceKindMismatchError('ws-1', 'JOB', 'CHAT');

    expect(error.message).toBe('workspace ws-1 is a CHAT workspace, and a JOB one was required');
    expect(error.workspaceId).toBe('ws-1');
    // The code is what a caller branches on rather than matching the message.
    expect(error.code).toBe('WORKSPACE_KIND_MISMATCH');
  });
});
