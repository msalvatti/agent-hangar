/**
 * Sidebar footer pill reporting whether the local environment is healthy.
 *
 * Layer: feature (component).
 */
'use client';

import { Container } from 'lucide-react';
import { useState } from 'react';

import { useHealth } from '@/shared/health';
import { cn } from '@/shared/lib/cn';

import { HealthDialog } from './HealthDialog';

/** Props of {@link EnvPill}. */
export interface EnvPillProps {
  /** Hides the text for the 56 px icon rail; the accessible name still carries it. */
  iconOnly?: boolean;
}

/**
 * Shows `docker ✓` or `docker ✗` from `GET /api/health` and opens the details dialog on click.
 *
 * The state is carried by text as well as colour, as spec 10 §8 requires.
 *
 * @param props - Icon-only flag.
 */
export function EnvPill({ iconOnly = false }: EnvPillProps) {
  const { data, ok, failing, refetch } = useHealth();
  const [open, setOpen] = useState(false);

  const label = data === undefined ? 'checking…' : ok ? 'docker ✓' : 'docker ✗';
  const summary =
    data === undefined ? 'checking' : ok ? 'everything healthy' : `${failing.join(', ')} failing`;

  return (
    <>
      <button
        type="button"
        aria-label={`Environment status: ${summary}`}
        title={`Environment status: ${summary}`}
        onClick={() => {
          setOpen(true);
        }}
        className={cn(
          'focus-visible:ring-ring flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none',
          data === undefined && 'text-muted-foreground',
          data !== undefined && ok && 'text-success hover:bg-muted',
          data !== undefined && !ok && 'text-destructive bg-destructive/10',
        )}
      >
        <Container aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
        {iconOnly ? <span className="sr-only">{label}</span> : <span>{label}</span>}
      </button>
      <HealthDialog
        open={open}
        onOpenChange={setOpen}
        health={data}
        onRetry={() => {
          void refetch();
        }}
      />
    </>
  );
}
