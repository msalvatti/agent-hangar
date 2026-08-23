/**
 * Recently-used repositories, persisted in `localStorage` so the picker can list them first.
 *
 * Layer: shared (utility).
 */

/** `localStorage` key the recent-repos list is stored under. */
const RECENT_REPOS_KEY = 'ah-recent-repos';

/** Maximum number of repos remembered. */
const MAX_RECENT_REPOS = 5;

function readLocalStorage(): Storage | undefined {
  return globalThis.localStorage;
}

function parseRecentRepos(raw: string | null): string[] {
  // The null test narrows the type for `JSON.parse` below, which reads a missing value as the four
  // letters of `null` and answers with a value the array check refuses anyway.
  // Stryker disable next-line ConditionalExpression,BlockStatement
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Reads the recently-used repository list, most recent first.
 *
 * @returns Up to {@link MAX_RECENT_REPOS} `fullName`s. Empty outside the browser.
 */
export function getRecentRepos(): string[] {
  const storage = readLocalStorage();
  if (storage === undefined) {
    return [];
  }
  return parseRecentRepos(storage.getItem(RECENT_REPOS_KEY));
}

/**
 * Records `fullName` as the most recently used repo, deduping and capping the list at
 * {@link MAX_RECENT_REPOS}.
 *
 * @param fullName - The repository's `owner/name`.
 */
export function pushRecentRepo(fullName: string): void {
  const storage = readLocalStorage();
  if (storage === undefined) {
    return;
  }
  const existing = parseRecentRepos(storage.getItem(RECENT_REPOS_KEY));
  const next = [fullName, ...existing.filter((entry) => entry !== fullName)].slice(
    0,
    MAX_RECENT_REPOS,
  );
  storage.setItem(RECENT_REPOS_KEY, JSON.stringify(next));
}
