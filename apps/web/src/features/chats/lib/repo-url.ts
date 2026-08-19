/**
 * Conversions between a repository's `owner/name` short form and the credential-free clone URL
 * the API contract accepts.
 *
 * Layer: feature (lib).
 *
 * The contract's `repoUrl` schema accepts exactly `https://github.com/<owner>/<repository>` with
 * an optional `.git` suffix and nothing else, so these two functions are a closed round trip.
 */

/** Host every repository URL this app builds points at. */
const GITHUB_ORIGIN = 'https://github.com';

/** Suffix git accepts on a clone URL. */
const GIT_SUFFIX = '.git';

/** Characters GitHub allows in an owner or repository name. */
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Builds the clone URL for a repository given as `owner/name`.
 *
 * @param fullName - Repository in `owner/name` form, as the pickers report it.
 * @returns The credential-free clone URL.
 * @throws Error when `fullName` is not exactly two non-empty path segments.
 */
export function toRepoUrl(fullName: string): string {
  const segments = fullName.split('/');
  if (segments.length !== 2 || !segments.every((segment) => SEGMENT_PATTERN.test(segment))) {
    throw new Error(`Not an owner/name repository: ${fullName}`);
  }
  return `${GITHUB_ORIGIN}/${segments.join('/')}${GIT_SUFFIX}`;
}

/**
 * Reads the `owner/name` short form back out of a clone URL.
 *
 * @param url - A repository URL as stored on a chat.
 * @returns `{ fullName }`, or `null` when the URL is not a plain GitHub repository URL.
 */
export function parseRepoUrl(url: string): { fullName: string } | null {
  const parsed = URL.parse(url);
  if (parsed?.origin !== GITHUB_ORIGIN) {
    return null;
  }
  const path = parsed.pathname.endsWith(GIT_SUFFIX)
    ? parsed.pathname.slice(0, -GIT_SUFFIX.length)
    : parsed.pathname;
  const segments = path.split('/').slice(1);
  if (segments.length !== 2 || !segments.every((segment) => SEGMENT_PATTERN.test(segment))) {
    return null;
  }
  return { fullName: segments.join('/') };
}
