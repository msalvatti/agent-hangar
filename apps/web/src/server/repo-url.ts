/**
 * Host policy for repository URLs accepted by the write routes.
 *
 * Layer: service (server).
 *
 * The request contracts describe the shape of a repository URL — one owner, one repository, no
 * credentials, no query, no fragment — and they run first. This check adds the half a contract
 * cannot know: which origins the operator allowed. Both halves come from `@agent-hangar/core`,
 * so the rule that guards a `git clone` here is the same one the schema states, and the list is
 * read from configuration at every call rather than captured at import time.
 */
import { parseAllowedRepoHosts, repoUrlForHosts } from '@agent-hangar/core';

import { ValidationError } from './errors';

/** Code returned when a URL names a host the operator has not allowed. */
export const REPO_URL_NOT_ALLOWED = 'REPO_URL_NOT_ALLOWED';

/**
 * Verifies that a repository URL names an allowed origin and carries no credential.
 *
 * @param url - Repository URL, already parsed by its request contract.
 * @param allowedHosts - Entries of `ALLOWED_REPO_HOSTS`, trimmed and lower-cased.
 * @returns The parsed URL.
 * @throws ValidationError 400 `REPO_URL_NOT_ALLOWED` when the URL is unusable or its origin is
 *   not on the list.
 */
export function assertRepoUrlAllowed(url: string, allowedHosts: readonly string[]): URL {
  const result = repoUrlForHosts(allowedHosts).safeParse(url);
  const parsed = result.success ? URL.parse(result.data) : null;
  if (parsed === null) {
    throw new ValidationError(
      'Repository host is not allowed; see ALLOWED_REPO_HOSTS',
      REPO_URL_NOT_ALLOWED,
    );
  }
  return parsed;
}

/**
 * Reads the configured allow-list.
 *
 * @param config - Loaded configuration.
 * @returns The allowed entries, trimmed and lower-cased.
 */
export function allowedRepoHosts(config: { readonly ALLOWED_REPO_HOSTS: string }): string[] {
  return parseAllowedRepoHosts(config.ALLOWED_REPO_HOSTS);
}
