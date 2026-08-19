/**
 * Secret canaries: the only secret-shaped strings allowed anywhere in the repository.
 *
 * Layer: test double.
 *
 * Tests inject these where a real credential would go and assert they never reach output, rows,
 * logs or image config. The values are assembled at runtime (prefix + `TESTCANARY` + padding) so
 * no credential-shaped literal is ever written to a file: secret scanners (pre-commit, gitleaks
 * in CI) would otherwise flag the repository, while the runtime value still matches the shape
 * patterns the redactor must catch.
 */

/** Marker that makes every canary obviously fake. */
export const CANARY_MARKER = 'TESTCANARY';

/** GitHub classic PAT shape (`ghp_` + 36 alphanumerics). */
export const GITHUB_CANARY = `ghp_${CANARY_MARKER.padEnd(36, '0')}`;

/** OpenAI API key shape (`sk-` + 30 characters). */
export const OPENAI_CANARY = `sk-${CANARY_MARKER.padEnd(30, '0')}`;

/** Every canary, for loops in redaction tests. */
export const CANARY_VALUES: readonly string[] = [GITHUB_CANARY, OPENAI_CANARY];

/**
 * Throws when any canary appears in `text`.
 *
 * @param text - Output, log line, row content or image config to inspect.
 * @throws Error naming every canary that leaked.
 */
export function assertNoCanary(text: string): void {
  const leaked = CANARY_VALUES.filter((canary) => text.includes(canary));
  if (leaked.length > 0) {
    throw new Error(`Secret canary leaked: ${leaked.join(', ')}`);
  }
}
