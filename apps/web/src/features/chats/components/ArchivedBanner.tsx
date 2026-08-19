/**
 * Banner shown at the top of an archived chat.
 *
 * Layer: feature (component).
 */
'use client';

import { Archive, Loader2 } from 'lucide-react';

import { Button } from '@/shared/ui/button';
import { Card, CardContent } from '@/shared/ui/card';

/** Props of {@link ArchivedBanner}. */
export interface ArchivedBannerProps {
  onRestore: () => void;
  /** `true` while the restore request is in flight. */
  busy?: boolean;
}

/**
 * Explains why the chat is read-only and offers the one action that changes that.
 *
 * @param props - Restore handler and its busy flag.
 */
export function ArchivedBanner({ onRestore, busy = false }: ArchivedBannerProps) {
  return (
    <Card role="status" size="sm" className="bg-muted mx-6 mt-4">
      <CardContent className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <Archive aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
        <p className="flex-1 text-sm">
          This chat is archived. Restore it to continue in a fresh workspace.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onRestore}
          className="cursor-pointer"
        >
          {busy && <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />}
          Restore
        </Button>
      </CardContent>
    </Card>
  );
}
