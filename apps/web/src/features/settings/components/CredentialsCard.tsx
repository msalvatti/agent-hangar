/**
 * Credentials card: one `SecretField` per secret, the active model, and an error/retry state.
 *
 * Layer: component.
 */
'use client';

import type { SecretKey, SettingsStatus } from '@agent-hangar/core';

import { ErrorCard } from '@/shared/feedback';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { Separator } from '@/shared/ui/separator';

import type { SecretMutationState } from '../hooks/useSecretMutations';
import { SECRET_FIELDS } from '../lib/secrets';

import { ModelLine } from './ModelLine';
import { SecretField } from './SecretField';

/** Props of {@link CredentialsCard}. */
export interface CredentialsCardProps {
  settings: SettingsStatus | undefined;
  loading: boolean;
  error: string | undefined;
  refetch: () => void;
  pending: Partial<Record<SecretKey, SecretMutationState>>;
  fieldErrors: Partial<Record<SecretKey, string>>;
  onSave: (key: SecretKey, value: string) => void;
  onRemove: (key: SecretKey) => void;
  onClearError: (key: SecretKey) => void;
}

/**
 * Credentials card: masked secret fields with replace/remove, the active model, and an
 * error/retry state when the settings query fails.
 *
 * @param props - The settings status (or loading/error) and the mutation callbacks/state.
 */
export function CredentialsCard({
  settings,
  loading,
  error,
  refetch,
  pending,
  fieldErrors,
  onSave,
  onRemove,
  onClearError,
}: CredentialsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Credentials</CardTitle>
        <CardDescription>
          Stored encrypted on this machine. Injected into workspaces at start.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error !== undefined ? (
          <ErrorCard
            variant="compact"
            title="Could not load credentials"
            message={error}
            actions={<Button onClick={refetch}>Retry</Button>}
          />
        ) : (
          <>
            {SECRET_FIELDS.map((field, index) => (
              <div key={field.key} className="flex flex-col gap-4">
                {index > 0 && <Separator />}
                <SecretField
                  field={field}
                  status={settings?.[field.statusKey]}
                  loading={loading}
                  pending={pending[field.key]}
                  error={fieldErrors[field.key]}
                  onSave={(value) => {
                    onSave(field.key, value);
                  }}
                  onRemove={() => {
                    onRemove(field.key);
                  }}
                  onClearError={() => {
                    onClearError(field.key);
                  }}
                />
              </div>
            ))}
            <Separator />
            {!loading && settings !== undefined && <ModelLine model={settings.model} />}
            <p className="text-muted-foreground text-xs">
              Values never leave this machine except to GitHub and OpenAI.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
