/**
 * Unit tests for the workspace-busy error.
 *
 * Layer: unit.
 * Goal: the error carries a stable code and the workspace and status it refused, and its message
 * tells the operator what resolves it.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { AgentHangarError } from '../errors.js';

import { WorkspaceBusyError } from './errors.js';

describe('WorkspaceBusyError', () => {
  /**
   * The code is what the API maps to a response; the fields are what the worker branches on when
   * deciding whether stalled recovery applies.
   */
  it('carries the code, the workspace and the status', () => {
    const error = new WorkspaceBusyError('ws-1', 'BUSY');
    expect(error).toBeInstanceOf(AgentHangarError);
    expect(error.code).toBe('WORKSPACE_BUSY');
    expect(error.name).toBe('WorkspaceBusyError');
    expect(error.workspaceId).toBe('ws-1');
    expect(error.status).toBe('BUSY');
    expect(error.message).toBe(
      'workspace ws-1 is BUSY; resolve it (stalled recovery or wait) before ensuring a workspace for this chat',
    );
  });

  /**
   * A cause is forwarded so a failure that surfaced as "busy" keeps its origin in the log.
   */
  it('forwards a cause', () => {
    const cause = new Error('lock held');
    expect(new WorkspaceBusyError('ws-1', 'STOPPING', { cause }).cause).toBe(cause);
  });
});
