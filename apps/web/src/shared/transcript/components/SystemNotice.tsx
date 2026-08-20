/**
 * Centred, iconed, non-bubble line for workspace/turn lifecycle notices.
 *
 * Layer: shared (component).
 */
import { CircleCheck, Info, TriangleAlert } from 'lucide-react';

import { cn } from '@/shared/lib/cn';

import { formatDuration } from '../lib/format';
import { maskSecretShapes } from '../lib/redact-display';
import type { NoticeTone } from '../types';

/** Props of {@link SystemNotice}. */
export interface SystemNoticeProps {
  tone: NoticeTone;
  text: string;
  /** Duration to show at the right, when known (e.g. "Prepared… 2.1 s"). */
  durationMs?: number;
  className?: string;
}

const TONE_ICON = { info: Info, warning: TriangleAlert, success: CircleCheck } as const;

const TONE_TEXT_CLASS: Record<NoticeTone, string> = {
  info: 'text-muted-foreground',
  warning: 'text-warning',
  success: 'text-muted-foreground',
};

/**
 * A single centred line: icon, text, optional duration (spec 10 §4.2). `text` is masked for
 * secret shapes before rendering: it can carry a raw `prepare.progress` message from the
 * workspace agent, so this is defence in depth alongside the worker's own redaction.
 */
export function SystemNotice({ tone, text, durationMs, className }: SystemNoticeProps) {
  const Icon = TONE_ICON[tone];
  return (
    <div
      role="status"
      data-item-kind="notice"
      className={cn(
        'flex items-center justify-center gap-2 text-[13px]',
        TONE_TEXT_CLASS[tone],
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      <span>{maskSecretShapes(text)}</span>
      {durationMs !== undefined && (
        <span className="text-muted-foreground tabular-nums">{formatDuration(durationMs)}</span>
      )}
    </div>
  );
}
