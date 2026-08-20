/**
 * `/settings` screen: credentials card and environment card.
 *
 * Layer: component (screen).
 */
'use client';

import { PageHeader } from '@/shared/shell/PageHeader';

import { useHealthSummary } from '../hooks/useHealthSummary';
import { useSecretMutations } from '../hooks/useSecretMutations';
import { useSettings } from '../hooks/useSettings';

import { CredentialsCard } from './CredentialsCard';
import { EnvironmentCard } from './EnvironmentCard';

/**
 * The settings screen: a credentials card (masked secret fields, replace/remove, active model)
 * and a read-only environment card.
 */
export function SettingsView() {
  const settingsQuery = useSettings();
  const healthQuery = useHealthSummary();
  const { save, remove, pending, errors, clearError } = useSecretMutations();

  // Computed unconditionally so both sides of each fallback are exercised across the component's
  // normal render cycle (the error is `undefined` on every render before a failure).
  const settingsErrorMessage = settingsQuery.error?.message ?? '';
  const healthErrorMessage = healthQuery.error?.message ?? '';

  return (
    <div className="mx-auto flex max-w-[840px] flex-col gap-6 p-6">
      <PageHeader title="Settings" />
      <CredentialsCard
        settings={settingsQuery.data}
        loading={settingsQuery.data === undefined && settingsQuery.status !== 'error'}
        error={settingsQuery.status === 'error' ? settingsErrorMessage : undefined}
        refetch={() => {
          void settingsQuery.refetch();
        }}
        pending={pending}
        fieldErrors={errors}
        onSave={(key, value) => {
          void save(key, value);
        }}
        onRemove={(key) => {
          void remove(key);
        }}
        onClearError={clearError}
      />
      <EnvironmentCard
        summary={healthQuery.data}
        loading={healthQuery.data === undefined && healthQuery.status !== 'error'}
        error={healthQuery.status === 'error' ? healthErrorMessage : undefined}
        refetch={() => {
          void healthQuery.refetch();
        }}
      />
    </div>
  );
}
