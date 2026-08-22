/**
 * Branch-name rules shared by every boundary a git ref crosses.
 *
 * Layer: domain (pure; no I/O).
 *
 * A branch name is accepted by the HTTP API, persisted, and only then handed to `git` inside a
 * workspace container. The two ends therefore state one rule rather than each keeping its own: a
 * name the API accepts and the workspace refuses costs a provisioned container to discover, and a
 * name the workspace accepts and the API refuses is a branch nobody can reach.
 *
 * The pattern is narrower than git's own `check-ref-format`. It admits the names repositories
 * really carry and refuses everything that would need quoting, so the value stays inert wherever a
 * later caller puts it — an argument list, a URL path, a log line — rather than relying on each of
 * those callers to escape it.
 */

/**
 * Shape of an acceptable branch name: an alphanumeric first character, then letters, digits, dot,
 * dash, underscore and slash.
 */
export const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * The rule as prose, so the API and the workspace report the same sentence about the same value.
 * Each caller supplies its own subject — a field name at the API, an argument name in the
 * workspace — and appends this.
 */
export const BRANCH_NAME_RULE =
  'must start with a letter or digit and contain only letters, digits, dot, dash, underscore and slash';
