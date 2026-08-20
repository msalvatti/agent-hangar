/**
 * Environment card's content: instance name and a labelled list of health checks.
 *
 * Layer: component.
 */
import { CircleCheck, CircleX } from 'lucide-react';

import type { HealthSummary } from '../lib/health';

/** Props of {@link EnvSummary}. */
export interface EnvSummaryProps {
  summary: HealthSummary;
}

/**
 * Renders the instance name and one row per health check (icon, label, detail).
 *
 * @param props - The mapped health summary.
 */
export function EnvSummary({ summary }: EnvSummaryProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-[13px]">Instance {summary.instance}</p>
      <ul role="list" className="flex flex-col gap-2">
        {summary.checks.map((check) => (
          <li key={check.id} className="flex items-center gap-2 text-sm">
            {check.ok ? (
              <CircleCheck className="text-success size-4 shrink-0" aria-hidden="true" />
            ) : (
              <CircleX className="text-destructive size-4 shrink-0" aria-hidden="true" />
            )}
            <span className={check.ok ? undefined : 'text-destructive'}>{check.label}</span>
            {check.detail !== undefined && (
              <span className="text-muted-foreground text-xs">{check.detail}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
