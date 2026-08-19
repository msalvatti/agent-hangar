/**
 * Environment card: read-only instance/health summary, with loading/error states.
 *
 * Layer: component.
 */
'use client';

import { ErrorCard } from '@/shared/feedback';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';

import type { HealthSummary } from '../lib/health';

import { EnvSummary } from './EnvSummary';

/** Props of {@link EnvironmentCard}. */
export interface EnvironmentCardProps {
  summary: HealthSummary | undefined;
  loading: boolean;
  error: string | undefined;
  refetch: () => void;
}

/**
 * Environment card: instance/health summary from `/api/health`, or its loading/error state.
 *
 * @param props - The mapped health summary (or loading/error) and a retry callback.
 */
export function EnvironmentCard({ summary, loading, error, refetch }: EnvironmentCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Environment</CardTitle>
        <CardDescription>
          Read-only summary of this instance. Run <code>pnpm doctor</code> for details.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error !== undefined ? (
          <ErrorCard
            variant="compact"
            title="Could not load environment"
            message={error}
            actions={<Button onClick={refetch}>Retry</Button>}
          />
        ) : loading || summary === undefined ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <EnvSummary summary={summary} />
        )}
      </CardContent>
    </Card>
  );
}
