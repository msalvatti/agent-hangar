/**
 * Repository-URL rules shared by every boundary a repository URL crosses.
 *
 * Layer: domain (pure; no I/O).
 *
 * A repository URL is handed to `git clone` and is persisted, echoed by the API and forwarded into
 * a workspace container. The token must travel through `GIT_ASKPASS` and nowhere else, so a URL
 * that carries credentials would put a PAT into a clone URL and into process arguments, where it
 * is visible to anything that can read the process table. Every boundary therefore validates, and
 * they share these rules rather than restating them.
 */
import { z } from 'zod';

/** Suffix `git clone` accepts on a repository path. */
const GIT_URL_SUFFIX = '.git';

/** Characters GitHub allows in an owner or repository name. */
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Whether a URL carries no credential-bearing component.
 *
 * Userinfo, a query string and a fragment are each a place a token hides
 * (`https://user:ghp_…@…`, `?token=…`, `#access_token=…`), and a non-default port sends the clone
 * somewhere other than the host's usual service. The query and fragment are tested on the raw text
 * rather than on `URL`'s parsed components, because a bare `?` or `#` normalises to an empty
 * component while remaining part of the stored string.
 *
 * @param value - A URL string.
 * @returns `true` when the URL carries nothing that could hold a credential.
 */
export function isCredentialFreeUrl(value: string): boolean {
  return parseCredentialFreeUrl(value) !== null;
}

/**
 * Parses a URL and returns it only when it carries nothing that could hold a credential.
 *
 * Returning the parsed URL rather than a boolean lets the stricter rule below reuse both the parse
 * and the verdict, so there is one place where "credential-free" is decided and no branch that can
 * never run.
 *
 * @param value - A URL string.
 * @returns The parsed URL, or `null` when it is unparseable or carries a credential-bearing part.
 */
function parseCredentialFreeUrl(value: string): URL | null {
  const parsed = URL.parse(value);
  if (parsed === null) {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
    return null;
  }
  if (value.includes('?') || value.includes('#')) {
    return null;
  }
  return parsed;
}

/**
 * Whether a URL is exactly `https://github.com/<owner>/<repository>` with an optional `.git`.
 *
 * An allow-list of what a clone actually needs rather than a deny-list of known credential shapes.
 * `URL` normalises `.` and `..` before this runs, and percent-escapes never match the segment
 * pattern, so neither can smuggle a third segment past the length check.
 *
 * @param value - A URL that already passed the scheme and hostname checks.
 * @returns `true` when the URL carries nothing beyond owner and repository.
 */
export function isPlainRepoUrl(value: string): boolean {
  const parsed = parseCredentialFreeUrl(value);
  if (parsed === null) {
    return false;
  }
  const path = parsed.pathname;
  const withoutSuffix = path.endsWith(GIT_URL_SUFFIX)
    ? path.slice(0, -GIT_URL_SUFFIX.length)
    : path;
  const segments = withoutSuffix.split('/').slice(1);
  return segments.length === 2 && segments.every((segment) => REPO_SEGMENT_PATTERN.test(segment));
}

/**
 * An https URL that carries no credential, with no policy on which host it names.
 *
 * Used where the host is decided elsewhere — the agent-runtime protocol takes whatever repository
 * the host resolved, and enforcing the forge there would duplicate a policy it does not own — but
 * where a credential in the URL would still end up in a clone command.
 */
export const credentialFreeUrl = z.url({ protocol: /^https$/ }).refine(isCredentialFreeUrl, {
  message: 'URL must carry no credentials, port, query string or fragment',
});

/** Repository URL accepted by the API: `https://github.com/<owner>/<repository>[.git]`, nothing else. */
export const repoUrl = z
  .url({ protocol: /^https$/, hostname: /^github\.com$/ })
  .refine(isPlainRepoUrl, {
    message:
      'Repository URL must be https://github.com/<owner>/<repository> with no credentials, query string or fragment',
  });
