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
  it('exports the command dispatcher, the protocol adapters and the redactor', () => {
    // A missing entry here is an unnoticed break for every consumer of the package.
    expect(Object.keys(runtime).toSorted()).toStrictEqual([
      'EXIT',
      'REDACTED',
      'RUNTIME_VERSION',
      'createDiagnostics',
      'createEventWriter',
      'createNodeIo',
      'createRuntimeRedactor',
      'readTurnRequest',
      'runCli',
    ]);
  });
});
