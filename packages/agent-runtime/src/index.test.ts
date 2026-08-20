/**
 * Unit tests for the package barrel.
 *
 * Layer: unit.
 * Goal: the documented public surface is actually exported, so a rename inside the package cannot
 * silently break the worker or the tooling that imports it.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import * as runtime from './index.js';

describe('@agent-hangar/agent-runtime barrel', () => {
  it('exports the command dispatcher, the turn machinery and the protocol adapters', () => {
    // A missing entry here is an unnoticed break for every consumer of the package.
    expect(Object.keys(runtime).toSorted()).toStrictEqual([
      'ALLOWED_ORIGIN_VAR',
      'EXIT',
      'GitError',
      'PrepareError',
      'REDACTED',
      'RUNTIME_VERSION',
      'TOOL_DEFINITIONS',
      'assertBranchName',
      'builtInFakeScript',
      'createDiagnostics',
      'createEventWriter',
      'createGitRunner',
      'createNodeIo',
      'createProvider',
      'createRuntimeRedactor',
      'createToolExecutor',
      'gitOrThrow',
      'looksLikeGitPush',
      'prepare',
      'readTurnRequest',
      'repositoryUrlPolicyFromEnv',
      'resolveGitHead',
      'resolveProviderName',
      'resolveRepoUrl',
      'runCli',
      'runTurnCommand',
      'runTurnLoop',
    ]);
  });
});
