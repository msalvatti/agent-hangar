/**
 * Inline presentation of a failed turn, with the action that fits the failure.
 *
 * Layer: feature (component).
 */
'use client';

import Link from 'next/link';

import { ErrorCard } from '@/shared/feedback';
import { Button } from '@/shared/ui/button';

import { describeTurnError, README_IMAGE_HREF } from '../lib/turn-error';
import type { TurnErrorAction } from '../lib/turn-error';

/** Props of {@link TurnErrorCard}. */
export interface TurnErrorCardProps {
  error: { code: string; message: string };
  onRetry: () => void;
}

/**
 * Renders the secondary action a failure calls for: none for a plain retry, a link to Settings
 * for a credential problem, a link to the setup guide when the workspace image is missing.
 *
 * @param action - The action `describeTurnError` chose.
 * @returns The link element, or `null`.
 */
function secondaryAction(action: TurnErrorAction) {
  if (action === 'settings') {
    return (
      <Button render={<Link href="/settings" />} variant="outline" size="sm">
        Open Settings
      </Button>
    );
  }
  if (action === 'readme') {
    return (
      <Button render={<Link href={README_IMAGE_HREF} />} variant="outline" size="sm">
        Read setup guide
      </Button>
    );
  }
  return null;
}

/**
 * An `ErrorCard` describing why the turn failed, with Retry and any code-specific next step.
 *
 * @param props - The failure and the retry handler.
 */
export function TurnErrorCard({ error, onRetry }: TurnErrorCardProps) {
  const described = describeTurnError(error);
  return (
    <ErrorCard
      title={described.title}
      message={described.message}
      code={error.code}
      className="mx-6"
      actions={
        <>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
          {secondaryAction(described.action)}
        </>
      }
    />
  );
}
