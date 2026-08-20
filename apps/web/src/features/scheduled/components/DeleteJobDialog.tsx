/**
 * Confirmation dialog for deleting a scheduled job.
 *
 * Layer: component.
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';
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

/** Props of {@link DeleteJobDialog}. */
export interface DeleteJobDialogProps {
  job: JobSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
}

/**
 * Confirms deletion of a job: future runs stop and run history is deleted.
 *
 * @param props - The job, open state and confirm handler.
 */
export function DeleteJobDialog({
  job,
  open,
  onOpenChange,
  onConfirm,
  busy,
}: DeleteJobDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete job {job?.name}?</AlertDialogTitle>
          <AlertDialogDescription>Future runs stop; run history is deleted.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
