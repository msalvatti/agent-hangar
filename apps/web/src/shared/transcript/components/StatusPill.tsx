/**
 * Turn-lifecycle status pill shown in the chat header.
 *
 * Layer: shared (component).
 */
'use client';

import { Ban, CircleCheck, CircleDot, CircleX, Clock, Loader } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '@/shared/lib/cn';

import { useElapsed } from '../hooks/useElapsed';
import type { TurnPhase } from '../types';

/** Delay before a "Done" pill starts fading. */
const DONE_FADE_DELAY_MS = 5000;

type VisiblePhase = Exclude<TurnPhase, 'idle'>;

/** Props of {@link StatusPill}. */
export interface StatusPillProps {
  phase: TurnPhase;
  startedAt: number | null;
  /** Accepted for API symmetry with the turn model; not currently rendered. */
  finishedAt?: number | null;
  /** Present only for the `failed` phase: the pill becomes a button (spec: "click → error"). */
  onClick?: () => void;
  className?: string;
}

const ICON_BY_PHASE: Record<VisiblePhase, LucideIcon> = {
  queued: Clock,
  preparing: Loader,
  running: CircleDot,
  succeeded: CircleCheck,
  failed: CircleX,
  cancelled: Ban,
};

const LABEL_BY_PHASE: Record<VisiblePhase, string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const TONE_CLASS_BY_PHASE: Record<VisiblePhase, string> = {
  queued: 'text-muted-foreground',
  preparing: 'text-warning',
  running: 'text-accent',
  succeeded: 'text-success',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
};

interface FadeState {
  phase: TurnPhase;
  faded: boolean;
}

/**
 * Renders the current turn phase as an icon + text pill (colour is never the only signal).
 * `idle` renders nothing; `succeeded` fades to transparent after {@link DONE_FADE_DELAY_MS} while
 * staying in the DOM (assistive tech still gets the final "Done" announcement).
 */
export function StatusPill({ phase, startedAt, onClick, className }: StatusPillProps) {
  const elapsed = useElapsed(startedAt, phase === 'running');
  const [fade, setFade] = useState<FadeState>({ phase, faded: false });

  // Resets the fade whenever the phase itself changes (render-time, not an effect: React's
  // documented pattern for state that must track a prop without an extra commit).
  if (fade.phase !== phase) {
    setFade({ phase, faded: false });
  }

  useEffect(() => {
    if (phase !== 'succeeded') {
      return;
    }
    // The cleanup below always cancels this before it could fire with a stale phase (any phase
    // change re-runs the effect, clearing the pending timeout first), so the callback can set
    // `faded` unconditionally rather than re-checking the phase it already closed over.
    const timeout = setTimeout(() => {
      setFade((previous) => ({ ...previous, faded: true }));
    }, DONE_FADE_DELAY_MS);
    return () => {
      clearTimeout(timeout);
    };
  }, [phase]);

  if (phase === 'idle') {
    return null;
  }

  const Icon = ICON_BY_PHASE[phase];
  const isPulsingDot = phase === 'running';
  const isSpinning = phase === 'preparing';
  const text = phase === 'running' ? `${LABEL_BY_PHASE[phase]} ${elapsed}` : LABEL_BY_PHASE[phase];

  const content = (
    <>
      <Icon
        aria-hidden="true"
        className={cn(
          'size-3.5',
          isSpinning && 'animate-spin motion-reduce:animate-none',
          isPulsingDot && 'animate-pulse motion-reduce:animate-none',
        )}
      />
      <span aria-live="polite" className="tabular-nums">
        {text}
      </span>
    </>
  );

  const sharedClassName = cn(
    'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-[color,opacity] duration-150 motion-reduce:transition-none',
    TONE_CLASS_BY_PHASE[phase],
    phase === 'succeeded' &&
      cn(
        'transition-opacity duration-500 motion-reduce:transition-none',
        fade.faded && 'opacity-0',
      ),
    className,
  );

  if (phase === 'failed' && onClick !== undefined) {
    return (
      <button type="button" onClick={onClick} className={cn(sharedClassName, 'cursor-pointer')}>
        {content}
      </button>
    );
  }

  return <div className={sharedClassName}>{content}</div>;
}
