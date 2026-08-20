/**
 * Short display label for a repository URL.
 *
 * Layer: shared (utility).
 *
 * Presentation only. A repository URL reaches the browser already decided: the API echoes the URL
 * the configured forge reported, and which forges may be cloned from is the host's policy
 * (`ALLOWED_REPO_HOSTS`), enforced where a write is accepted. This module therefore judges no
 * origin — a second copy of that policy in the client could only be a stale one, since a browser
 * cannot know the operator's list, and it would hide a repository the operator legitimately
 * configured behind a label it refused to shorten.
 */

/** Suffix git accepts on a repository path, dropped from the label. */
const GIT_SUFFIX = '.git';

/** Characters a forge allows in an owner or repository name. */
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Path segments a repository URL carries: owner and repository. */
const REPO_PATH_SEGMENTS = 2;

/**
 * Reads the `owner/name` short form out of a repository URL.
 *
 * @param url - A repository URL, on any origin.
 * @returns The short form, or `null` when the URL names anything other than one repository.
 */
function repoShortName(url: string): string | null {
  const parsed = URL.parse(url);
  if (parsed === null) {
    return null;
  }
  const path = parsed.pathname.endsWith(GIT_SUFFIX)
    ? parsed.pathname.slice(0, -GIT_SUFFIX.length)
    : parsed.pathname;
  const segments = path.split('/').slice(1);
  if (
    segments.length !== REPO_PATH_SEGMENTS ||
    !segments.every((segment) => SEGMENT_PATTERN.test(segment))
  ) {
    return null;
  }
  return segments.join('/');
}

/**
 * Labels a repository URL with its `owner/name`, falling back to the URL itself.
 *
 * The fallback shows the URL rather than hiding it: a value the app cannot shorten is still the
 * repository the chat or job runs against, and the user has to be able to read it.
 *
 * @param url - A repository URL, on any origin.
 * @returns `owner/name`, or `url` unchanged when it names anything else.
 */
export function repoLabel(url: string): string {
  return repoShortName(url) ?? url;
}
