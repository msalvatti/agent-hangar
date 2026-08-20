/**
 * Confirmation dialog for stopping an active run.
 *
 * Layer: component.
 */
'use client';

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

/** Props of {@link StopRunDialog}. */
export interface StopRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/**
 * Confirms stopping an active run.
 *
 * @param props - Open state and confirm handler.
 */
export function StopRunDialog({ open, onOpenChange, onConfirm }: StopRunDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop this run?</AlertDialogTitle>
          <AlertDialogDescription>
            The workspace will be torn down and the run marked cancelled.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep running</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Stop
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
