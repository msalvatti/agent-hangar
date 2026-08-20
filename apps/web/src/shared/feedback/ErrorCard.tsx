/**
 * Inline error presentation: title, redacted message, optional code and actions.
 *
 * Layer: shared (component).
 */
import { REDACTED_TOKEN, SECRET_SHAPE_PATTERNS } from '@agent-hangar/core';
import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';
import { Card, CardContent } from '@/shared/ui/card';

/**
 * Masks secret-shaped substrings before display. A private copy of
 * `shared/transcript/lib/redact-display.ts`'s `maskSecretShapes`: `shared/feedback` may depend
 * only on `@/shared/ui`, `@/shared/lib/cn`, Lucide, React and `@agent-hangar/core` (it is imported
 * by `shared/transcript`'s own `Transcript` component for the `error` item kind, so importing the
 * transcript barrel back would be circular).
 *
 * @param text - Text that may contain a secret-shaped substring.
 * @returns `text` with every match replaced by `[REDACTED]`.
 */
function maskSecretShapes(text: string): string {
  return SECRET_SHAPE_PATTERNS.reduce((masked, pattern) => {
    let result = masked;
    while (pattern.test(result)) {
      result = result.replace(pattern, REDACTED_TOKEN);
    }
    return result;
  }, text);
}

/** Props of {@link ErrorCard}. */
export interface ErrorCardProps {
  title: string;
  /** Passed through {@link maskSecretShapes} before rendering. */
  message: string;
  /** Machine-readable error code, shown as a small mono badge; masked like the message. */
  code?: string;
  /** Retry / navigation buttons, supplied by the caller. */
  actions?: ReactNode;
  /** `block` (default) for a standalone error surface; `compact` for an inline transcript row. */
  variant?: 'block' | 'compact';
  className?: string;
}

/** A `role="alert"` card for a recoverable failure, with a next action. */
export function ErrorCard({
  title,
  message,
  code,
  actions,
  variant = 'block',
  className,
}: ErrorCardProps) {
  const compact = variant === 'compact';
  return (
    <Card
      role="alert"
      className={cn(
        'border-destructive/40 border',
        compact ? 'gap-2 px-4 py-3' : 'gap-3',
        className,
      )}
    >
      <CardContent className={cn('flex items-start gap-3', compact && 'px-0')}>
        <CircleAlert aria-hidden="true" className="text-destructive mt-0.5 size-4 shrink-0" />
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold">{title}</span>
            {code !== undefined && (
              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[11px]">
                {maskSecretShapes(code)}
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-[13px]">{maskSecretShapes(message)}</p>
          {actions !== undefined && <div className="flex gap-2 pt-1">{actions}</div>}
        </div>
      </CardContent>
    </Card>
  );
}
