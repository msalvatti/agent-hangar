/**
 * Save/remove mutations for one secret field: pending state, field-level errors, toasts.
 *
 * Layer: hook.
 */
'use client';

import type { SecretKey } from '@agent-hangar/core';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { ApiClientError } from '@/shared/api/client';
import { invalidateQueries } from '@/shared/api/use-api-query';

import { deleteSecret, putSecret } from '../services/settings-api';

/** Query key of the settings status every save and removal changes. */
const SETTINGS_KEY = ['settings'];

/** What a secret field is currently doing. */
export type SecretMutationState = 'saving' | 'removing';

/** Result of {@link useSecretMutations}. */
export interface UseSecretMutationsResult {
  /** Saves a secret's plaintext value; resolves `true` on success, `false` on error. */
  save: (key: SecretKey, value: string) => Promise<boolean>;
  /** Removes a secret; resolves `true` on success, `false` on error. */
  remove: (key: SecretKey) => Promise<boolean>;
  /** What each secret is currently doing, if anything. */
  pending: Partial<Record<SecretKey, SecretMutationState>>;
  /** The last save error per secret, if any. */
  errors: Partial<Record<SecretKey, string>>;
  /** Clears a secret's error (e.g. when the user edits the field again). */
  clearError: (key: SecretKey) => void;
}

function withoutKey<T>(
  map: Partial<Record<SecretKey, T>>,
  key: SecretKey,
): Partial<Record<SecretKey, T>> {
  const { [key]: _removed, ...rest } = map;
  return rest;
}

// A `Record` (rather than `SECRET_FIELDS.find(...)`) keeps every key covered by construction:
// `SecretKey` is the exhaustive union `SECRET_FIELDS` is built from, so a `.find` fallback would
// be unreachable dead code, whereas a missing entry here is a compile error instead.
const TOAST_NAME_BY_KEY: Record<SecretKey, string> = {
  GITHUB_PAT: 'GitHub token',
  OPENAI_API_KEY: 'OpenAI API key',
};

function toastNameOf(key: SecretKey): string {
  return TOAST_NAME_BY_KEY[key];
}

/**
 * Save/remove actions for the credentials card's secret fields, with per-field pending and error
 * state.
 *
 * @returns The action callbacks plus per-field pending/error state.
 */
export function useSecretMutations(): UseSecretMutationsResult {
  const [pending, setPending] = useState<Partial<Record<SecretKey, SecretMutationState>>>({});
  const [errors, setErrors] = useState<Partial<Record<SecretKey, string>>>({});

  // Nothing these callbacks read changes between renders, so their dependency lists are empty —
  // and anything constant added to one would never change either.
  // Stryker disable ArrayDeclaration
  const clearError = useCallback((key: SecretKey) => {
    setErrors((prev) => withoutKey(prev, key));
  }, []);

  const save = useCallback(async (key: SecretKey, value: string) => {
    setPending((prev) => ({ ...prev, [key]: 'saving' }));
    setErrors((prev) => withoutKey(prev, key));
    try {
      await putSecret(key, value);
      toast.success(`${toastNameOf(key)} saved`);
      invalidateQueries(SETTINGS_KEY);
      return true;
    } catch (error) {
      const message = error instanceof ApiClientError ? error.message : 'Could not save value';
      setErrors((prev) => ({ ...prev, [key]: message }));
      return false;
    } finally {
      setPending((prev) => withoutKey(prev, key));
    }
  }, []);

  const remove = useCallback(async (key: SecretKey) => {
    setPending((prev) => ({ ...prev, [key]: 'removing' }));
    try {
      await deleteSecret(key);
      toast.success(`${toastNameOf(key)} removed`);
      invalidateQueries(SETTINGS_KEY);
      return true;
    } catch {
      toast.error(`Could not remove ${toastNameOf(key)}`);
      return false;
    } finally {
      setPending((prev) => withoutKey(prev, key));
    }
  }, []);
  // Stryker restore ArrayDeclaration

  return { save, remove, pending, errors, clearError };
}
