/**
 * Handing one execution the two credentials it runs with.
 *
 * Layer: service.
 *
 * This is the only place in the application that holds a decrypted credential. The two plaintexts
 * live in local constants, go into the file the runner places for the execution and into the
 * redactor, and are referenced nowhere else — not on a returned value beyond that file, not in a
 * log record, and not in the message of a failure.
 *
 * Per execution and not per container. A workspace outlives the turn that created it — a chat
 * reuses its container until the collector reclaims it — so a credential handed over once at
 * create time is a credential the workspace holds for as long as it exists, and every process in
 * it runs as the one user that can read `/proc/<pid>/environ` and the container's own filesystem.
 * Handing it over immediately before the runtime starts, and having the runtime unlink the file as
 * it reads it, is what makes the exposure the length of a start-up rather than the length of a
 * chat.
 */
import type { WorkspaceFile } from '@agent-hangar/core';

import { CREDENTIALS_PATH } from './constants.js';
import type { ProcessorDeps } from './types.js';

/**
 * Reveals the credentials of one execution and packs them into the file the runner will place.
 *
 * The redactor is registered here rather than by the caller, because this is where the values
 * exist: everything the execution then produces is redacted against them, including the output of
 * a workspace that was created by an earlier process of this worker.
 *
 * @param deps - Secrets service and redactor.
 * @returns The file to place, or `null` when a credential is not configured.
 */
export async function revealCredentialsFile(deps: ProcessorDeps): Promise<WorkspaceFile | null> {
  const pat = await deps.secrets.reveal('GITHUB_PAT');
  const apiKey = await deps.secrets.reveal('OPENAI_API_KEY');
  if (pat === null || apiKey === null) {
    return null;
  }
  deps.redactor.register([pat, apiKey]);
  return {
    path: CREDENTIALS_PATH,
    content: JSON.stringify({ githubToken: pat, openaiApiKey: apiKey }),
  };
}
