/**
 * Details behind the sidebar's environment pill.
 *
 * Layer: feature (component).
 */
'use client';

import type { ApiResponse } from '@agent-hangar/core';
import { CircleCheck, CircleX } from 'lucide-react';

import { HEALTH_CHECK_FIX, HEALTH_CHECK_LABELS, HEALTH_CHECK_NAMES } from '@/shared/health';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/ui/dialog';

/** Props of {@link HealthDialog}. */
export interface HealthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The latest health report, or `undefined` while none has arrived. */
  health: ApiResponse<'getHealth'> | undefined;
  onRetry: () => void;
}

/**
 * Lists every probe with its outcome and offers a manual re-check.
 *
 * @param props - Open state, the report and the retry handler.
 */
export function HealthDialog({ open, onOpenChange, health, onRetry }: HealthDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Environment</DialogTitle>
        </DialogHeader>
        {health === undefined ? (
          <p className="text-muted-foreground text-sm">Checking the environment…</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {HEALTH_CHECK_NAMES.map((name) => {
              const check = health.checks[name];
              return (
                <li key={name} className="flex flex-col gap-1 text-sm">
                  <div className="flex items-center gap-2">
                    {check.ok ? (
                      <CircleCheck aria-hidden="true" className="text-success size-4 shrink-0" />
                    ) : (
                      <CircleX aria-hidden="true" className="text-destructive size-4 shrink-0" />
                    )}
                    <span className="flex-1">{HEALTH_CHECK_LABELS[name]}</span>
                    <span className="text-muted-foreground">{check.ok ? 'ok' : 'failing'}</span>
                  </div>
                  {!check.ok && (
                    <p className="text-muted-foreground pl-6 font-mono text-xs">
                      {HEALTH_CHECK_FIX[name]}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {health !== undefined && (
          <p className="text-muted-foreground font-mono text-xs">instance {health.instance}</p>
        )}
        <p className="text-muted-foreground font-mono text-xs">
          Run `pnpm infra:doctor` for details.
        </p>
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={onRetry}>
          Retry
        </Button>
      </DialogContent>
    </Dialog>
  );
}
