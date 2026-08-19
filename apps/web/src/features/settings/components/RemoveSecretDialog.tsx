/**
 * Confirmation dialog for removing a saved secret.
 *
 * Layer: component.
 */
'use client';

import { Loader2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog';

import type { SecretFieldConfig } from '../lib/secrets';

/** Props of {@link RemoveSecretDialog}. */
export interface RemoveSecretDialogProps {
  field: SecretFieldConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
}

/**
 * Confirms removal of a secret: workspaces start without it until a new one is added.
 *
 * @param props - The field, open state and confirm handler.
 */
export function RemoveSecretDialog({
  field,
  open,
  onOpenChange,
  onConfirm,
  busy,
}: RemoveSecretDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {field.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            Workspaces will start without it until you add a new one.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
