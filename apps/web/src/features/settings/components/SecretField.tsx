/**
 * One secret field of the credentials card: unset input, masked display, replace and remove.
 *
 * Layer: component.
 */
'use client';

import { Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';

import { relativeTime } from '@/shared/transcript';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Skeleton } from '@/shared/ui/skeleton';

import type { SecretMutationState } from '../hooks/useSecretMutations';
import type { SecretFieldConfig, SecretStatusView } from '../lib/secrets';
import { maskSecret, validateSecretInput } from '../lib/secrets';

import { RemoveSecretDialog } from './RemoveSecretDialog';

/** Props of {@link SecretField}. */
export interface SecretFieldProps {
  field: SecretFieldConfig;
  /** Masked status, or `undefined` while unknown (treated the same as unset). */
  status: SecretStatusView | undefined;
  loading: boolean;
  pending: SecretMutationState | undefined;
  error: string | undefined;
  onSave: (value: string) => void;
  onRemove: () => void;
  onClearError: () => void;
}

/**
 * One secret field: a masked display with Replace/Remove once set, or a password input with Save
 * once unset (or while replacing).
 *
 * @param props - The field's static config, current status/pending/error, and the action
 *   callbacks.
 */
export function SecretField({
  field,
  status,
  loading,
  pending,
  error,
  onSave,
  onRemove,
  onClearError,
}: SecretFieldProps) {
  // Relative labels are anchored to a single instant captured when the field mounts: reading the
  // clock during render would make the output depend on when React happened to re-render.
  const [now] = useState(() => Date.now());
  const titleId = useId();
  const helperId = useId();
  const errorId = useId();
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  const currentStatus = status ?? { set: false };
  const saving = pending === 'saving';
  const removing = pending === 'removing';

  // Adjusted during render (React's documented pattern for resetting state when a prop changes)
  // rather than in an effect, which would need an extra render/commit round-trip to take effect.
  // After a successful save, `status.updatedAt` changes: clear the input and leave replace mode.
  // Keyed on `updatedAt` rather than `last4` — a replacement secret can coincidentally share its
  // last 4 characters with the one it replaces, but `updatedAt` is a fresh timestamp every time.
  const [syncedUpdatedAt, setSyncedUpdatedAt] = useState(currentStatus.updatedAt);
  if (currentStatus.updatedAt !== syncedUpdatedAt) {
    setSyncedUpdatedAt(currentStatus.updatedAt);
    setValue('');
    setReplacing(false);
  }

  const submit = () => {
    if (validateSecretInput(value) !== null) {
      return;
    }
    onSave(value.trim());
  };

  const describedBy = error === undefined ? helperId : `${helperId} ${errorId}`;

  return (
    <div data-testid={`secret-field-${field.key}`} className="flex flex-col gap-1.5">
      <span id={titleId} className="text-sm font-medium">
        {field.label}
      </span>
      {loading ? (
        <Skeleton className="h-8 w-full" />
      ) : currentStatus.set && !replacing ? (
        <div className="flex flex-wrap items-center gap-3">
          <span
            data-testid={`secret-mask-${field.key}`}
            aria-label={`${field.label} ending in ${currentStatus.last4 ?? ''}`}
            className="font-mono text-[13px]"
          >
            {maskSecret(currentStatus.last4)}
          </span>
          <span className="text-muted-foreground text-xs">
            {currentStatus.updatedAt === undefined
              ? 'set'
              : `updated ${relativeTime(currentStatus.updatedAt, now)}`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setReplacing(true);
            }}
          >
            <RefreshCw aria-hidden="true" />
            Replace
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => {
              setRemoveOpen(true);
            }}
          >
            <Trash2 aria-hidden="true" />
            Remove
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="password"
            // Only when Replace put this input on screen. Pressing Replace is a request to type a
            // new value, and leaving the focus on a button that is no longer there makes the
            // keyboard path continue from nowhere. On first load the field is simply unset, nobody
            // asked for it, and stealing the focus would move it away from the top of the page.
            autoFocus={replacing}
            autoComplete="off"
            spellCheck={false}
            placeholder={field.placeholder}
            value={value}
            disabled={saving}
            aria-labelledby={titleId}
            aria-describedby={describedBy}
            aria-invalid={error !== undefined}
            onChange={(event) => {
              setValue(event.target.value);
              if (error !== undefined) {
                onClearError();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
          <Button onClick={submit} disabled={saving || validateSecretInput(value) !== null}>
            {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            Save
          </Button>
          {replacing && (
            <Button
              variant="ghost"
              onClick={() => {
                setReplacing(false);
                setValue('');
                onClearError();
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      )}
      {error !== undefined && (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <p id={helperId} className="text-muted-foreground text-xs">
        {field.helper}
      </p>
      <RemoveSecretDialog
        field={field}
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        onConfirm={() => {
          setRemoveOpen(false);
          onRemove();
        }}
        busy={removing}
      />
    </div>
  );
}
