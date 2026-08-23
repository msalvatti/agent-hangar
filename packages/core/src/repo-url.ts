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
 *
 * Two rules live here and are kept apart on purpose. The credential rules (no userinfo, no query,
 * no fragment, a hierarchical http(s) URL, an owner-and-repository path) are properties of the
 * string itself and hold everywhere. Forge policy — which origin may be cloned from at all — is
 * the operator's, expressed as `ALLOWED_REPO_HOSTS`, and reaches this module only as an argument:
 * {@link repoUrlForHosts} takes the list rather than reading configuration, so no boundary can
 * accept a host by forgetting to pass one.
 */
import { z } from 'zod';

/** Suffix `git clone` accepts on a repository path. */
const GIT_URL_SUFFIX = '.git';

/** Characters GitHub allows in an owner or repository name. */
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Number of path segments a clonable repository URL carries: owner and repository. */
const REPO_PATH_SEGMENTS = 2;

/** Scheme assumed for an allow-list entry that does not spell one out. */
const DEFAULT_ALLOWED_SCHEME = 'https://';

/** Characters that may not appear in the authority of an allow-list entry. */
const NON_AUTHORITY_CHARACTERS = /[/\\?#@]/u;

/**
 * Whether the authority of a raw URL string contains a userinfo separator.
 *
 * `URL` normalises a syntactically present but empty userinfo away, so `https://@github.com/x/y`
 * and `https://:@github.com/x/y` both parse with empty `username` and `password` while the stored
 * string keeps the `@` and git keeps reading it as a userinfo form. The separator is therefore
 * looked for in the raw authority — only there, since an `@` inside the path is ordinary.
 *
 * @param value - A URL string.
 * @returns `true` when the authority contains `@`.
 */
function hasUserinfoSeparator(value: string): boolean {
  // Safe without a guard: every caller has already required the literal `scheme://` prefix.
  const afterScheme = value.slice(value.indexOf('://') + '://'.length);
  const authorityEnd = afterScheme.search(/[/?#]/u);
  // Stryker disable next-line ConditionalExpression,UnaryOperator: an authority that runs to the
  // end of the string differs from one cut short only in its last character, and the only last
  // character that would change the answer is the separator itself — which would leave the host
  // empty, and a URL with no host does not parse.
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  return authority.includes('@');
}

/**
 * Whether a URL string is written in the hierarchical `scheme://` form.
 *
 * WHATWG parsing repairs `https:host/path`, `https:/host/path` and backslash variants into a
 * normal URL, so the schema would accept them while the ORIGINAL string is what gets stored and
 * handed to `git`, which reads `https:host/path` as an scp-style target over ssh instead of over
 * HTTPS. Requiring the literal form keeps what was validated and what is cloned the same string.
 *
 * @param value - A URL string.
 * @returns `true` when the string starts with `http://` or `https://` exactly.
 */
function isHierarchicalHttpUrl(value: string): boolean {
  return /^https?:\/\//u.test(value);
}

/**
 * Whether a URL carries no credential-bearing component.
 *
 * Userinfo, a query string and a fragment are each a place a token hides
 * (`https://user:ghp_…@…`, `?token=…`, `#access_token=…`). The query and fragment are tested on
 * the raw text rather than on `URL`'s parsed components, because a bare `?` or `#` normalises to
 * an empty component while remaining part of the stored string.
 *
 * Scheme, host and port are deliberately NOT judged here: they are transport policy, decided by
 * the operator through `ALLOWED_REPO_HOSTS`, not places a credential hides. The end-to-end
 * harness clones `http://<local-git-server>:<port>/acme/sample.git`, which is legitimate and must
 * pass.
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
 * Returning the parsed URL rather than a boolean lets the stricter rules below reuse both the
 * parse and the verdict, so there is one place where "credential-free" is decided and no branch
 * that can never run.
 *
 * @param value - A URL string.
 * @returns The parsed URL, or `null` when it is unparseable or carries a credential-bearing part.
 */
function parseCredentialFreeUrl(value: string): URL | null {
  // Every question here is asked of the written string, so they are all asked before it is parsed
  // and the parse itself answers the last one: a string that cannot be parsed is not a URL, and
  // `URL.parse` says so with the same `null` this function returns. The hierarchical form is
  // required first because the userinfo check below reads the text after `://` and relies on it.
  if (!isHierarchicalHttpUrl(value)) {
    return null;
  }
  // Asked of the raw authority alone. Every URL whose parsed `username` or `password` is set is a
  // URL whose authority carries the `@` that put it there, and the raw check catches the two forms
  // the parsed ones miss — `https://@host` and `https://:@host` both parse with those fields empty
  // while the stored string keeps the separator and git keeps reading it as a userinfo form.
  if (hasUserinfoSeparator(value)) {
    return null;
  }
  if (value.includes('?') || value.includes('#')) {
    return null;
  }
  return URL.parse(value);
}

/**
 * Parses a URL and returns it only when it is credential-free and names exactly one repository.
 *
 * An allow-list of what a clone actually needs rather than a deny-list of known credential
 * shapes. `URL` normalises `.` and `..` before this runs, and percent-escapes never match the
 * segment pattern, so neither can smuggle a third segment past the length check.
 *
 * @param value - A URL string.
 * @returns The parsed URL, or `null` when it carries anything beyond owner and repository.
 */
function parsePlainRepoUrl(value: string): URL | null {
  const parsed = parseCredentialFreeUrl(value);
  if (parsed === null) {
    return null;
  }
  const path = parsed.pathname;
  const withoutSuffix = path.endsWith(GIT_URL_SUFFIX)
    ? path.slice(0, -GIT_URL_SUFFIX.length)
    : path;
  const segments = withoutSuffix.split('/').slice(1);
  const isPlain =
    segments.length === REPO_PATH_SEGMENTS &&
    segments.every((segment) => REPO_SEGMENT_PATTERN.test(segment));
  return isPlain ? parsed : null;
}

/**
 * Whether a URL is `<scheme>://<host>[:<port>]/<owner>/<repository>` with an optional `.git`.
 *
 * Shape only: the origin is not judged here, because which forges may be cloned from is the
 * operator's decision and reaches the validator through {@link repoUrlForHosts}.
 *
 * @param value - A URL string.
 * @returns `true` when the URL carries nothing beyond owner and repository.
 */
export function isPlainRepoUrl(value: string): boolean {
  return parsePlainRepoUrl(value) !== null;
}

/**
 * Normalises one `ALLOWED_REPO_HOSTS` entry into the origin it authorises.
 *
 * The grammar is `[http://|https://]host[:port]`: a bare `github.com` authorises
 * `https://github.com` on the default port and nothing else, while a local forge reached over
 * plaintext is written in full, `http://127.0.0.1:3907`. Scheme and port are part of the entry
 * rather than free for the URL to choose, because the PAT is delivered to whatever origin the
 * repository URL names: a bare loopback entry must not open every daemon on the machine, and a
 * bare entry for a public forge must not admit a cleartext clone that an on-path attacker can
 * challenge for the token. Omitting the scheme therefore means `https`, and cleartext has to be
 * asked for.
 *
 * Asked for, it is granted, for any host and not only a loopback one — deliberately, and unlike
 * `GITHUB_API_BASE_URL`, which admits `http` only to this machine. The two carry the token
 * differently. That base URL is fetched by this process with the PAT in an `Authorization` header
 * on every call, so plaintext to anywhere but this machine puts the token on the wire with no
 * further gate. A repository URL is handed to `git` inside a workspace container, where the
 * credential is released by the askpass helper, which independently requires `https` and an exact
 * host before it answers a prompt — so a cleartext entry authorises a clone, not a token. It has
 * to be allowed because the local forge a container clones from is reached through the host
 * gateway (`host.docker.internal`, the `docker0` address), which is a remote address from inside
 * the container and would fail a loopback rule. Anything that later derives the askpass host from
 * this list must keep that helper's scheme check rather than inherit this one.
 *
 * Both sides of the later comparison are normalised by the same `URL` implementation, so
 * `GitHub.com`, `github.com:443` and `github.com` are one entry, and an IPv6 literal is compared
 * in its canonical spelling.
 *
 * @param entry - One entry of the allow-list, already trimmed.
 * @returns The origin the entry authorises, or `null` when the entry is not a bare authority.
 */
export function parseAllowedRepoOrigin(entry: string): string | null {
  const withScheme = isHierarchicalHttpUrl(entry) ? entry : `${DEFAULT_ALLOWED_SCHEME}${entry}`;
  const authority = withScheme.slice(withScheme.indexOf('://') + '://'.length);
  // An authority with nothing in it needs no check of its own: `https://` is not a URL, and the
  // parse below answers it with the `null` this function returns.
  if (NON_AUTHORITY_CHARACTERS.test(authority)) {
    return null;
  }
  const parsed = URL.parse(withScheme);
  return parsed === null ? null : parsed.origin;
}

/**
 * Whether a URL names one repository on an origin the operator allowed.
 *
 * The comparison is between whole origins, never a substring, so an entry authorises the origin it
 * spells and no other: `github.com` does not admit `github.com.evil.test` or `mygithub.com`, and a
 * single-label entry such as `com` admits only the origin `https://com` itself rather than every
 * host under that suffix. An empty list admits nothing, because there is no entry to equal; the
 * predicate never substitutes a forge for a list that names none.
 *
 * @param value - A URL string.
 * @param allowedHosts - Entries of `ALLOWED_REPO_HOSTS`, trimmed and lower-cased.
 * @returns `true` when the URL is plain and its origin is on the list.
 */
export function isAllowedRepoUrl(value: string, allowedHosts: readonly string[]): boolean {
  const parsed = parsePlainRepoUrl(value);
  if (parsed === null) {
    return false;
  }
  return allowedHosts.some((entry) => parseAllowedRepoOrigin(entry) === parsed.origin);
}

/**
 * An http(s) URL that carries no credential, with no policy on which host or port it names.
 *
 * Used where the host is decided elsewhere — the agent-runtime protocol takes whatever repository
 * the host resolved, and enforcing the forge there would duplicate a policy it does not own — but
 * where a credential in the URL would still end up in a clone command and in the container's
 * process arguments.
 *
 * The scheme is still narrowed to what this product clones over, because `git` would otherwise
 * accept `file://`, `git://` and `ssh://` here; which of http and https is acceptable for a given
 * host is the operator's decision.
 */
export const credentialFreeUrl = z.url({ protocol: /^https?$/ }).refine(isCredentialFreeUrl, {
  message: 'URL must carry no credentials, query string or fragment',
});

/**
 * A repository URL in the only shape this product clones: `<origin>/<owner>/<repository>[.git]`.
 *
 * Shape, not policy. It describes a URL wherever the origin has already been decided — the rows
 * the API echoes back were vetted against the allow-list when they were written, and a response
 * schema that re-imposed a forge would reject a repository the operator legitimately configured.
 * A request that carries a repository URL is additionally checked against the configured origins
 * with {@link repoUrlForHosts}; this schema alone never decides which forge may be reached.
 */
export const repoUrl = z.url({ protocol: /^https?$/ }).refine(isPlainRepoUrl, {
  message:
    'Repository URL must be <scheme>://<host>/<owner>/<repository> with no credentials, query string or fragment',
});

/**
 * Builds the repository-URL schema that guards a write: {@link repoUrl} plus the origin policy.
 *
 * The list is a parameter rather than something the module reads for itself. That makes the
 * signature of every caller carry it, which is the point: a boundary cannot end up accepting an
 * arbitrary forge because a global was never populated, and a test cannot pass by accident
 * against ambient configuration.
 *
 * @param allowedHosts - Entries of `ALLOWED_REPO_HOSTS`, trimmed and lower-cased.
 * @returns A schema accepting only repository URLs on one of those origins.
 */
export function repoUrlForHosts(allowedHosts: readonly string[]) {
  return z.url({ protocol: /^https?$/ }).refine((value) => isAllowedRepoUrl(value, allowedHosts), {
    message:
      'Repository URL must be <owner>/<repository> on an origin listed in ALLOWED_REPO_HOSTS, with no credentials, query string or fragment',
  });
}
