/**
 * Host policy for repository URLs accepted by the write routes.
 *
 * Layer: service (server).
 *
 * The request contracts already pin a repository URL to
 * `https://github.com/<owner>/<repository>` with no credentials, query or fragment, and they run
 * first. This check can therefore only ever narrow that set, never widen it: it is the operator's
 * switch (`ALLOWED_REPO_HOSTS`) for refusing a forge the contract would otherwise allow, and the
 * second reader of a URL that ends up in a `git clone` command line.
 */
import { parseAllowedRepoHosts } from '@agent-hangar/core';

import { ValidationError } from './errors';

/** Code returned when a URL names a host the operator has not allowed. */
export const REPO_URL_NOT_ALLOWED = 'REPO_URL_NOT_ALLOWED';

/**
 * Verifies that a repository URL names an allowed host and carries no credential.
 *
 * @param url - Repository URL, already parsed by its request contract.
 * @param allowedHosts - Hostnames from `ALLOWED_REPO_HOSTS`, lower-cased.
 * @returns The parsed URL.
 * @throws ValidationError 400 `REPO_URL_NOT_ALLOWED` when the URL is unusable or the host is not
 *   on the list.
 */
export function assertRepoUrlAllowed(url: string, allowedHosts: readonly string[]): URL {
  const parsed = URL.parse(url);
  if (
    parsed === null ||
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname === '/' ||
    !allowedHosts.includes(parsed.hostname.toLowerCase())
  ) {
    throw new ValidationError(
      'Repository host is not allowed; see ALLOWED_REPO_HOSTS',
      REPO_URL_NOT_ALLOWED,
    );
  }
  return parsed;
}

/**
 * Reads the configured host allow-list.
 *
 * @param config - Loaded configuration.
 * @returns The allowed hostnames, lower-cased.
 */
export function allowedRepoHosts(config: { readonly ALLOWED_REPO_HOSTS: string }): string[] {
  return parseAllowedRepoHosts(config.ALLOWED_REPO_HOSTS);
}
