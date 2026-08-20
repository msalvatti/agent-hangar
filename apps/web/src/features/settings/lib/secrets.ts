/**
 * Static configuration and pure helpers for the credentials card's secret fields.
 *
 * Layer: lib (pure).
 */
import type { SecretKey, SettingsStatus } from '@agent-hangar/core';

/** Masked status of one secret, as reported by `GET /api/settings`. */
export type SecretStatusView = SettingsStatus['githubPat'];

/** Static description of one secret field, independent of its current status. */
export interface SecretFieldConfig {
  /** Path-segment key (`PUT`/`DELETE /api/settings/:key`). */
  key: SecretKey;
  /** Visible field label. */
  label: string;
  /** Input placeholder, hinting at the expected shape without validating it. */
  placeholder: string;
  /** Helper text shown under the field. */
  helper: string;
  /** Name used in the save/remove toast ("<toastName> saved"). */
  toastName: string;
  /** Field name of this secret's status in `SettingsStatus`. */
  statusKey: 'githubPat' | 'openaiKey';
}

/** Every secret field the credentials card renders, in display order. */
export const SECRET_FIELDS: readonly SecretFieldConfig[] = [
  {
    key: 'GITHUB_PAT',
    label: 'GitHub Personal Access Token',
    placeholder: 'ghp_…',
    helper: 'Needs repo scope (read + push) for the repositories you want to use.',
    toastName: 'GitHub token',
    statusKey: 'githubPat',
  },
  {
    key: 'OPENAI_API_KEY',
    label: 'OpenAI API key',
    placeholder: 'sk-…',
    helper: 'Used by the agent inside workspaces to call OpenAI.',
    toastName: 'OpenAI API key',
    statusKey: 'openaiKey',
  },
];

const MASK_BULLETS = '••••••••';

/**
 * Renders a secret's masked display value.
 *
 * @param last4 - The secret's last 4 characters, or `undefined` before it is known.
 * @returns Eight bullets, followed by `last4` when given.
 */
export function maskSecret(last4: string | undefined): string {
  return last4 === undefined ? MASK_BULLETS : `${MASK_BULLETS}${last4}`;
}

const MAX_SECRET_LENGTH = 512;

/**
 * Validates a secret input before it is saved. Deliberately shape-agnostic (GitHub and OpenAI
 * token formats both vary and change over time) — only trims, non-emptiness, no interior
 * whitespace and a generous length cap are checked; the server is the source of truth.
 *
 * @param value - The raw input value.
 * @returns An error message, or `null` when the value is acceptable.
 */
export function validateSecretInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'Enter a value.';
  }
  if (/\s/.test(trimmed)) {
    return 'Value must not contain whitespace.';
  }
  if (trimmed.length > MAX_SECRET_LENGTH) {
    return `Value must be ${String(MAX_SECRET_LENGTH)} characters or fewer.`;
  }
  return null;
}
